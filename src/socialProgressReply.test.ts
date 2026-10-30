import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyToolProgressOnlyReply } from "./inbound";

test("completed count results are not discarded as tool progress", () => {
  for (const text of [
    "你的好友总数是 3 人，这是本次实时查询的结果。",
    "当前共有3个好友，以上是本次查询结果。",
    "查询结果：你的好友共3人。",
  ]) assert.equal(isLikelyToolProgressOnlyReply(text), false, text);
  for (const text of ["我来查询一下情况。", "先查一下资料。", "我正在查询好友信息。"])
    assert.equal(isLikelyToolProgressOnlyReply(text), true, text);
});
