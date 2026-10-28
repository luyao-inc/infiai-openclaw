import { publicReplyText } from "./publicReply";
import { getConnectedClient } from "./clients";
import { listAccountIds, resolveAccountConfig } from "./config";
import { infiaiGatewayStartAccount, infiaiGatewayStopAccount } from "./gatewayLifecycle";
import { sendImageToTarget, sendTextToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

export const OpenIMChannelPlugin = {
  id: "infiai",
  meta: {
    id: "infiai",
    label: "Infiai",
    selectionLabel: "Infiai",
    docsPath: "/channels/infiai",
    blurb: "Infiai protocol channel via official SDK",
    aliases: ["infiai", "im"],
  },
  /**
   * OpenClaw 配置热重载按「路径前缀规则」分类（见网关内 listReloadRules / buildGatewayReloadPlan）。
   * 未命中任何规则的变更会 Fallback 为整进程重启，并在日志里把该路径列为 restart 原因。
   * 内置渠道在 OpenClaw 中带 `reload.configPrefixes`；扩展渠道必须在插件里声明，否则与文档「channels.* 可热应用」不一致。
   */
  reload: {
    configPrefixes: ["channels.infiai", "channels.openim"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => resolveAccountConfig(cfg, accountId),
  },
  /**
   * 必须实现：否则 hybrid 重载时 `startChannelInternal` 会因缺少 startAccount 直接 return，
   * `restarting infiai channel` 不会重建 SDK 连接（真实连接此前只活在 registerService.start，热重载不会再调）。
   */
  gateway: {
    startAccount: infiaiGatewayStartAccount,
    stopAccount: infiaiGatewayStopAccount,
  },
  outbound: {
    deliveryMode: "direct" as const,
    normalizePayload: ({ payload }: any) => ({ ...payload, text: publicReplyText(payload.text || "", payload.isError === true) }),
    sendMedia: async ({ to, text, mediaUrl, accountId }: { to: string; text: string; mediaUrl?: string; accountId?: string }) => {
      const target = parseTarget(to);
      if (!target) throw new Error("invalid target, expected user:<id> or group:<id>");
      const client = getConnectedClient(accountId);
      if (!client) throw new Error("Infiai not connected");
      if (!mediaUrl?.trim()) throw new Error("image is empty");
      const message = await sendImageToTarget(client, target, mediaUrl);
      if (text?.trim()) await sendTextToTarget(client, target, text);
      return { channel: "infiai", messageId: message.clientMsgID };
    },
    resolveTarget: ({ to }: { to?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("Infiai requires --to <user:ID|group:ID>") };
      }
      return { ok: true, to: `${target.kind}:${target.id}` };
    },
    sendText: async ({ to, text, accountId }: { to: string; text: string; accountId?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("invalid target, expected user:<id> or group:<id>") };
      }
      const client = getConnectedClient(accountId);
      if (!client) {
        return { ok: false, error: new Error("Infiai not connected") };
      }
      try {
        await sendTextToTarget(client, target, text);
        return { ok: true, provider: "infiai" };
      } catch (e: any) {
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
};
