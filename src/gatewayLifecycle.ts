/**
 * OpenClaw 渠道热重载时会对渠道调用 stopChannel → startChannel，其内部仅在
 * plugin.gateway.startAccount 存在时才真正启动侧车任务（见 openclaw 的 startChannelInternal）。
 * 仅靠 registerService.start 会在「仅重启 infiai channel」时永远不再次执行，导致 SDK 掉线且无自动回复。
 * 此处实现官方渠道插件的 gateway 生命周期；abort 时结束长驻 Promise，网关会设置 running 状态并允许重连。
 */

import { getOpenIMAccountConfig } from "./config";
import { startAccountClient, stopAccountClient } from "./clients";

function getInfiaiApi(): any {
  return (globalThis as any).__openimApi;
}

export async function infiaiGatewayStartAccount(ctx: any): Promise<void> {
  const api = getInfiaiApi();
  if (!api) {
    throw new Error("[infiai] plugin api not ready (__openimApi missing)");
  }

  const cfg = getOpenIMAccountConfig({ config: ctx.cfg ?? api.config }, ctx.accountId);
  if (!cfg) {
    ctx.log?.warn?.(`[infiai] [${ctx.accountId}] missing or invalid account config`);
    return;
  }
  if (!cfg.enabled) {
    ctx.log?.info?.(`[infiai] [${ctx.accountId}] account disabled; skipping`);
    return;
  }

  await startAccountClient(api, cfg, { abortSignal: ctx.abortSignal });
}

export async function infiaiGatewayStopAccount(ctx: any): Promise<void> {
  const api = getInfiaiApi();
  if (!api) return;
  await stopAccountClient(api, ctx.accountId);
}
