/**
 * OpenClaw Infiai Channel Plugin
 *
 * Integrates Infiai into OpenClaw Gateway using the official SDK.
 * Supports multi-account concurrency, direct/group text messaging, and mention-gated group triggering.
 */

import "./polyfills";
import { OpenIMChannelPlugin } from "./channel";
import { connectedClientCount, startAccountClient, stopAllClients } from "./clients";
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
      // OpenClaw 在 channels.infiai 等配置热重载时会「restarting infiai channel」并再次调用本 start()。
      // 若此处因 connectedClientCount>0 直接 return，不会重新挂载 SDK 与 runtime.channel.reply，
      // 表现为仍能收到 OnRecvNewMessages，但不再触发 embedded agent / 无自动回复，直到整容器重启。
      if (connectedClientCount() > 0) {
        api.logger?.info?.(
          "[infiai] service restart requested with existing clients; reconnecting SDK after channel reload",
        );
        await stopAllClients(api);
      }

      const accounts = listEnabledAccountConfigs(api);
      if (accounts.length === 0) {
        api.logger?.warn?.("[infiai] no enabled account config found");
        return;
      }

      for (const account of accounts) {
        await startAccountClient(api, account);
      }

      api.logger?.info?.(`[infiai] service started with ${connectedClientCount()}/${accounts.length} connected accounts`);
    },
    stop: async () => {
      await stopAllClients(api);
      api.logger?.info?.("[infiai] service stopped");
    },
  });

  api.logger?.info?.("[infiai] plugin loaded");
}
