import {
  CbEvents,
  getSDK,
  LogLevel,
  type ApiService,
  type CallbackEvent,
  type MessageItem,
} from "@openim/client-sdk";
import loglevel from "loglevel";
import { processInboundMessage } from "./inbound";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError, infiaiDebug, resolveOpenIMSdkLogLevel } from "./utils";

const clients = new Map<string, OpenIMClientState>();

/** Serialize login initialization because the browser SDK still touches shared globals during startup. */
let loginGate = Promise.resolve();
let sdkLoggingConfigured = false;
let openIMConsoleFilterInstalled = false;

function isNoisyOpenIMConsoleLine(args: unknown[]): boolean {
  const first = args[0] as any;
  if (typeof first === "string") {
    return first.includes("OpenIMSDK") || first.includes("SDK =>");
  }
  if (
    first &&
    typeof first === "object" &&
    ("unreadCount" in first || Object.keys(first).length === 1) &&
    Array.isArray(first.conversations)
  ) {
    return true;
  }
  return false;
}

function installOpenIMConsoleFilter(): void {
  if (openIMConsoleFilterInstalled || resolveOpenIMSdkLogLevel() !== "silent") return;
  openIMConsoleFilterInstalled = true;
  const wrap = <T extends (...args: any[]) => void>(fn: T): T =>
    ((...args: unknown[]) => {
      if (isNoisyOpenIMConsoleLine(args)) return;
      fn(...args);
    }) as T;
  console.log = wrap(console.log.bind(console));
  console.info = wrap(console.info.bind(console));
  console.debug = wrap(console.debug.bind(console));
  console.warn = wrap(console.warn.bind(console));
}

function configureOpenIMSdkLogging(): void {
  if (sdkLoggingConfigured) return;
  sdkLoggingConfigured = true;
  installOpenIMConsoleFilter();
  try {
    loglevel.setLevel(resolveOpenIMSdkLogLevel(), false);
  } catch {
    // Keep startup resilient if SDK logging internals change.
  }
}

function getConfiguredSDK(): ReturnType<typeof getSDK> {
  configureOpenIMSdkLogging();
  if (resolveOpenIMSdkLogLevel() !== "silent") return getSDK();

  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (first.includes("OpenIMSDK")) return;
    originalInfo(...args);
  };
  try {
    return getSDK();
  } finally {
    console.info = originalInfo;
  }
}

function openIMSdkLogLevelValue(): number {
  switch (resolveOpenIMSdkLogLevel()) {
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warn":
      return LogLevel.Warn;
    case "error":
      return LogLevel.Error;
    default:
      return LogLevel.Silent;
  }
}

