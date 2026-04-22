import { CbEvents, getSDK, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
import { processInboundMessage } from "./inbound";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError } from "./utils";

const clients = new Map<string, OpenIMClientState>();

/** Serialize sdk.login() on singleton SDK; parallel logins race and break sessions. */
let loginGate = Promise.resolve();

async function withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = loginGate.then(fn, fn);
  loginGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function detachHandlers(state: OpenIMClientState): void {
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

/**
 * @param opts.abortSignal 若提供（OpenClaw gateway.startAccount），在 signal abort 前保持 Promise 挂起，
 *   以便侧车任务表示为 running；abort 后登出本账号。
 */
export async function startAccountClient(
  api: any,
  config: OpenIMAccountConfig,
  opts?: { abortSignal?: AbortSignal },
): Promise<void> {
  const sdk = getSDK();

  for (const s of clients.values()) {
    detachHandlers(s);
  }

  const state = {
    sdk,
    config,
    handlers: {
      onRecvNewMessage: () => undefined,
      onRecvNewMessages: () => undefined,
      onRecvOfflineNewMessages: () => undefined,
    },
  } as OpenIMClientState;

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

  sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);

  try {
    await withLoginLock(async () => {
      await sdk.login({
        userID: config.userID,
        token: config.token,
        wsAddr: config.wsAddr,
        apiAddr: config.apiAddr,
        platformID: config.platformID,
      });
    });
    clients.set(config.accountId, state);
    api.logger?.info?.(`[infiai] account ${config.accountId} connected`);
  } catch (e: any) {
    detachHandlers(state);
    api.logger?.error?.(`[infiai] account ${config.accountId} login failed: ${formatSdkError(e)}`);
    return;
  }

  if (opts?.abortSignal) {
    try {
      await new Promise<void>((resolve) => {
        const sig = opts.abortSignal!;
        if (sig.aborted) {
          resolve();
          return;
        }
        sig.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
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
