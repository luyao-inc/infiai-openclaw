import test from "node:test";
import assert from "node:assert/strict";
import { registerOpenIMTools } from "./tools";
import { withInfiaiToolContext } from "./toolContext";

test("reply mode is actor-bound, permits visitors, and cannot borrow an account context", async () => {
  const tools: any[] = [];
  registerOpenIMTools({ registerTool: (tool: any) => tools.push(tool) });
  const tool = tools.find((x) => x.name === "infiai_set_reply_mode");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["mode", "scope"]);
  assert.equal((await tool.execute("id", { mode: "text" })).isError, true);
  const calls: unknown[] = [];
  const ctx = { accountId: "a", managedUserId: "owner", senderId: "visitor", agentId: "agent", sessionKey: "session", ownerAuthorized: false, source: "inbound" as const, setReplyMode: async (...args: unknown[]) => { calls.push(args); return { effectiveMode: "text", preferenceMode: "text" }; } };
  await withInfiaiToolContext(ctx, async () => {
    const result = await tool.execute("id", { mode: "text" });
    assert.equal(JSON.parse(result.content[0].text).changed, true);
    assert.equal((await tool.execute("id", { mode: "inherit", scope: "turn" })).isError, true);
    assert.equal((await tool.execute("id", { mode: "invalid" })).isError, true);
  });
  assert.deepEqual(calls, [["text", "conversation"]]);
  for (const source of ["voice_call", "open_platform", "incognito_chat"] as const) {
    await withInfiaiToolContext({ ...ctx, source }, async () => assert.equal((await tool.execute("id", { mode: "text" })).isError, true));
  }
  await withInfiaiToolContext({ ...ctx, setReplyMode: undefined }, async () => assert.equal((await tool.execute("id", { mode: "text" })).isError, true));
  await withInfiaiToolContext({ ...ctx, setReplyMode: async () => { throw new Error("write unavailable"); } }, async () => assert.equal((await tool.execute("id", { mode: "text" })).isError, true));
});