async function withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = loginGate.then(fn, fn);
  loginGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function detachHandlers(state: OpenIMClientState): void {
  state.sdk.off(CbEvents.OnConnecting, state.handlers.onConnecting);
  state.sdk.off(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
  state.sdk.off(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  state.sdk.off(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  state.sdk.off(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  state.sdk.off(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  state.sdk.off(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  state.sdk.off(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  state.sdk.off(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
}

export function getConnectedClient(accountId?: string): OpenIMClientState | null {
  if (accountId && clients.has(accountId)) {
    return clients.get(accountId) ?? null;
  }
  if (clients.has("default")) return clients.get("default") ?? null;

  const first = clients.values().next();
  return first.done ? null : first.value;
}

export function connectedClientCount(): number {
  return clients.size;
}

export async function stopAccountClient(api: any, accountId: string): Promise<void> {
  const state = clients.get(accountId);
  if (!state) return;
  clients.delete(accountId);
  detachHandlers(state);
  try {
    await state.sdk.logout();
  } catch (e: any) {
    api.logger?.warn?.(`[infiai] account ${accountId} logout failed: ${formatSdkError(e)}`);
  }
}

const OPENIM_AUTH_ERROR_CODES = new Set([1501, 1502, 1503, 1504, 1505, 1506, 1507]);

function sdkErrorCode(error: unknown): number | null {
  const raw = (error as any)?.errCode ?? (error as any)?.code;
  const code = Number(raw);
  return Number.isFinite(code) && code > 0 ? code : null;
}

function safeSdkErrorSummary(error: unknown): string {
  const err = error as any;
  const code = sdkErrorCode(error);
  const message = String(err?.errMsg ?? err?.message ?? err?.event ?? "OpenIM connection failed")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 300);
  return `${code ? `code=${code} ` : ""}${message}`.trim();
}

function connectionError(accountId: string, error: unknown, forceAuthInvalid = false): Error {
  const code = sdkErrorCode(error);
  const authInvalid = forceAuthInvalid || (code !== null && OPENIM_AUTH_ERROR_CODES.has(code));
  const category = authInvalid ? "INFIAI_AUTH_INVALID" : "INFIAI_CONNECTION_FAILED";
  return new Error(`${category} account=${accountId} ${safeSdkErrorSummary(error)}`.trim());
}

type AccountStatusPatch = {
  connected?: boolean;
  healthState?: string;
  lastConnectedAt?: number;
  lastError?: string | null;
  terminalDisconnect?: boolean;
};

function setAccountStatus(
  setStatus: ((patch: AccountStatusPatch) => unknown) | undefined,
  patch: AccountStatusPatch,
): void {
  try {
    setStatus?.(patch);
  } catch {
    // Status reporting must not break the OpenIM connection lifecycle.
  }
}

/**
 * @param opts.abortSignal 若提供（OpenClaw gateway.startAccount），在 signal abort 前保持 Promise 挂起，
 *   以便侧车任务表示为 running；abort 后登出本账号。
 */
export async function startAccountClient(
  api: any,
  config: OpenIMAccountConfig,
  opts?: {
    abortSignal?: AbortSignal;
    gatewayConfig?: any;
    setStatus?: (patch: AccountStatusPatch) => unknown;
    sdk?: ApiService;
  },
): Promise<void> {
  const sdk = opts?.sdk ?? getConfiguredSDK();
  let loginCompleted = false;
  let lifecycleReject: ((error: Error) => void) | null = null;
  let terminalError: Error | null = null;
  const lifecycleFailure = new Promise<never>((_, reject) => {
    lifecycleReject = reject;
  });
  void lifecycleFailure.catch(() => undefined);

  const failLifecycle = (error: Error, healthState: string) => {
    terminalError = error;
    setAccountStatus(opts?.setStatus, {
      connected: false,
      healthState,
      lastError: error.message,
      terminalDisconnect: healthState === "auth_invalid",
    });
    lifecycleReject?.(error);
  };

  const state = {
    sdk,
    config,
    gatewayConfig: opts?.gatewayConfig ?? api.config,
    handlers: {
      onConnecting: () => undefined,
      onConnectSuccess: () => undefined,
      onConnectFailed: () => undefined,
      onKickedOffline: () => undefined,
      onUserTokenExpired: () => undefined,
      onUserTokenInvalid: () => undefined,
      onRecvNewMessage: () => undefined,
      onRecvNewMessages: () => undefined,
      onRecvOfflineNewMessages: () => undefined,
    },
  } as OpenIMClientState;

  state.handlers.onConnecting = () => {
    setAccountStatus(opts?.setStatus, {
      connected: false,
      healthState: "connecting",
      terminalDisconnect: false,
    });
  };
  state.handlers.onConnectSuccess = () => {
    if (!loginCompleted) return;
    setAccountStatus(opts?.setStatus, {
      connected: true,
      healthState: "healthy",
      lastConnectedAt: Date.now(),
      lastError: null,
      terminalDisconnect: false,
    });
  };
  state.handlers.onConnectFailed = (event) => {
    failLifecycle(connectionError(config.accountId, event), "disconnected");
  };
  state.handlers.onKickedOffline = (event) => {
    failLifecycle(connectionError(config.accountId, { ...event, errCode: event?.errCode || 1506 }, true), "auth_invalid");
  };
  state.handlers.onUserTokenExpired = (event) => {
    failLifecycle(connectionError(config.accountId, { ...event, errCode: event?.errCode || 1501 }, true), "auth_invalid");
  };
  state.handlers.onUserTokenInvalid = (event) => {
    failLifecycle(connectionError(config.accountId, { ...event, errCode: event?.errCode || 1502 }, true), "auth_invalid");
  };

  const consumeMessage = (msg: MessageItem) => {
    processInboundMessage(api, state, msg).catch((e: any) => {
      api.logger?.error?.(`[infiai] processInboundMessage failed: ${formatSdkError(e)}`);
    });
  };

  state.handlers.onRecvNewMessage = (event: CallbackEvent<MessageItem>) => {
    if (event?.data) consumeMessage(event.data);
  };
  state.handlers.onRecvNewMessages = (event: CallbackEvent<MessageItem[]>) => {
    const list = Array.isArray(event?.data) ? event.data : [];
    for (const msg of list) consumeMessage(msg);
  };
  state.handlers.onRecvOfflineNewMessages = (event: CallbackEvent<MessageItem[]>) => {
    const list = Array.isArray(event?.data) ? event.data : [];
    for (const msg of list) consumeMessage(msg);
  };

  sdk.on(CbEvents.OnConnecting, state.handlers.onConnecting);
  sdk.on(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
  sdk.on(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  sdk.on(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  sdk.on(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  sdk.on(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);

  setAccountStatus(opts?.setStatus, {
    connected: false,
    healthState: "connecting",
    lastError: null,
    terminalDisconnect: false,
  });

  try {
    await withLoginLock(async () => {
      await Promise.race([
        sdk.login({
          userID: config.userID,
          token: config.token,
          wsAddr: config.wsAddr,
          apiAddr: config.apiAddr,
          platformID: config.platformID,
          logLevel: openIMSdkLogLevelValue(),
        }),
        lifecycleFailure,
      ]);
    });
    if (terminalError) throw terminalError;
    loginCompleted = true;
    clients.set(config.accountId, state);
    setAccountStatus(opts?.setStatus, {
      connected: true,
      healthState: "healthy",
      lastConnectedAt: Date.now(),
      lastError: null,
      terminalDisconnect: false,
    });
    infiaiDebug(api, `[infiai] account ${config.accountId} connected`);
  } catch (e: any) {
    detachHandlers(state);
    const error = e instanceof Error && /^INFIAI_/.test(e.message)
      ? e
      : connectionError(config.accountId, e);
    setAccountStatus(opts?.setStatus, {
      connected: false,
      healthState: error.message.startsWith("INFIAI_AUTH_INVALID") ? "auth_invalid" : "disconnected",
      lastError: error.message,
      terminalDisconnect: error.message.startsWith("INFIAI_AUTH_INVALID"),
    });
    try {
      await sdk.logout();
    } catch {
      // A failed login can leave the SDK only partially initialized.
    }
    api.logger?.error?.(`[infiai] account ${config.accountId} login failed: ${formatSdkError(e)}`);
    throw error;
  }

  if (opts?.abortSignal) {
    try {
      const aborted = new Promise<void>((resolve) => {
        const signal = opts.abortSignal!;
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([aborted, lifecycleFailure]);
    } finally {
      lifecycleReject = null;
      await stopAccountClient(api, config.accountId);
    }
  }
}

export async function stopAllClients(api: any): Promise<void> {
  const ids = Array.from(clients.keys());
  for (const id of ids) {
    await stopAccountClient(api, id);
  }
}
