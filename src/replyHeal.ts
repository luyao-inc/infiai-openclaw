/**
 * 动态 import("./clients") 避免与 clients→inbound 的静态环依赖。
 * 当 OpenClaw hybrid 重载只重启 channel、不再次调用 registerService.start() 时，
 * runtime.channel.reply 可能已失效；在首条入站消息上自愈重连 SDK。
 */
let replyReadyChain: Promise<void> = Promise.resolve();

function hasReplyDispatcher(api: any): boolean {
  return Boolean(api.runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher);
}

export async function ensureInfiaiReplyReady(api: any): Promise<void> {
  if (hasReplyDispatcher(api)) return;

  replyReadyChain = replyReadyChain.then(async () => {
    if (hasReplyDispatcher(api)) return;

    api.logger?.warn?.(
      "[infiai] channel reply dispatcher missing; reconnecting SDK (self-heal for channel hot reload)",
    );

    const { stopAllClients, startAccountClient } = await import("./clients.js");
    const { listEnabledAccountConfigs } = await import("./config.js");

    await stopAllClients(api);
    const accounts = listEnabledAccountConfigs(api);
    if (accounts.length === 0) {
      api.logger?.warn?.("[infiai] self-heal skipped: no enabled infiai accounts in config");
      return;
    }

    for (const account of accounts) {
      await startAccountClient(api, account);
    }

    api.logger?.info?.(
      `[infiai] self-heal reconnect done; reply ready=${hasReplyDispatcher(api)}`,
    );
  });

  return replyReadyChain;
}
