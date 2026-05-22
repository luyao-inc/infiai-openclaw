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

function registerCliMetadata(api: any): void {
  if (typeof api.registerCli !== "function") return;
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

function registerFull(api: any): void {
  (globalThis as any).__openimApi = api;
  (globalThis as any).__openimGatewayConfig = api.config;

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

export default {
  id: "openclaw-channel",
  name: "Infiai Channel",
  description: "Infiai protocol channel for OpenClaw",
  register(api: any): void {
    if (api.registrationMode === "cli-metadata") {
      registerCliMetadata(api);
      return;
    }
    if (api.registrationMode === "tool-discovery") {
      registerFull(api);
      return;
    }
    api.registerChannel({ plugin: OpenIMChannelPlugin });
    if (api.registrationMode === "discovery") {
      registerCliMetadata(api);
      return;
    }
    if (api.registrationMode !== "full") return;
    registerCliMetadata(api);
    registerFull(api);
  },
  channelPlugin: OpenIMChannelPlugin,
};
