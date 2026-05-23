import { connectedClientCount, getConnectedClient } from "./clients";
import { createHmac } from "node:crypto";
import { sendFileToTarget, sendImageToTarget, sendVideoToTarget } from "./media";
import { parseTarget } from "./targets";
import { getInfiaiToolContext } from "./toolContext";
import { formatSdkError, infiaiDebug } from "./utils";

export function registerOpenIMTools(api: any): void {
  if (typeof api.registerTool !== "function") {
    api.logger?.warn?.("[infiai] registerTool API unavailable; social tools were not registered");
    return;
  }
  infiaiDebug(api, "[infiai] registering social tools");

  type InfiaiToolParams = {
    accountId?: string;
    taskID?: string;
    runID?: string;
  };

  const chatToolCall = async (client: any | null, path: string, payload: Record<string, unknown>) => {
    const base = String(client?.config?.chatApiAddr || process.env.INFIAI_CHAT_API_ADDR || process.env.CHAT_API_ADDR || "http://openim-chat:10008").replace(/\/+$/, "");
    if (!base) throw new Error("Infiai Chat API endpoint is not configured.");
    const requestPayload: Record<string, unknown> = { ...(payload || {}) };
    if (client?.config?.userID) requestPayload.ownerUserID = client.config.userID;
    if (client?.config?.accountId) requestPayload.accountId = client.config.accountId;
    const requestBody = JSON.stringify(requestPayload);
    const sharedSecret = String(process.env.OPENCLAW_SHARED_SECRET || process.env.INFIAI_TOOL_SHARED_SECRET || "").trim();
    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sharedSecret ? { "X-Claw-Signature": createHmac("sha256", sharedSecret).update(requestBody).digest("hex") } : {}),
        operationID: `openclaw-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      body: requestBody,
    });
    const text = await resp.text();
    let responseBody: any = {};
    if (text) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = { raw: text };
      }
    }
    if (!resp.ok) throw new Error(responseBody?.errMsg || responseBody?.error || text || `HTTP ${resp.status}`);
    if (responseBody && typeof responseBody === "object" && "errCode" in responseBody && Number(responseBody.errCode) !== 0) {
      throw new Error(String(responseBody.errMsg || responseBody.errDlt || "Infiai API error"));
    }
    return responseBody?.data ?? responseBody;
  };

  const toolFailure = (label: string, error: unknown) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: `${label}: ${formatSdkError(error)}`,
          instruction: "STOP. Do not claim the action succeeded. Tell the user this Infiai tool call failed.",
        }),
      },
    ],
  });

  const ambiguousAccountFailure = () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: "accountId is required because multiple Infiai accounts are connected.",
          instruction:
            "STOP. Do not retry with a guessed account. Use the current Infiai accountId from the workspace/tool instructions, or tell the user the account context is missing.",
        }),
      },
    ],
  });

  const notConnectedFailure = (accountId?: string) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: accountId ? `Infiai account is not connected: ${accountId}` : "Infiai is not connected.",
          instruction: "STOP. Do not claim the action succeeded.",
        }),
      },
    ],
  });

  const forbiddenToolFailure = (reason: string) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: reason,
          instruction:
            "STOP. Do not call any other Infiai social tool for this request. Explain briefly that this action can only be performed by the owner talking to their own avatar.",
        }),
      },
    ],
  });

  const authorizeSocialTool = (accountId?: string) => {
    const context = getInfiaiToolContext(accountId);
    if (!context) return { ok: true as const };
    const normalizedAccountId = String(accountId || "").trim();
    if (normalizedAccountId && normalizedAccountId !== context.accountId) {
      return {
        ok: false as const,
        result: forbiddenToolFailure(
          "Infiai tool account context does not match the active conversation.",
        ),
      };
    }
    if (!context.ownerAuthorized) {
      return {
        ok: false as const,
        result: forbiddenToolFailure(
          "Infiai social tools are disabled when someone is talking to another user's avatar.",
        ),
      };
    }
    return { ok: true as const };
  };

  const resolveAccountContext = (params?: InfiaiToolParams) => {
    const explicitAccountId = String(params?.accountId || "").trim();
    const context = getInfiaiToolContext(explicitAccountId || undefined);
    const normalizedAccountId = explicitAccountId || context?.accountId || "";
    const taskID = String(params?.taskID || "").trim();
    return { normalizedAccountId, taskID };
  };

  const ensureClient = (params?: string | InfiaiToolParams) => {
    const rawParams = typeof params === "string" ? { accountId: params } : params;
    const { normalizedAccountId, taskID } = resolveAccountContext(rawParams);
    const authorized = authorizeSocialTool(normalizedAccountId || undefined);
    if (!authorized.ok) return authorized;
    if (!normalizedAccountId && !taskID && connectedClientCount() > 1) {
      return {
        ok: false as const,
        result: ambiguousAccountFailure(),
      };
    }
    if (!normalizedAccountId && taskID) {
      return { ok: true as const, client: null };
    }
    const client = getConnectedClient(normalizedAccountId || undefined);
    if (!client) {
      if (taskID) {
        return { ok: true as const, client: null };
      }
      return {
        ok: false as const,
        result: notConnectedFailure(normalizedAccountId || undefined),
      };
    }
    return { ok: true as const, client };
  };

  const ensureTargetAndChatTool = (params: { target?: string } & InfiaiToolParams) => {
    const target = parseTarget(params.target);
    if (!target) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "Invalid target format. Expected user:<id> or group:<id>." }],
        },
      };
    }
    const checked = ensureClient(params);
    if (!checked.ok) return checked;
    return { ok: true as const, target, client: checked.client };
  };

  const ensureTargetAndClient = (params: { target?: string; accountId?: string }) => {
    const target = parseTarget(params.target);
    if (!target) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "Invalid target format. Expected user:<id> or group:<id>." }],
        },
      };
    }
    const normalizedAccountId = String(params.accountId || "").trim();
    const authorized = authorizeSocialTool(normalizedAccountId || undefined);
    if (!authorized.ok) return authorized;
    if (!normalizedAccountId && connectedClientCount() > 1) {
      return {
        ok: false as const,
        result: ambiguousAccountFailure(),
      };
    }
    const client = getConnectedClient(normalizedAccountId || undefined);
    if (!client) {
      return {
        ok: false as const,
        result: notConnectedFailure(normalizedAccountId || undefined),
      };
    }
    return { ok: true as const, target, client };
  };

  api.registerTool({
    name: "infiai_send_text",
    description: "Send a text message via Infiai business API with trace metadata. target format: user:ID or group:ID.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        text: { type: "string", description: "Text to send" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID for trace metadata" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID for trace metadata" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["target", "text"],
    },
    async execute(_id: string, params: { target: string; text: string; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureTargetAndChatTool(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/send_message", {
          target: `${checked.target.kind}:${checked.target.id}`,
          text: params.text,
          taskID: params.taskID,
          runID: params.runID,
          accountId: params.accountId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Send failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_list_my_friends",
    description: "List or search the current Infiai user's friends. Use this before sending to existing contacts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional nickname/remark/profile keyword" },
        limit: { type: "number", description: "Maximum results, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
    },
    async execute(_id: string, params: { query?: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/list_my_friends", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("List friends failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_list_my_groups",
    description: "List or search groups the current Infiai user has joined. Use this before sending to an existing group.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional group name/introduction/type keyword" },
        limit: { type: "number", description: "Maximum results, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
    },
    async execute(_id: string, params: { query?: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/list_my_groups", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("List groups failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_search_people",
    description: "Search public Infiai people/agent profiles by keyword. Results are public candidates and may require a friend request before messaging.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword describing nickname/category/profile/introduction" },
        limit: { type: "number", description: "Maximum results, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/search_people", {
          keyword: params.query,
          pagination: { pageNumber: 1, showNumber: Math.min(Math.max(Number(params.limit || 20), 1), 100) },
          taskID: params.taskID,
          runID: params.runID,
          accountId: params.accountId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Search people failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_search_groups",
    description: "Search public Infiai groups by name, type, or introduction. Results are public candidates and may require joining before messaging.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword describing group name/type/introduction" },
        limit: { type: "number", description: "Maximum results, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/search_groups", {
          keyword: params.query,
          sort: "hot",
          pagination: { pageNumber: 1, showNumber: Math.min(Math.max(Number(params.limit || 20), 1), 100) },
          taskID: params.taskID,
          runID: params.runID,
          accountId: params.accountId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Search groups failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_apply_friends",
    description: "Send friend applications to selected public people candidates. Backend first checks current friendships and returns isFriend for each target; only submit clear non-friend targets.",
    parameters: {
      type: "object",
      properties: {
        userIDs: { type: "array", items: { type: "string" }, description: "User IDs to apply to, max 20" },
        message: { type: "string", description: "Friend request message" },
        reason: { type: "string", description: "Why these users matched" },
        taskID: { type: "string", description: "Optional scheduled task ID" },
        runID: { type: "string", description: "Optional scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["userIDs", "message"],
    },
    async execute(_id: string, params: { userIDs: string[]; message: string; reason?: string; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/apply_friends", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Apply friends failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_apply_groups",
    description: "Send join requests to selected Infiai groups. Do not use this for groups already joined.",
    parameters: {
      type: "object",
      properties: {
        groupIDs: { type: "array", items: { type: "string" }, description: "Group IDs to apply to, max 20" },
        message: { type: "string", description: "Join request message" },
        reason: { type: "string", description: "Why these groups matched" },
        taskID: { type: "string", description: "Optional scheduled task ID" },
        runID: { type: "string", description: "Optional scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["groupIDs", "message"],
    },
    async execute(_id: string, params: { groupIDs: string[]; message: string; reason?: string; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/apply_groups", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Apply groups failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_list_group_members",
    description: "List members of a group the current Infiai user has joined, if the group allows viewing member profiles.",
    parameters: {
      type: "object",
      properties: {
        groupID: { type: "string", description: "Joined group ID" },
        query: { type: "string", description: "Optional member nickname/userID keyword" },
        limit: { type: "number", description: "Maximum results, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["groupID"],
    },
    async execute(_id: string, params: { groupID: string; query?: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/list_group_members", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("List group members failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_get_friend_chat_history",
    description: "Read recent chat history between the current Infiai user and one of their friends.",
    parameters: {
      type: "object",
      properties: {
        userID: { type: "string", description: "Friend user ID" },
        limit: { type: "number", description: "Maximum messages, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["userID"],
    },
    async execute(_id: string, params: { userID: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/friend_chat_history", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Friend chat history failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_get_group_chat_history",
    description: "Read recent chat history from a group the current Infiai user has joined.",
    parameters: {
      type: "object",
      properties: {
        groupID: { type: "string", description: "Joined group ID" },
        limit: { type: "number", description: "Maximum messages, default 20, max 100" },
        taskID: { type: "string", description: "Optional Infiai scheduled task ID" },
        runID: { type: "string", description: "Optional Infiai scheduled run ID" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["groupID"],
    },
    async execute(_id: string, params: { groupID: string; limit?: number; taskID?: string; runID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/group_chat_history", params as any);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Group chat history failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_get_task_context",
    description: "Return current Infiai tool context for trace metadata. Cron prompts may also include taskID/runID explicitly.",
    parameters: {
      type: "object",
      properties: {
        taskID: { type: "string", description: "Optional scheduled task ID from the cron prompt" },
        runID: { type: "string", description: "Optional scheduled run ID from the cron prompt" },
        agentID: { type: "string", description: "Optional agent ID from the cron prompt" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
    },
    async execute(_id: string, params: { taskID?: string; runID?: string; agentID?: string; accountId?: string }) {
      const checked = ensureClient(params);
      if (!checked.ok) return checked.result;
      try {
        const result = await chatToolCall(checked.client, "/claw/internal/tools/context", {
          taskID: params.taskID,
          runID: params.runID,
          agentID: params.agentID,
          accountId: params.accountId,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e: any) {
        return toolFailure("Context failed", e);
      }
    },
  });

  api.registerTool({
    name: "infiai_send_image",
    description: "Send an image via Infiai. `image` supports a local path or an http(s) URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        image: { type: "string", description: "Local path (`file://` supported) or URL" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["target", "image"],
    },
    async execute(_id: string, params: { target: string; image: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendImageToTarget(checked.client, checked.target, params.image);
        return { content: [{ type: "text", text: "Image sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "infiai_send_video",
    description: "Send a video via Infiai (delivered as a file message). `video` supports a local path or URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        video: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["target", "video"],
    },
    async execute(_id: string, params: { target: string; video: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendVideoToTarget(checked.client, checked.target, params.video, params.name);
        return { content: [{ type: "text", text: "Video sent successfully as a file" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "infiai_send_file",
    description: "Send a file via Infiai. `file` supports a local path or URL; `name` is optional.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        file: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Current Infiai account ID from workspace/tool instructions. Required when multiple accounts are connected." },
      },
      required: ["target", "file"],
    },
    async execute(_id: string, params: { target: string; file: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendFileToTarget(checked.client, checked.target, params.file, params.name);
        return { content: [{ type: "text", text: "File sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });
}
