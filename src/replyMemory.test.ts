import test from "node:test";
import assert from "node:assert/strict";
import { validateReplyMemory } from "./replyMemory";

test("a valid conversation summary is delivered unchanged without any review model", async () => {
  const key = Symbol.for("infiai.knowledgeAnswerGuard.v1");
  const p = process as any, previous = p[key];
  p[key] = () => { throw new Error("retired review must never run"); };
  try {
    const check = validateReplyMemory({ validateMemory: async () => true });
    const text = "一、先定位，再分析。二、按前提归类。";
    assert.equal(await check(text), text);
  } finally { if (previous === undefined) delete p[key]; else p[key] = previous; }
});

test("memory deletion is rechecked on every delivery, including repeated text", async () => {
  let valid = true;
  const check = validateReplyMemory({ validateMemory: async () => valid });
  assert.equal(await check("已生成的回答"), "已生成的回答");
  valid = false;
  assert.equal(await check("已生成的回答"), "请重新发送刚才的问题。");
});
