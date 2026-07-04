import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendLongTermMemoryContextToBodyForAgent,
  buildTextEnvelope,
  buildInfiaiOriginatingTo,
  cloneConfigWithAgentPrimaryModel,
  extractAssistantTextSnapshotFromSessionLine,
  getInfiaiMessageKind,
  isAgnesFallbackTriggerText,
  isInfiaiSessionControlCommand,
  isManagedBotNonConversationalMessage,
  parseAgentSubscriptionPreflightDecision,
  resetInfiaiSessionIfWorkspaceProjectionChanged,
  resetInfiaiSessionStoreEntry,
  resolveAgnesFallbackModel,
  resolveNoVisibleFallbackReply,
  shouldSubmitInfiaiMemoryExtract,
  shouldSuppressNoVisibleFallbackForAssistantText,
} from "./inbound";

test("detects Agnes provider failures eligible for DeepSeek fallback", () => {
  assert.equal(
    isAgnesFallbackTriggerText(
      "All models are temporarily rate-limited. Please try again in a few minutes.",
    ),
    true,
  );
  assert.equal(
    isAgnesFallbackTriggerText(
      "Rate-limited — ready in ~23s. Please wait a moment.",
    ),
    true,
  );
  assert.equal(isAgnesFallbackTriggerText("HTTP 429 provider cooldown"), true);
  assert.equal(isAgnesFallbackTriggerText("这是一条正常回复"), false);
});

test("resolves Agnes fallback model default and env override", () => {
  const original = process.env.OPENCLAW_AGNES_FALLBACK_MODEL;
  delete process.env.OPENCLAW_AGNES_FALLBACK_MODEL;
  assert.equal(resolveAgnesFallbackModel(), "deepseek/deepseek-v4-flash");
  process.env.OPENCLAW_AGNES_FALLBACK_MODEL = "deepseek/deepseek-chat";
  assert.equal(resolveAgnesFallbackModel(), "deepseek/deepseek-chat");
  if (original === undefined) delete process.env.OPENCLAW_AGNES_FALLBACK_MODEL;
  else process.env.OPENCLAW_AGNES_FALLBACK_MODEL = original;
});

test("clones config with per-agent fallback primary model only", () => {
  const cfg = {
    agents: {
      list: [
        { id: "a1", model: { primary: "agnes/agnes-2.0-flash" } },
        { id: "a2", model: { primary: "deepseek/deepseek-v4-flash" } },
      ],
    },
  };
  const next = cloneConfigWithAgentPrimaryModel(
    cfg,
    "a1",
    "deepseek/deepseek-v4-flash",
  );
  assert.equal(next.agents.list[0].model.primary, "deepseek/deepseek-v4-flash");
  assert.equal(next.agents.list[1].model.primary, "deepseek/deepseek-v4-flash");
  assert.equal(cfg.agents.list[0].model.primary, "agnes/agnes-2.0-flash");
});

test("parses Infiai structured message kind from nested message ex", () => {
  assert.equal(
    getInfiaiMessageKind({
      ex: JSON.stringify({ infiai: { messageKind: "model_error" } }),
    } as any),
    "model_error",
  );
  assert.equal(getInfiaiMessageKind({ ex: "{}" } as any), "");
});

test("suppresses only non-conversational managed-bot messages", () => {
  assert.equal(
    isManagedBotNonConversationalMessage({
      fromManagedBotSession: true,
      senderManaged: true,
      messageKind: "model_error",
    }),
    true,
  );
  assert.equal(
    isManagedBotNonConversationalMessage({
      fromManagedBotSession: true,
      senderManaged: true,
      messageKind: "billing_notice",
    }),
    true,
  );
  assert.equal(
    isManagedBotNonConversationalMessage({
      fromManagedBotSession: true,
      senderManaged: true,
      messageKind: "assistant_reply",
    }),
    false,
  );
  assert.equal(
    isManagedBotNonConversationalMessage({
      fromManagedBotSession: true,
      senderManaged: false,
      messageKind: "model_error",
    }),
    false,
  );
});

test("suppresses no-visible fallback for exact silent assistant replies", () => {
  assert.equal(
    shouldSuppressNoVisibleFallbackForAssistantText("NO_REPLY"),
    true,
  );
  assert.equal(
    shouldSuppressNoVisibleFallbackForAssistantText("no_answer."),
    true,
  );
  assert.equal(
    shouldSuppressNoVisibleFallbackForAssistantText("   \n\t  "),
    true,
  );
});

test("does not suppress no-visible fallback for substantive assistant text", () => {
  assert.equal(
    shouldSuppressNoVisibleFallbackForAssistantText("我在，找我什么事？"),
    false,
  );
  assert.equal(
    shouldSuppressNoVisibleFallbackForAssistantText("我在。\nNO_REPLY"),
    false,
  );
});

