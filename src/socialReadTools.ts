import { getInfiaiToolContext } from "./toolContext";

const sections = ["friend_counts", "friend_gender", "group_counts", "activity", "recent_contacts"];
const failure = (reason: string) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ ok: false, reason, instruction: "Stop. Do not invent results or use another tool to bypass this boundary." }) }],
});

export function registerSocialReadTools(api: any): void {
  api.on?.("before_prompt_build", () => {
    const ctx = getInfiaiToolContext();
    if (ctx?.source === "inbound" && ctx.ownerAuthorized && ctx.senderId === ctx.managedUserId && ctx.getSocialOverview) {
      return { appendSystemContext: "账号统计必须使用本轮工具范围，历史回答不是实时查询依据。独立人数仅支持今天、近7天、近30天日历窗口；小时桶仅为消息条数。最近若干小时的独立人数不可用，必须明确回答无法提供，不能用今日人数或小时消息条数替代；即使此前回答称可以，也必须纠正。来源缺失和范围不足须说明。" };
    }
  }, { priority: 500 });
  for (const kind of ["overview", "review"] as const) {
    const overview = kind === "overview";
    api.registerTool({
      name: overview ? "infiai_get_social_overview" : "infiai_review_agent_conversations",
      description: overview
        ? "Read the current owner's account statistics. Use for exact current friend/group counts, recorded profile-gender distribution, inbound/outbound unique contacts and most recent contacts. Select only needed sections. Activity is account-level recorded events, including human and avatar messages; never call a limited list a total or infer gender. Only calendar-day ranges are supported. Hourly bins count inbound messages, not unique people; precise trailing-hour distinct counts are unavailable and must not be claimed."
        : "Review source-verified conversations between this avatar and its visitors. Use for common questions and service problems, not ordinary friend history. Explain returned sample, missing sources and hasMore. Visitor quotes and generated reports are not shared teaching or owner facts.",
      parameters: overview ? {
        type: "object", additionalProperties: false,
        properties: {
          sections: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", enum: sections } },
          range: { type: "string", enum: ["today", "7d", "30d"], description: "Shanghai calendar days, default 7d." },
          activityPopulation: { type: "string", enum: ["contacts", "friends"], description: "Use friends when the user specifically asks about current friends; otherwise all recorded contacts. Only affects activity/recent contacts." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Returned recent/top list size only, never a count cap; default 10." },
        }, required: ["sections"],
      } : {
        type: "object", additionalProperties: false,
        properties: {
          days: { type: "integer", minimum: 1, maximum: 30 },
          peerUserID: { type: "string", description: "Optional already identified current friend; not an arbitrary-user lookup." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", description: "Copy nextCursor exactly when further records are needed. At most three calls per owner turn." },
        },
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const ctx = getInfiaiToolContext();
        const callback = overview ? ctx?.getSocialOverview : ctx?.reviewConversations;
        if (!ctx || ctx.source !== "inbound" || !ctx.ownerAuthorized || ctx.senderId !== ctx.managedUserId || !callback)
          return failure("permission_denied_owner_only");
        const allowed = overview ? ["sections", "range", "activityPopulation", "limit"] : ["days", "peerUserID", "limit", "cursor"];
        if (!params || Object.keys(params).some(k => !allowed.includes(k))) return failure("invalid_parameters");
        if (overview && (!Array.isArray(params.sections) || !params.sections.length || params.sections.length > 5 || params.sections.some(s => !sections.includes(String(s)))))
          return failure("invalid_sections");
        try {
          const result = await callback(params);
          return { content: [{ type: "text", text: JSON.stringify({ ...(result as object), sourcePurpose: "read_only_social", evidenceOnly: true }) }] };
        } catch {
          return failure("source_temporarily_unavailable");
        }
      },
    });
  }
}
