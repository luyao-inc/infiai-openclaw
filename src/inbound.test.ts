import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInfiaiOriginatingTo,
  extractAssistantTextSnapshotFromSessionLine,
  resolveNoVisibleFallbackReply,
  shouldSuppressNoVisibleFallbackForAssistantText,
} from "./inbound";

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
