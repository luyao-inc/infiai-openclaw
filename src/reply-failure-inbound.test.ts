import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processInboundMessage } from "./inbound";
import { registerSuggestionHooks } from "./nextSuggestions";

const notice = "抱歉，当前服务暂时无法完成回复，请稍后再试。";

// Run the real inbound/filter/fallback/outbound path; substitute only external IO.
test("model failures reach the sender once using the existing friendly notice", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lingxie-failure-"));
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(path.join(workspace, ".openclaw"));
    await fs.writeFile(path.join(workspace, ".openclaw/workspace-state.json"), JSON.stringify({ automationMode: "always", conversationMemoryEnabled: false }));
    const accountId = "acc_default__failure-owner__default";
    const agentId = "mg_default__failure-owner__default";
    const cfg = { agents: { list: [{ id: agentId, workspace }] }, channels: { infiai: { accounts: { [accountId]: { enabled: true, userID: "failure-owner" } } } }, bindings: [{ agentId, match: { channel: "infiai", accountId } }] };
    let textDelivery = false;
    let planned: any[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith("http://failure-test.invalid/"), url);
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.action === "plan") planned = body.parts.map((text: string, i: number) => ({ text, messageID: `out-${i}`, status: "pending", attempts: 1 }));
      const data = url.endsWith("/memory/context") ? { contextText: "" }
        : url.endsWith("/reply-delivery/turn") ? { acquired: true, textDelivery, turnID: "test-turn", token: "test-token", enabled: false, config: { version: 1, mode: "single", pacing: "none" }, parts: planned, send: true }
        : { allowed: true, active: false };
      return new Response(JSON.stringify({ errCode: 0, data }), { status: 200 });
    };
    for (const deliveryMode of [false, true]) {
      textDelivery = deliveryMode;
      for (const [index, payload] of [
        "⚠️ Agent failed before reply: LLM request failed: provider rejected the request schema or tool payload.",
        notice,
        "HTTP 429 provider cooldown",
        "我在。",
        "**一、这是重点。\n**解释说明。",
        "**前文**\n```ts\nconst x = '**代码**';\n```\n**后文**",
      ].entries()) {
        await t.test(`textDelivery=${textDelivery} payload ${index}`, async () => {
          const sent: any[] = [];
          const errors: string[] = [];
          const api = { config: cfg, on: () => {}, logger: { warn: () => {}, info: () => {}, error: (s: string) => errors.push(s) }, runtime: { channel: {
            routing: { resolveAgentRoute: () => ({ agentId, matchedBy: "binding" }) },
            reply: { dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }: any) => {
              await dispatcherOptions.deliver({ text: payload }, { kind: "final" });
              if (index < 3) await dispatcherOptions.deliver({ text: payload }, { kind: "final" });
            } },
          } } };
          registerSuggestionHooks(api);
          const client = { config: { accountId, userID: "failure-owner", inboundWhitelist: [], requireMention: true, chatApiAddr: "http://failure-test.invalid" }, gatewayConfig: cfg, sdk: {
            createTextMessage: async (text: string) => ({ data: { textElem: { content: text } } }),
            sendMessage: async (value: any) => { sent.push(value); return { data: {} }; },
          } };
          await processInboundMessage(api, client as any, { sendID: "failure-visitor", recvID: "failure-owner", sessionType: 1, contentType: 101, textElem: { content: "在吗？" }, clientMsgID: `failure-regression-${textDelivery}-${index}`, sendTime: Date.now(), senderNickname: "访客", senderPlatformID: 5, ex: JSON.stringify({infiai:{nextSuggestionsVersion:1}}) } as any);
          assert.deepEqual(errors, []);
          assert.equal(sent.length, 1);
          assert.equal(sent[0].recvID, "failure-visitor");
          assert.equal(sent[0].message.textElem.content, index < 3 ? notice : index === 4 ? "一、这是重点。\n解释说明。" : index === 5 ? "前文\n```ts\nconst x = '**代码**';\n```\n后文" : payload);
          assert.equal(JSON.parse(sent[0].message.ex).infiai.messageKind, index < 3 ? "model_error" : "assistant_reply");
        });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