test("appends long-term memory context to agent body only once", () => {
  const body = "<infiai_context />\n用户问题";
  const context =
    "[Infiai Long-Term Memory Context]\n- 用户喜欢科幻电影\n[End Infiai Long-Term Memory Context]";
  const once = appendLongTermMemoryContextToBodyForAgent(body, context);
  assert.match(once, /^\[Infiai Long-Term Memory Context\]/);
  assert.equal(appendLongTermMemoryContextToBodyForAgent(once, context), once);
  assert.equal(appendLongTermMemoryContextToBodyForAgent(body, ""), body);
});

test("submits memory extraction only for visible assistant replies", () => {
  assert.equal(
    shouldSubmitInfiaiMemoryExtract({
      sent: true,
      messageKind: "assistant_reply",
      userText: "我喜欢科幻电影",
      assistantText: "我记住了。",
    }),
    true,
  );
  for (const messageKind of [
    "model_error",
    "system_notice",
    "billing_notice",
  ]) {
    assert.equal(
      shouldSubmitInfiaiMemoryExtract({
        sent: true,
        messageKind,
        userText: "用户输入",
        assistantText: "系统提示",
      }),
      false,
    );
  }
  assert.equal(
    shouldSubmitInfiaiMemoryExtract({
      sent: true,
      messageKind: "assistant_reply",
      userText: "用户输入",
      assistantText: "兜底提示",
      sentNoVisibleFallbackReply: true,
    }),
    false,
  );
});

test("extracts latest assistant text snapshots from session jsonl lines", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-06-15T04:24:14.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
    },
  });

  assert.deepEqual(extractAssistantTextSnapshotFromSessionLine(line), {
    text: "NO_REPLY",
    timestamp: "2026-06-15T04:24:14.000Z",
  });
  assert.equal(
    extractAssistantTextSnapshotFromSessionLine(
      line,
      Date.parse("2026-06-15T04:24:15.000Z"),
    ),
    null,
  );
});

test("ignores non-assistant and invalid session jsonl lines", () => {
  assert.equal(extractAssistantTextSnapshotFromSessionLine("not-json"), null);
  assert.equal(
    extractAssistantTextSnapshotFromSessionLine(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    ),
    null,
  );
});

test("uses a friendly fallback for silent replies to explicit group mentions only", () => {
  assert.equal(
    resolveNoVisibleFallbackReply({
      silentNoReply: true,
      explicitGroupMention: true,
      suppressedProgressOnly: false,
    }),
    "我在，想聊什么？",
  );
  assert.equal(
    resolveNoVisibleFallbackReply({
      silentNoReply: true,
      explicitGroupMention: false,
      suppressedProgressOnly: false,
    }),
    null,
  );
});

test("builds source reply targets for OpenClaw pending delivery", () => {
  assert.equal(
    buildInfiaiOriginatingTo({
      isGroup: true,
      groupID: "1207237331",
      senderID: "4839235718",
    }),
    "group:1207237331",
  );
  assert.equal(
    buildInfiaiOriginatingTo({
      isGroup: false,
      senderID: "4839235718",
    }),
    "user:4839235718",
  );
});

test("builds a compact capability-based Infiai conversation context", () => {
  const runtime = { channel: { reply: {} } };
  const visitor = buildTextEnvelope(
    runtime,
    {},
    "访客",
    "sender-1",
    "owner-1",
    1710000000000,
    "你一共有几个好友",
    "direct",
  );
  assert.match(
    visitor,
    /<infiai_context actor_role="visitor" owner_authorized="false" social_tools="denied" denial_reason="owner_only" \/>/,
  );
  assert.match(
    visitor,
    /<infiai_current_conversation current_chat_type="direct" current_user_id="sender-1" current_user_name="访客" actor_role="visitor" \/>/,
  );
  assert.doesNotMatch(visitor, /<infiai_conversation_context>/);
  assert.doesNotMatch(visitor, /managed_user_id/);
  assert.doesNotMatch(visitor, /current_sender_id/);
  assert.doesNotMatch(visitor, /capabilities:/);
  assert.doesNotMatch(visitor, /response_policy/);
  assert.doesNotMatch(visitor, /请遵守法律法规/);
  assert.doesNotMatch(visitor, /禁止使用 Infiai 联系人/);

  const owner = buildTextEnvelope(
    runtime,
    {},
    "测试1",
    "owner-1",
    "owner-1",
    1710000000000,
    "我一共有几个好友",
    "direct",
    false,
    { currentUserName: "测试1", currentAgentName: "测试1" },
  );
  assert.match(
    owner,
    /<infiai_context actor_role="owner" owner_authorized="true" social_tools="allowed" denial_reason="none" \/>/,
  );
  assert.match(
    owner,
    /<infiai_current_conversation current_chat_type="direct" current_user_id="owner-1" current_user_name="owner" current_agent_name="测试1" actor_role="owner" \/>/,
  );
});

