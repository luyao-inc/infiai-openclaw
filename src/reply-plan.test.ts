import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplyPlan,
  effectiveReplyDelivery,
  MESSAGE_SEPARATOR,
  MAX_REPLY_PARTS,
  MAX_REPLY_PART_ENCODED_BYTES,
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
test("ordinary long prose stays in one model-chosen message", () => {
  const text = "先打开页面并按提示选择国家地区，然后选择身份证上传正反两面。".repeat(90);
  assert.deepEqual(buildReplyPlan(text, config), [text]);
});
test("independent content boundaries survive different lengths without two-plus-three packing", () => {
  const messages = ["先说结论。", ...Array.from({length:5}, (_,i)=>`作品${i+1}\n`+"同一作品的正文与说明。".repeat(i*6+1))];
  assert.deepEqual(buildReplyPlan(messages.join("\n"+MESSAGE_SEPARATOR+"\n"), config), messages);
  assert.deepEqual(buildReplyPlan("嗯，我听着。\n"+MESSAGE_SEPARATOR+"\n今天最让你难受的是哪一段？",config),["嗯，我听着。","今天最让你难受的是哪一段？"]);
});
test("more than eight natural boundaries retain their order and identity",()=>{
 const messages=Array.from({length:12},(_,i)=>`独立内容${i+1}。`);
 assert.deepEqual(buildReplyPlan(messages.join("\n"+MESSAGE_SEPARATOR+"\n"),config),messages);
 const abnormal=Array.from({length:MAX_REPLY_PARTS+2},(_,i)=>`内容${i}。`);
 assert.deepEqual(buildReplyPlan(abnormal.join("\n"+MESSAGE_SEPARATOR+"\n"),config),[...abnormal.slice(0,MAX_REPLY_PARTS-1),abnormal.slice(MAX_REPLY_PARTS-1).join("\n\n")]);
});
test("code, tables and conditions follow explicit boundaries without internal slicing", () => {
  const before = "先阅读说明，再完成这一步。".repeat(30);
  const code = '```typescript\nconst x = "'+MESSAGE_SEPARATOR+'";\n// '+"代码。".repeat(90)+"\n```";
  const table = "| 列 | 值 |\n| --- | --- |\n| A | "+"表格。".repeat(60)+" |";
  const messages=[before,code,table,"如果你没有账户，\n先创建账户再继续。"];
  assert.deepEqual(buildReplyPlan(messages.join("\n"+MESSAGE_SEPARATOR+"\n"),config),messages);
});
test("only wire-size overflow is sliced, losslessly across Unicode and JSON escaping",()=>{
 const text='😀中文"\\\n'.repeat(2400)+'结束';
 for(const mode of ["auto","single"] as const){
  const parts=buildReplyPlan(text,{...config,mode});
  assert.ok(parts.length>1);
  assert.equal(parts.join(""),text);
  assert.ok(parts.every(p=>Buffer.byteLength(JSON.stringify(JSON.stringify(p)),"utf8")<=MAX_REPLY_PART_ENCODED_BYTES));
  assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
 }
 assert.throws(()=>buildReplyPlan("字".repeat(MAX_REPLY_PART_ENCODED_BYTES*MAX_REPLY_PARTS),config),/safe delivery budget/);
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
