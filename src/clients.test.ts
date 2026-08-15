import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { CbEvents, type ApiService, type CallbackEvent } from "@openim/client-sdk";

import {
  connectedClientCount,
  startAccountClient,
  stopAccountClient,
  stopAllClients,
} from "./clients";
import type { OpenIMAccountConfig } from "./types";

class FakeSDK {
  handlers = new Map<CbEvents, Set<(event: CallbackEvent<any>) => void>>();
  loginError: unknown = null;
  loginWait: Promise<void> | null = null;
  loginCalls = 0;
  logoutCalls = 0;

  on(event: CbEvents, fn: (value: CallbackEvent<any>) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(fn);
    this.handlers.set(event, handlers);
  }

  off(event: CbEvents, fn: (value: CallbackEvent<any>) => void) {
    this.handlers.get(event)?.delete(fn);
  }

  async login() {
    this.loginCalls += 1;
    await this.loginWait;
    if (this.loginError) throw this.loginError;
    return { errCode: 0, errMsg: "", data: null, operationID: "login" };
  }

  async logout() {
    this.logoutCalls += 1;
    return { errCode: 0, errMsg: "", data: null, operationID: "logout" };
  }

  emit(event: CbEvents, errCode = 0, errMsg = "") {
    const payload = { event, data: null, errCode, errMsg, operationID: "event" };
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const api = {
  config: {},
  logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
};

function account(accountId: string): OpenIMAccountConfig {
  return {
    accountId,
    enabled: true,
    userID: accountId,
    token: "test-token",
    wsAddr: "ws://openim:10001",
    apiAddr: "http://openim:10002",
    platformID: 12,
    requireMention: false,
    inboundWhitelist: [],
  };
}

afterEach(async () => {
  await stopAllClients(api);
});

test("rejects an invalid OpenIM token instead of reporting a running account", async () => {
  const sdk = new FakeSDK();
  sdk.loginError = { errCode: 1507, errMsg: "TokenNotExistError" };
  const statuses: Array<Record<string, unknown>> = [];

  await assert.rejects(
    startAccountClient(api, account("acc-invalid"), {
      sdk: sdk as unknown as ApiService,
      setStatus: (patch) => statuses.push(patch),
    }),
    /INFIAI_AUTH_INVALID.*code=1507/,
  );

  assert.equal(connectedClientCount(), 0);
  assert.equal(sdk.logoutCalls, 1);
  assert.deepEqual(statuses.at(-1), {
    connected: false,
    healthState: "auth_invalid",
    lastError: "INFIAI_AUTH_INVALID account=acc-invalid code=1507 TokenNotExistError",
    terminalDisconnect: true,
  });
});

test("marks the account connected only after login and logs out its own SDK", async () => {
  const first = new FakeSDK();
  const second = new FakeSDK();
  const statuses: Array<Record<string, unknown>> = [];

  await startAccountClient(api, account("acc-first"), {
    sdk: first as unknown as ApiService,
    setStatus: (patch) => statuses.push(patch),
  });
  await startAccountClient(api, account("acc-second"), {
    sdk: second as unknown as ApiService,
  });

  assert.equal(connectedClientCount(), 2);
  assert.equal(statuses.at(-1)?.connected, true);
  assert.equal(statuses.at(-1)?.healthState, "healthy");

  await stopAccountClient(api, "acc-first");
  assert.equal(first.logoutCalls, 1);
  assert.equal(second.logoutCalls, 0);
  assert.equal(connectedClientCount(), 1);
});

test("propagates a post-login connection failure so OpenClaw can back off and restart", async () => {
  const sdk = new FakeSDK();
  const controller = new AbortController();
  const statuses: Array<Record<string, unknown>> = [];
  const running = startAccountClient(api, account("acc-reconnect"), {
    sdk: sdk as unknown as ApiService,
    abortSignal: controller.signal,
    setStatus: (patch) => statuses.push(patch),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1)?.connected, true);
  sdk.emit(CbEvents.OnConnectFailed, 10000, "network unavailable");

  await assert.rejects(running, /INFIAI_CONNECTION_FAILED.*code=10000/);
  assert.equal(sdk.logoutCalls, 1);
  assert.equal(connectedClientCount(), 0);
  assert.equal(statuses.at(-1)?.healthState, "disconnected");
});

test("does not hang when the SDK emits a connection failure while login is pending", async () => {
  const sdk = new FakeSDK();
  sdk.loginWait = new Promise(() => undefined);
  const running = startAccountClient(api, account("acc-login-pending"), {
    sdk: sdk as unknown as ApiService,
  });

  await new Promise((resolve) => setImmediate(resolve));
  sdk.emit(CbEvents.OnConnectFailed, 10000, "rpc unavailable during login");

  await assert.rejects(running, /INFIAI_CONNECTION_FAILED.*code=10000/);
  assert.equal(sdk.logoutCalls, 1);
  assert.equal(connectedClientCount(), 0);
});

test("aborting a healthy account ends the lifecycle without an error", async () => {
  const sdk = new FakeSDK();
  const controller = new AbortController();
  const running = startAccountClient(api, account("acc-abort"), {
    sdk: sdk as unknown as ApiService,
    abortSignal: controller.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await running;

  assert.equal(sdk.logoutCalls, 1);
  assert.equal(connectedClientCount(), 0);
});
