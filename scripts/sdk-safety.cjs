// Node host boundary for the unmodified OpenIM public API. See docs/sdk-safety.md.
module.exports = function hardenOpenIMSDK(sdk) {
  let failed = false;
  let stopped = false;
  let observer;
  let manager;
  let epoch = 0;
  sdk.__infiaiSafety = { version: 1, observe(fn) { observer = fn; } };

  function fail(error, stage, sourceEpoch = epoch) {
    if (failed || stopped || sourceEpoch !== epoch) return;
    failed = true;
    try { observer?.(error, stage); } catch { /* Observability cannot crash the host. */ }
    try { manager?.close(); } catch { /* Continue to the lifecycle failure event. */ }
    try {
      sdk.triggerEvent({ event: 'OnConnectFailed', errCode: 10000,
        errMsg: 'INFIAI_SDK_RUNTIME_ERROR', operationID: '' });
    } catch { /* No caller callback can escape the transport boundary. */ }
  }

  function guard(owner, key, stage) {
    const original = owner?.[key];
    if (typeof original !== 'function') return;
    owner[key] = function (...args) {
      if (failed || stopped) return;
      const sourceEpoch = epoch;
      try {
        const result = original.apply(this, args);
        return result && typeof result.then === 'function'
          ? Promise.resolve(result).catch(error => { fail(error, stage, sourceEpoch); })
          : result;
      } catch (error) { fail(error, stage, sourceEpoch); }
    };
  }

  // These methods are invoked without awaiting their promises in upstream 3.8.3
  // and hotfix.0. A catch only around the outer WS callback cannot protect them.
  for (const key of ['handleWsConnected', 'handleMessage', 'handleGeneralWsResp']) guard(sdk, key, key);
  for (const key of ['triggerConversation', 'triggerNotification', 'getOneConversationAndTryChange']) {
    guard(sdk.messageTrigger, key, `message.${key}`);
  }
  for (const key of ['syncAndTriggerMsgs', 'syncConversationVersion']) {
    guard(sdk.messageTrigger?.syncer, key, `sync.${key}`);
  }

  Object.defineProperty(sdk, 'wsManager', {
    configurable: true,
    get() { return manager; },
    set(value) {
      manager = value;
      if (!value) return;
      const sourceEpoch = epoch;
      let processing = 0;
      let closed = false;
      const receive = value.onBinaryMessage;
      const connect = value.connect;
      const close = value.close;
      value.connect = function (...args) {
        // Upstream reconnect timers may outlive logout. Never open an old socket.
        if (closed || failed || stopped || sourceEpoch !== epoch) return Promise.reject(new Error('SDK account stopped'));
        return connect.apply(this, args);
      };
      value.onBinaryMessage = function (...args) {
        if (closed || failed || stopped || sourceEpoch !== epoch) return Promise.resolve();
        processing++;
        value.isProcessingMessage = true;
        // Do not serialize WS responses behind messages that await those responses.
        return Promise.resolve().then(() => receive.apply(this, args))
          .catch(error => { fail(error, 'websocket.receive', sourceEpoch); })
          .finally(() => { processing--; value.isProcessingMessage = !closed && processing > 0; });
      };
      guard(value, 'sendPing', 'websocket.heartbeat');
      value.close = function (...args) {
        if (closed) return;
        closed = true;
        const socket = value.ws;
        try { return close.apply(this, args); } finally {
          // close() in upstream only closes OPEN sockets, leaving pending connects.
          if (socket?.readyState === 0) { try { socket.close(); } catch {} }
          if (socket) socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
          value.isProcessingMessage = false;
        }
      };
    },
  });
  const logout = sdk.logout;
  sdk.logout = function (...args) {
    stopped = true;
    epoch++;
    try { return logout.apply(this, args); } finally {
      // Upstream reset clears entries but leaves two interval timers per account.
      // Entries also have their own expiry timers, so disposal preserves relogin.
      sdk.messageTrigger?.typingManager?.send?.dispose();
      sdk.messageTrigger?.typingManager?.state?.dispose();
    }
  };
  const login = sdk.login;
  sdk.login = function (...args) {
    if (stopped) { epoch++; stopped = false; failed = false; }
    return login.apply(this, args);
  };
  return sdk;
};
