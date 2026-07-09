/**
 * OpenClaw Infiai Channel Plugin
 *
 * Integrates Infiai into OpenClaw Gateway using the official SDK.
 * Supports multi-account concurrency, direct/group text messaging, and mention-gated group triggering.
 */

import "./polyfills";
import { OpenIMChannelPlugin } from "./channel";
import { getConnectedClient, startAccountClient, stopAllClients } from "./clients";
import { listEnabledAccountConfigs } from "./config";
import { processOpenPlatformMessage } from "./inbound";
import { runOpenIMSetup } from "./setup";
import { registerOpenIMTools } from "./tools";

function resolveGatewayRequestParams(input: any): any {
  if (
    input &&
    typeof input === "object" &&
    input.params &&
    typeof input.params === "object" &&
    !Array.isArray(input.params)
  ) {
    return input.params;
  }
  return input;
}

function registerOpenPlatformGateway(api: any): void {
  const handler = async (input: any) => {
    const params = resolveGatewayRequestParams(input);
    const accountId = String(params?.accountId || "").trim();
    const client = getConnectedClient(accountId || undefined);
    if (!client) {
      throw new Error(accountId ? `Infiai account is not connected: ${accountId}` : "Infiai account is not connected");
    }
    return processOpenPlatformMessage(api, client, params);
  };
  const registrations: Array<() => boolean> = [
    () => {
      if (typeof api.registerGatewayMethod !== "function") return false;
      api.registerGatewayMethod("infiai.open_platform_message", handler);
      return true;
    },
    () => {
      if (typeof api.registerRpc !== "function") return false;
      api.registerRpc("infiai.open_platform_message", handler);
      return true;
    },
    () => {
      if (typeof api.registerMethod !== "function") return false;
      api.registerMethod("infiai.open_platform_message", handler);
      return true;
    },
    () => {
      const gateway = api.runtime?.gateway;
      if (!gateway || typeof gateway.registerMethod !== "function") return false;
      gateway.registerMethod("infiai.open_platform_message", handler);
      return true;
    },
  ];
  for (const register of registrations) {
    try {
      if (register()) {
        api.logger?.info?.("[infiai] open platform gateway method registered");
        return;
      }
    } catch (err: any) {
      api.logger?.warn?.(`[infiai] open platform gateway method registration failed: ${String(err?.message || err)}`);
    }
  }
  api.logger?.warn?.("[infiai] open platform gateway method API unavailable; /open/v1/message will fail until the runtime exposes plugin RPC registration");
}

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
  registerOpenPlatformGateway(api);

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
