/**
 * OpenClaw Infiai Channel Plugin
 *
 * Integrates Infiai into OpenClaw Gateway using the official SDK.
 * Supports multi-account concurrency, direct/group text messaging, and mention-gated group triggering.
 */

import "./polyfills";
import { OpenIMChannelPlugin } from "./channel";
import { startAccountClient, stopAllClients } from "./clients";
import { listEnabledAccountConfigs } from "./config";
import { runOpenIMSetup } from "./setup";
import { registerOpenIMTools } from "./tools";

export default function register(api: any): void {
  (globalThis as any).__openimApi = api;
  (globalThis as any).__openimGatewayConfig = api.config;

  api.registerChannel({ plugin: OpenIMChannelPlugin });

  if (typeof api.registerCli === "function") {
    api.registerCli(
      (ctx: any) => {
        const prog = ctx.program;
        if (prog && typeof prog.command === "function") {
          const infiai = prog.command("infiai").description("Infiai channel configuration");
          infiai.command("setup").description("Interactive setup for the Infiai default account").action(async () => {
            await runOpenIMSetup();
          });
        }
      },
      { commands: ["infiai"] }
    );
  }

  registerOpenIMTools(api);

  api.registerService({
    id: "infiai-sdk",
    start: async () => {
      // 正常运行时 IM 连接由 channels.infiai.gateway.startAccount 建立（在 startChannels 阶段，早于本 sidecar）。
      // 仅当显式跳过渠道启动（测试 / OPENCLAW_SKIP_CHANNELS 等）时才在此处补连。
      const skip =
        process.env.OPENCLAW_SKIP_CHANNELS === "1" || process.env.OPENCLAW_SKIP_PROVIDERS === "1";
      if (!skip) {
        return;
      }

      const accounts = listEnabledAccountConfigs(api);
      if (accounts.length === 0) {
        api.logger?.warn?.("[infiai] no enabled account (skip-channels fallback)");
        return;
      }
      for (const account of accounts) {
        await startAccountClient(api, account);
      }
      api.logger?.info?.(`[infiai] skip-channels fallback: started ${accounts.length} account(s)`);
    },
    stop: async () => {
      await stopAllClients(api);
      api.logger?.info?.("[infiai] service stopped");
    },
  });

  api.logger?.info?.("[infiai] plugin loaded");
}
