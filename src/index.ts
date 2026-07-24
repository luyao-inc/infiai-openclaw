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
import {
  cancelVoiceCallTurn,
  processOpenPlatformMessage,
  processOpenPlatformOutboundMessage,
  processVoiceCallTurn,
  warmVoiceCallContext,
} from "./inbound";
import { runOpenIMSetup } from "./setup";
import { registerOpenIMTools } from "./tools";

const SCHEDULED_TASK_BLOCKED_TOOLS = new Set([
  "bash",
  "shell",
  "process",
  "write",
  "edit",
  "apply_patch",
  "gateway",
  "cron",
  "sessions_spawn",
  "sessions_send",
  "subagents",
  "computer",
  "computer_use",
  "infiai_send_image",
  "infiai_send_video",
  "infiai_send_file",
]);

function splitRestrictedCommand(command: string): string[] | null {
  const normalized = command.trim().replace(/\s+2>\/dev\/null\s*$/, "");
  if (
    !normalized ||
    /[\r\n;|`<>]/.test(normalized) ||
    normalized.includes("$(") ||
    /(^|[^&])&([^&]|$)/.test(normalized)
  ) {
    return null;
  }
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function scheduledTaskExecAllowed(command: string): boolean {
  const tokens = splitRestrictedCommand(command);
  if (!tokens) return false;

  let skillDir = "";
  let commandIndex = 0;
  if (tokens[0] === "cd") {
    if (tokens.length < 5 || tokens[2] !== "&&") return false;
    skillDir = tokens[1];
    commandIndex = 3;
  }
  if (!["python3", "python"].includes(tokens[commandIndex])) return false;

  const script = tokens[commandIndex + 1] || "";
  const args = tokens.slice(commandIndex + 2);
  const skillPath = (skill: string): boolean => {
    const roots = [
      `~/.openclaw/skills/${skill}`,
      `/root/.openclaw/skills/${skill}`,
      `/home/node/.openclaw/skills/${skill}`,
    ];
    if (skillDir) {
      return roots.includes(skillDir) && script === (skill === "serper" ? "scripts/search.py" : "crypto_market_snapshot.py");
    }
    return roots.some((root) => script === `${root}/${skill === "serper" ? "scripts/search.py" : "crypto_market_snapshot.py"}`);
  };

  if (skillPath("serper")) {
    let hasQuery = false;
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!value) return false;
      if (flag === "-q" || flag === "--query") {
        if (hasQuery || value.length > 500) return false;
        hasQuery = true;
      } else if (flag === "-m" || flag === "--mode") {
        if (!["default", "current"].includes(value)) return false;
      } else if (flag === "--gl" || flag === "--hl") {
        if (!/^[a-z]{2}$/i.test(value)) return false;
      } else {
        return false;
      }
    }
    return hasQuery;
  }

  if (skillPath("crypto-market")) {
    return (
      args.length === 3 &&
      /^[A-Z0-9]{3,20}$/.test(args[0]) &&
      /^(?:[1-9]\d*[mhdwM])$/.test(args[1]) &&
      /^(?:[1-9]\d{0,2}|1000)$/.test(args[2])
    );
  }
  return false;
}

export function scheduledTaskToolBlockReason(event: any, ctx: any): string {
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || "").trim();
  if (!sessionKey.includes(":task:")) return "";
  const toolName = String(event?.toolName || ctx?.toolName || "").trim().toLowerCase();
  if (!toolName) return "scheduled task tool identity is missing";
  if (toolName === "exec") {
    const command = String(event?.params?.command || event?.parameters?.command || "").trim();
    if (scheduledTaskExecAllowed(command)) return "";
    return "tool exec is only allowed for audited read-only skill commands in a scheduled task";
  }
  if (SCHEDULED_TASK_BLOCKED_TOOLS.has(toolName)) {
    return `tool ${toolName} is not allowed in a scheduled task`;
  }
  return "";
}

function registerScheduledTaskToolGuard(api: any): void {
  if (typeof api.on !== "function") return;
  api.on(
    "before_tool_call",
    async (event: any, ctx: any) => {
      const blockReason = scheduledTaskToolBlockReason(event, ctx);
      if (!blockReason) return undefined;
      api.logger?.warn?.(`[infiai] scheduled task tool blocked: ${blockReason}`);
      return { block: true, blockReason };
    },
    { priority: 1000 },
  );
}

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
	const outboundHandler = async (input: any) => {
		const params = resolveGatewayRequestParams(input);
		const accountId = String(params?.accountId || "").trim();
		const client = getConnectedClient(accountId || undefined);
		if (!client) {
			throw new Error(accountId ? `Infiai account is not connected: ${accountId}` : "Infiai account is not connected");
		}
		return processOpenPlatformOutboundMessage(api, client, params);
	};
  const registrations: Array<() => boolean> = [
    () => {
      if (typeof api.registerGatewayMethod !== "function") return false;
      api.registerGatewayMethod("infiai.open_platform_message", handler);
			api.registerGatewayMethod("infiai.open_platform_outbound_message", outboundHandler);
      return true;
    },
    () => {
      if (typeof api.registerRpc !== "function") return false;
      api.registerRpc("infiai.open_platform_message", handler);
			api.registerRpc("infiai.open_platform_outbound_message", outboundHandler);
      return true;
    },
    () => {
      if (typeof api.registerMethod !== "function") return false;
      api.registerMethod("infiai.open_platform_message", handler);
			api.registerMethod("infiai.open_platform_outbound_message", outboundHandler);
      return true;
    },
    () => {
      const gateway = api.runtime?.gateway;
      if (!gateway || typeof gateway.registerMethod !== "function") return false;
      gateway.registerMethod("infiai.open_platform_message", handler);
			gateway.registerMethod("infiai.open_platform_outbound_message", outboundHandler);
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

function registerVoiceCallGateway(api: any): void {
  const turnHandler = async (input: any) => {
    const params = resolveGatewayRequestParams(input);
    const accountId = String(params?.accountId || "").trim();
    const client = getConnectedClient(accountId || undefined);
    if (!client) {
      throw new Error(accountId ? `Infiai account is not connected: ${accountId}` : "Infiai account is not connected");
    }
    return processVoiceCallTurn(api, client, params);
  };
  const cancelHandler = async (input: any) =>
    cancelVoiceCallTurn(resolveGatewayRequestParams(input));
  const warmupHandler = async (input: any) => {
    const params = resolveGatewayRequestParams(input);
    const accountId = String(params?.accountId || "").trim();
    const client = getConnectedClient(accountId || undefined);
    if (!client) {
      throw new Error(
        accountId
          ? `Infiai account is not connected: ${accountId}`
          : "Infiai account is not connected"
      );
    }
    return warmVoiceCallContext(client, params);
  };
  const registerMethod = (method: string, handler: (input: any) => Promise<any>): boolean => {
    const registrations: Array<() => boolean> = [
      () => {
        if (typeof api.registerGatewayMethod !== "function") return false;
        api.registerGatewayMethod(method, handler);
        return true;
      },
      () => {
        if (typeof api.registerRpc !== "function") return false;
        api.registerRpc(method, handler);
        return true;
      },
      () => {
        if (typeof api.registerMethod !== "function") return false;
        api.registerMethod(method, handler);
        return true;
      },
      () => {
        const gateway = api.runtime?.gateway;
        if (!gateway || typeof gateway.registerMethod !== "function") return false;
        gateway.registerMethod(method, handler);
        return true;
      },
    ];
    for (const register of registrations) {
      try {
        if (register()) return true;
      } catch (err: any) {
        api.logger?.warn?.(
          `[infiai] ${method} registration failed: ${String(err?.message || err)}`
        );
      }
    }
    return false;
  };
  const turnRegistered = registerMethod("infiai.voice_call_turn", turnHandler);
  const cancelRegistered = registerMethod("infiai.voice_call_cancel", cancelHandler);
  const warmupRegistered = registerMethod(
    "infiai.voice_call_warmup",
    warmupHandler
  );
  if (turnRegistered && cancelRegistered && warmupRegistered) {
    api.logger?.info?.("[infiai] voice call gateway methods registered");
    return;
  }
  api.logger?.warn?.(
    "[infiai] voice call gateway method API unavailable; AI voice calls will fail until the runtime exposes plugin RPC registration"
  );
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
  registerScheduledTaskToolGuard(api);
  registerOpenPlatformGateway(api);
  registerVoiceCallGateway(api);

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
