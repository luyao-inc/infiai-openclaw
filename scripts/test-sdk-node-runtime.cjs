// Run inside the candidate runtime. Uses loopback only, never production tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require(process.env.INFIAI_TEST_WS_MODULE || '/usr/local/lib/node_modules/openclaw/node_modules/ws');
const { getSDK, CbEvents, LogLevel } = require('@openim/client-sdk');

test('121 native Node WebSocket accounts survive a bad frame on one account', { timeout: 15000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const sockets = [];
  server.on('connection', socket => { sockets.push(socket); socket.send('{"errCode":0}'); });
  const accounts = [];
  let faults = 0;
  try {
    for (let i = 0; i < 121; i++) {
      const sdk = getSDK();
      accounts.push(sdk);
      assert.equal(sdk.__infiaiSafety.version, 1);
      sdk.__infiaiSafety.observe(() => { faults++; });
      for (const key of ['messageTrigger', 'relationTrigger', 'groupTrigger', 'userTrigger']) sdk[key].sync = async () => {};
      const connected = new Promise(resolve => sdk.on(CbEvents.OnConnectSuccess, resolve));
      await sdk.login({ userID: `test-${i}`, token: 'synthetic-test', wsAddr: `ws://127.0.0.1:${server.address().port}`,
        apiAddr: 'http://127.0.0.1:1', platformID: 12, logLevel: LogLevel.Silent });
      await connected;
    }
    const disconnected = new Promise(resolve => accounts[0].on(CbEvents.OnConnectFailed, resolve));
    sockets[0].send('malformed-test-frame');
    await disconnected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(faults, 1);
    assert.equal(accounts[0].wsManager.isProcessingMessage, false);
    assert.equal(accounts.slice(1).filter(sdk => sdk.wsManager.ws.readyState === WebSocket.OPEN).length, 120);
    await accounts[0].logout();
    const reconnected = new Promise(resolve => accounts[0].on(CbEvents.OnConnectSuccess, resolve));
    await accounts[0].login({ userID: 'test-0', token: 'synthetic-test', wsAddr: `ws://127.0.0.1:${server.address().port}`,
      apiAddr: 'http://127.0.0.1:1', platformID: 12, logLevel: LogLevel.Silent });
    await reconnected;
    assert.equal(accounts.filter(sdk => sdk.wsManager.ws.readyState === WebSocket.OPEN).length, 121);
  } finally {
    await Promise.all(accounts.map(sdk => sdk.logout().catch(() => {})));
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
