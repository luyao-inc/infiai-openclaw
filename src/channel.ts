import { getConnectedClient } from "./clients";
import { listAccountIds, resolveAccountConfig } from "./config";
import { sendTextToTarget } from "./media";
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
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => resolveAccountConfig(cfg, accountId),
  },
  outbound: {
    deliveryMode: "direct" as const,
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
