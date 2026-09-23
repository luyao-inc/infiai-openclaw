import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getSDK, CbEvents, LogLevel } from '@openim/client-sdk';
import { safeRuntimeError } from './safeDiagnostics.ts';
const require = createRequire(import.meta.url);
const harden = require('../scripts/sdk-safety.cjs');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

class Socket extends EventTarget {
  static OPEN = 1; static CLOSED = 3;
  OPEN = 1; CLOSED = 3; readyState = 0;
  listeners = new Map<string, any>();
  constructor(_url: string) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  setEvent(type: string, fn: any) { const old = this.listeners.get(type); if (old) this.removeEventListener(type, old); this.listeners.set(type, fn); if (fn) this.addEventListener(type, fn); }
  set onopen(fn: any) { this.setEvent('open', fn); }
  set onmessage(fn: any) { this.setEvent('message', fn); }
  set onclose(fn: any) { this.setEvent('close', fn); }
  set onerror(fn: any) { this.setEvent('error', fn); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send() {}
}

test('real patched SDK isolates malformed native EventTarget frames to one account', async () => {
  const original = globalThis.WebSocket;
  (globalThis as any).WebSocket = Socket;
  const first = getSDK() as any, second = getSDK() as any;
  try {
    const faults: any[] = [];
    first.__infiaiSafety.observe((error: unknown, stage: string) => faults.push({ error, stage }));
    for (const sdk of [first, second]) {
      for (const key of ['messageTrigger', 'relationTrigger', 'groupTrigger', 'userTrigger']) sdk[key].sync = async () => {};
      await sdk.login({ userID: sdk === first ? 'one' : 'two', token: 'fake', wsAddr: 'ws://invalid.local', apiAddr: 'http://invalid.local', platformID: 12, logLevel: LogLevel.Silent });
      sdk.wsManager.ws.dispatchEvent(new MessageEvent('message', { data: '{"errCode":0}' }));
    }
    await tick();
    const manager = first.wsManager;
    let failed = 0;
    first.on(CbEvents.OnConnectFailed, () => failed++);
    manager.ws.dispatchEvent(new MessageEvent('message', { data: 'invalid-json-secret' }));
    await tick(); await tick();
    assert.equal(faults.length, 1);
    assert.ok(failed >= 1);
    assert.equal(manager.isProcessingMessage, false);
    assert.equal(manager.ws.readyState, 3);
    assert.equal(second.wsManager.ws.readyState, 1);
    await assert.rejects(manager.connect(), /stopped/);
    await first.logout();
    await first.login({ userID: 'one', token: 'fake', wsAddr: 'ws://invalid.local', apiAddr: 'http://invalid.local', platformID: 12, logLevel: LogLevel.Silent });
    assert.equal(first.wsManager.ws.readyState, 1);
  } finally { await first.logout(); await second.logout(); (globalThis as any).WebSocket = original; }
});

test('detached notification rejection is contained and concurrent frames keep processing state', async () => {
  let closeCalls = 0;
  const faults: string[] = [];
  const raw: any = { triggerEvent() {}, login() {}, logout() {}, messageTrigger: { async triggerNotification() { throw new Error('payload'); } } };
  const sdk = harden(raw);
  sdk.__infiaiSafety.observe((_e: unknown, stage: string) => faults.push(stage));
  const pending: (() => void)[] = [];
  sdk.wsManager = { onBinaryMessage() { return new Promise<void>(resolve => pending.push(resolve)); }, connect() {}, close() { closeCalls++; }, ws: { readyState: 1 } };
  const manager = sdk.wsManager;
  const a = manager.onBinaryMessage('a'), b = manager.onBinaryMessage('b');
  await tick(); pending[0](); await a;
  assert.equal(manager.isProcessingMessage, true);
  pending[1](); await b;
  assert.equal(manager.isProcessingMessage, false);
  void sdk.messageTrigger.triggerNotification();
  await tick();
  assert.deepEqual(faults, ['message.triggerNotification']);
  assert.equal(closeCalls, 1);
});

test('diagnostics exclude payloads, tokens and URL query strings', () => {
  const e = new Error('token=secret-cookie user-message-private');
  e.stack = 'Error: private\n    at send (/app/client.js:10:2)\n    at https://api.test/?token=private:3:4';
  const result = safeRuntimeError(e);
  assert.deepEqual(result.frames, ['/app/client.js:10:2']);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|cookie|token=/);
});
