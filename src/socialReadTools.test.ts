import test from "node:test";
import assert from "node:assert/strict";
import { registerSocialReadTools } from "./socialReadTools";
import { withInfiaiToolContext } from "./toolContext";
import { InboundReplyTurn } from "./reply-delivery";

test("social reads bind the current owner, never another account or visitor", async () => {
  const registered: any[] = [];
  registerSocialReadTools({ registerTool: (tool: any) => registered.push(tool) });
  assert.equal(registered.length, 2);
  let calls = 0;
  const owner = {
    accountId: "account", managedUserId: "owner", senderId: "owner", agentId: "agent",
    sessionKey: "self", ownerAuthorized: true, source: "inbound" as const,
    getSocialOverview: async () => { calls++; return { friends: { count: 250 } }; },
    reviewConversations: async () => { calls++; return { records: [] }; },
  };
  for (const tool of registered) {
    const params = tool.name.includes("overview") ? { sections: ["friend_counts"] } : { days: 7 };
    assert.equal((await tool.execute("id", params)).isError, true);
    await withInfiaiToolContext(owner, async () => {
      const result = await tool.execute("id", params);
      assert.equal(result.isError, undefined);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.evidenceOnly, true);
      assert.equal((await tool.execute("id", { ...params, ownerUserID: "other" })).isError, true);
      assert.equal((await tool.execute("id", { ...params, accountId: "other" })).isError, true);
    });
    for (const change of [
      { senderId: "visitor", ownerAuthorized: false }, { senderId: "visitor" },
      { source: "open_platform" as const }, { source: "voice_call" as const }, { source: "incognito_chat" as const },
      { getSocialOverview: undefined, reviewConversations: undefined },
    ]) await withInfiaiToolContext({ ...owner, ...change }, async () => assert.equal((await tool.execute("id", params)).isError, true));
  }
  assert.equal(calls, 2);
});

test("owner query forwards program-owned identity and does not mutate delivery", async () => {
  const calls: any[] = [];
  const turn = new InboundReplyTurn(async (path, body) => {
    calls.push({ path, body });
    if (body.action === "begin") return { acquired: true, textDelivery: true, turnID: "turn", token: "private", config: { mode: "auto", pacing: "none" } };
    return { friends: { count: 250 } };
  }, { ownerUserID: "owner", accountId: "account", agentID: "default", actorUserID: "owner" });
  assert.equal(await turn.begin(), true);
  const result = await turn.readOwnerData("social_overview", { sections: ["friend_counts"], ownerUserID: "forged", token: "forged" });
  assert.equal(result.friends.count, 250);
  assert.equal(calls[1].body.ownerUserID, "owner");
  assert.equal(calls[1].body.token, "private");
  assert.equal(calls[1].path, "/claw/internal/tools/social_overview");
  await turn.finish();
});

test("parallel owner conversations cannot borrow read closures", async () => {
  const tools: any[] = [];
  registerSocialReadTools({ registerTool: (t: any) => tools.push(t) });
  const read = tools[0];
  const result = await Promise.all(["a", "b"].map(id => withInfiaiToolContext({
    accountId: id, managedUserId: id, senderId: id, agentId: id, sessionKey: id, ownerAuthorized: true, source: "inbound",
    getSocialOverview: async () => { await new Promise(r => setTimeout(r, 5)); return { account: id }; },
  }, async () => JSON.parse((await read.execute("id", { sections: ["friend_counts"] })).content[0].text).account)));
  assert.deepEqual(result, ["a", "b"]);
});

test("statistics scope is injected through the actual owner prompt hook", async () => {
  let hook: any;
  registerSocialReadTools({ registerTool() {}, on(name: string, fn: any) { if (name === "before_prompt_build") hook = fn; } });
  assert.equal(hook(), undefined);
  const owner = { accountId: "a", managedUserId: "o", senderId: "o", agentId: "g", sessionKey: "s", ownerAuthorized: true, source: "inbound" as const, getSocialOverview: async () => ({}) };
  await withInfiaiToolContext(owner, async () => assert.match(hook().appendSystemContext, /独立人数不可用/));
  await withInfiaiToolContext({ ...owner, senderId: "visitor", ownerAuthorized: false }, async () => assert.equal(hook(), undefined));
  await withInfiaiToolContext({ ...owner, getSocialOverview: undefined }, async () => assert.equal(hook(), undefined));
});
