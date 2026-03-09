import { getConnectedClient } from "./clients";
import { listAccountIds, resolveAccountConfig } from "./config";
import { sendTextToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

export const OpenIMChannelPlugin = {
  id: "openim",
  meta: {
    id: "openim",
    label: "OpenIM",
    selectionLabel: "OpenIM",
    docsPath: "/channels/openim",
    blurb: "OpenIM protocol channel via @openim/client-sdk",
    aliases: ["openim", "im"],
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
        return { ok: false, error: new Error("OpenIM requires --to <user:ID|group:ID>") };
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
        return { ok: false, error: new Error("OpenIM not connected") };
      }
      try {
        await sendTextToTarget(client, target, text);
        return { ok: true, provider: "openim" };
      } catch (e: any) {
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
};