test("marks explicit group mention in compact Infiai context", () => {
  const runtime = { channel: { reply: {} } };
  const groupMention = buildTextEnvelope(
    runtime,
    {},
    "群友",
    "sender-1",
    "owner-1",
    1710000000000,
    "@分身 在吗",
    "group",
    true,
    {
      currentUserName: "群友",
      currentGroupID: "group-1",
      currentGroupName: "测试群",
    },
  );
  assert.match(groupMention, /group_mention="explicit"/);
  assert.match(groupMention, /response_visibility="visible_short_reply"/);
  assert.match(groupMention, /current_chat_type="group"/);
  assert.match(groupMention, /current_group_id="group-1"/);
  assert.match(groupMention, /current_group_name="测试群"/);
  assert.doesNotMatch(groupMention, /no_meta_reply/);
});

test("detects only slash new as an Infiai session control command", () => {
  assert.equal(isInfiaiSessionControlCommand("/new"), true);
  assert.equal(isInfiaiSessionControlCommand(" /new  "), true);
  assert.equal(isInfiaiSessionControlCommand("/new please"), true);
  assert.equal(isInfiaiSessionControlCommand("new"), false);
  assert.equal(isInfiaiSessionControlCommand("帮我开启 new session"), false);
  assert.equal(isInfiaiSessionControlCommand("你有几个好友"), false);
});

test("resets only the current Infiai session mapping for slash new", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infiai-session-"));
  const storePath = path.join(dir, "sessions.json");
  const sessionFile = path.join(dir, "old-session.jsonl");
  await fs.writeFile(sessionFile, "keep transcript\n", "utf8");
  await fs.writeFile(
    storePath,
    JSON.stringify({
      "agent:a:infiai:direct:a:u1": {
        sessionFile,
        sessionStartedAt: 1000,
      },
      "agent:a:infiai:direct:a:u2": {
        sessionFile: path.join(dir, "other.jsonl"),
        sessionStartedAt: 1000,
      },
    }),
    "utf8",
  );

  const result = await resetInfiaiSessionStoreEntry(
    storePath,
    "agent:a:infiai:direct:a:u1",
    "a",
  );
  assert.equal(result.removed, true);
  assert.equal(result.sessionFile, sessionFile);
  assert.equal(await fs.readFile(sessionFile, "utf8"), "keep transcript\n");
  const next = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(next["agent:a:infiai:direct:a:u1"], undefined);
  assert.ok(next["agent:a:infiai:direct:a:u2"]);
});

test("resets stale Infiai session when workspace projection changed after session start", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infiai-stale-session-"));
  const storePath = path.join(dir, "sessions.json");
  const workspaceDir = path.join(dir, "workspace-a");
  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
  const soulPath = path.join(workspaceDir, "SOUL.md");
  await fs.writeFile(soulPath, "new role card\n", "utf8");
  await fs.writeFile(
    storePath,
    JSON.stringify({
      "agent:a:infiai:direct:a:u1": {
        sessionFile: path.join(dir, "old-session.jsonl"),
        sessionStartedAt: 1000,
      },
    }),
    "utf8",
  );
  const freshMtime = new Date(5000);
  await fs.utimes(soulPath, freshMtime, freshMtime);

  const result = await resetInfiaiSessionIfWorkspaceProjectionChanged({
    storePath,
    sessionKey: "agent:a:infiai:direct:a:u1",
    agentId: "a",
    workspaceDir,
  });
  assert.equal(result.removed, true);
  const next = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(next["agent:a:infiai:direct:a:u1"], undefined);
});

test("parses agent subscription preflight decisions from lower and Pascal case fields", () => {
  const defaults = {
    subscriberUserID: "8225049637",
    ownerUserID: "8225049637",
    agentID: "default",
  };

  assert.deepEqual(
    parseAgentSubscriptionPreflightDecision(
      {
        allowed: true,
        reason: "excluded",
        subscriberUserID: "8225049637",
        ownerUserID: "8225049637",
        agentID: "default",
      },
      defaults,
    ),
    {
      allowed: true,
      reason: "excluded",
      message: "",
      subscriptionID: "",
      subscriberUserID: "8225049637",
      ownerUserID: "8225049637",
      agentID: "default",
      freeRoundsUsed: 0,
      freeRoundsLimit: 0,
      costUsedUnits: 0,
      costLimitUnits: 0,
    },
  );

  assert.equal(
    parseAgentSubscriptionPreflightDecision(
      {
        Allowed: true,
        Reason: "excluded",
        SubscriberUserID: "8225049637",
        OwnerUserID: "8225049637",
        AgentID: "default",
      },
      defaults,
    ).allowed,
    true,
  );
});
