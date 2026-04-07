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
      if (connectedClientCount() > 0) {
        api.logger?.info?.("[infiai] service already started");
        return;
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
