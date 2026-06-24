import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInfiaiOriginatingTo,
  cloneConfigWithAgentPrimaryModel,
  extractAssistantTextSnapshotFromSessionLine,
  getInfiaiMessageKind,
  isAgnesFallbackTriggerText,
  isManagedBotNonConversationalMessage,
  parseAgentSubscriptionPreflightDecision,
  resolveAgnesFallbackModel,
  resolveNoVisibleFallbackReply,
  shouldSuppressNoVisibleFallbackForAssistantText,
} from "./inbound";

test("detects Agnes provider failures eligible for DeepSeek fallback", () => {
  assert.equal(
    isAgnesFallbackTriggerText("All models are temporarily rate-limited. Please try again in a few minutes."),
    true,
  );
  assert.equal(
    isAgnesFallbackTriggerText("Rate-limited — ready in ~23s. Please wait a moment."),
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
  const next = cloneConfigWithAgentPrimaryModel(cfg, "a1", "deepseek/deepseek-v4-flash");
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
  assert.equal(shouldSuppressNoVisibleFallbackForAssistantText("NO_REPLY"), true);
  assert.equal(shouldSuppressNoVisibleFallbackForAssistantText("no_answer."), true);
  assert.equal(shouldSuppressNoVisibleFallbackForAssistantText("   \n\t  "), true);
});

test("does not suppress no-visible fallback for substantive assistant text", () => {
  assert.equal(shouldSuppressNoVisibleFallbackForAssistantText("我在，找我什么事？"), false);
  assert.equal(shouldSuppressNoVisibleFallbackForAssistantText("我在。\nNO_REPLY"), false);
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
