import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplyPlan,
  effectiveReplyDelivery,
  MESSAGE_SEPARATOR,
  isReplyStopCommand,
  replyPartDelayMs,
} from "./reply-plan";
const config = effectiveReplyDelivery();
const letters = (s: string) => s.replace(/\s/g, "");
test("short reply stays whole, explicit boundaries are optional and not displayed", () => {
  assert.deepEqual(buildReplyPlan("收到，我来看看。", config), [
    "收到，我来看看。",
  ]);
  assert.deepEqual(
    buildReplyPlan(`第一件事。\n${MESSAGE_SEPARATOR}\n第二件事。`, config),
    ["第一件事。", "第二件事。"]
  );
});
test("final cap preserves every sentence after a very long fallback", () => {
  const text =
    "先打开页面并按提示选择国家地区，然后选择身份证上传正反两面。".repeat(90);
  const parts = buildReplyPlan(text, config);
  assert.equal(parts.length, 8);
  assert.equal(letters(parts.join("")), letters(text));
  assert.ok(parts.every((p) => p.endsWith("。")));
});
test("protects complete code, tables, condition and heading while splitting surrounding prose", () => {
  const before = "先阅读说明，再完成这一步。".repeat(30);
  const code =
    '```typescript\nconst x = "' +
    MESSAGE_SEPARATOR +
    '";\n// ' +
    "代码。".repeat(90) +
    "\n```";
  const table =
    "| 列 | 值 |\n| --- | --- |\n| A | " + "表格。".repeat(60) + " |";
  const text = before + "\n\n" + code + "\n\n" + table + "\n\n" + before;
  const parts = buildReplyPlan(text, config);
  assert.ok(parts.length > 2);
  assert.ok(parts.some((p) => p.includes(code)));
  assert.ok(parts.some((p) => p.includes(table)));
  assert.equal(letters(parts.join("")), letters(text));
  const steps =
    "## 重要条件\n如果你没有账户，\n先创建账户再继续。\n\n" + before;
  const grouped = buildReplyPlan(steps, config);
  assert.ok(grouped[0].includes("先创建账户再继续。"));
});
test("empty boundaries recover without losing content; code delimiter is literal", () => {
  assert.deepEqual(
    buildReplyPlan(
      `${MESSAGE_SEPARATOR}\n甲\n${MESSAGE_SEPARATOR}\n${MESSAGE_SEPARATOR}\n乙`,
      config
    ),
    ["甲", "乙"]
  );
  const code = "```\n" + MESSAGE_SEPARATOR + "\n```";
  assert.deepEqual(buildReplyPlan(code, config), [code]);
});
test("single configuration and explicit user choice remove transport boundaries", () => {
  const text = "甲\n" + MESSAGE_SEPARATOR + "\n乙";
  assert.deepEqual(buildReplyPlan(text, { ...config, mode: "single" }), [
    "甲\n\n乙",
  ]);
  assert.deepEqual(buildReplyPlan(text, config, "请一条发完"), ["甲\n\n乙"]);
});
test("Unicode, URL, decimal and abbreviations survive", () => {
  const text =
    "😀Price is 3.14. See https://example.test/a.b?q=x. Please read this carefully! ".repeat(
      12
    );
  const parts = buildReplyPlan(text, config);
  assert.equal(letters(parts.join("")), letters(text));
  assert.ok(parts.every((p) => !p.endsWith("\ud83d")));
});
test("stopping is exact and delay bounded", () => {
  for (const text of ["/stop", "停止回复", "停止回答！", "stop replying"])
    assert.ok(isReplyStopCommand(text));
  for (const text of [
    "怎么停止回复？",
    "别停止回复",
    "stop replying to spam is a setting",
  ])
    assert.ok(!isReplyStopCommand(text));
  assert.equal(
    replyPartDelayMs("", () => 0),
    700
  );
  assert.equal(
    replyPartDelayMs("字".repeat(300), () => 1),
    2000
  );
});

test("group mention is removed only for the explicitly addressed name", async () => {
  const { replyControlText } = await import("./reply-plan");
  assert.equal(replyControlText("@说明助手 /stop", ["说明助手"]), "/stop");
  assert.equal(
    replyControlText("@其他人 /stop", ["说明助手"]),
    "@其他人 /stop"
  );
  assert.equal(
    replyControlText("@说明助手 怎么停止回复", ["说明助手"]),
    "怎么停止回复"
  );
});
