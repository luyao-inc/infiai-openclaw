import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processInboundMessage, processOpenPlatformMessage, processIncognitoMessage } from "./inbound";
import { registerSuggestionHooks } from "./nextSuggestions";
import { registerReplyFailureHooks, FRIENDLY_CONTENT_REJECTION } from "./replyFailure";

const notice = "这次没能好好接上你的话。你可以再说一次，我继续听。";

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
        "400 Input text data may contain inappropriate content.",
        "raw-rejection-recovery-success",
        "media-only",
      ].entries()) {
        await t.test(`textDelivery=${textDelivery} payload ${index}`, async () => {
          planned = [];
          const sent: any[] = [];
          const errors: string[] = [];
          const hooks: Record<string, any[]> = {};
          let dispatchCalls = 0;
          const api = { config: cfg, on: (name: string, handler: any) => { (hooks[name] ||= []).push(handler); }, logger: { warn: () => {}, info: () => {}, error: (s: string) => errors.push(s) }, runtime: { channel: {
            routing: { resolveAgentRoute: () => ({ agentId, matchedBy: "binding" }) },
            reply: { dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions, ctx }: any) => {
              dispatchCalls++;
              if (index === 8) {
                await dispatcherOptions.deliver({ mediaUrl: "https://example.invalid/guide.png" }, {kind:"final"});
                await dispatcherOptions.deliver({ mediaUrl: "https://example.invalid/guide.png" }, {kind:"final"});
                return;
              }
              if (index === 7) {
                if (dispatchCalls === 1) {
                  for (const hook of hooks.before_message_write || []) hook({ message: { role: "assistant", stopReason: "error", errorMessage: "400 Input text data may contain inappropriate content.", content: [] } }, { agentId, sessionKey: ctx.SessionKey });
                  await dispatcherOptions.deliver({ text: "LLM request failed: provider rejected the request schema or tool payload." }, { kind: "final" });
                } else await dispatcherOptions.deliver({ text: "你更想从哪个角度聊聊？" }, { kind: "final" });
                return;
              }
              await dispatcherOptions.deliver({ text: payload }, { kind: "final" });
              if (index < 3) await dispatcherOptions.deliver({ text: payload }, { kind: "final" });
            } },
          } } };
          registerSuggestionHooks(api);
          registerReplyFailureHooks(api);
          const client = { config: { accountId, userID: "failure-owner", inboundWhitelist: [], requireMention: true, chatApiAddr: "http://failure-test.invalid" }, gatewayConfig: cfg, sdk: {
            createImageMessageByURL: async () => ({ data: { contentType: 102, clientMsgID: "image-regression" } }),
            createTextMessage: async (text: string) => ({ data: { textElem: { content: text } } }),
            sendMessage: async (value: any) => { sent.push(value); return { data: {} }; },
          } };
          await processInboundMessage(api, client as any, { sendID: "failure-visitor", recvID: "failure-owner", sessionType: 1, contentType: 101, textElem: { content: "在吗？" }, clientMsgID: `failure-regression-${textDelivery}-${index}`, sendTime: Date.now(), senderNickname: "访客", senderPlatformID: 5, ex: JSON.stringify({infiai:{nextSuggestionsVersion:1}}) } as any);
          assert.deepEqual(errors, []);
          assert.equal(sent.length, 1);
          assert.equal(sent[0].recvID, "failure-visitor");
          if (index === 8) {
            assert.equal(sent[0].message.contentType,102);
            assert.equal(JSON.parse(sent[0].message.ex).infiai.messageKind,"assistant_reply");
            return;
          }
          assert.equal(sent[0].message.textElem.content, index < 3 ? notice : index === 4 ? "一、这是重点。\n解释说明。" : index === 5 ? "前文\n```ts\nconst x = '**代码**';\n```\n后文" : index === 6 ? FRIENDLY_CONTENT_REJECTION : index === 7 ? "你更想从哪个角度聊聊？" : payload);
          assert.equal(JSON.parse(sent[0].message.ex).infiai.messageKind, index < 3 || index > 5 ? "model_error" : "assistant_reply");
          assert.equal(dispatchCalls, [2, 6, 7].includes(index) ? 2 : 1);
          if (index < 3 || index > 5) assert.deepEqual(planned, []);
          if ([2, 6, 7].includes(index)) {
            for (const processTurn of [processOpenPlatformMessage, processIncognitoMessage]) {
              dispatchCalls = 0;
              const result = await processTurn(api, client as any, {
                ownerUserID: "failure-owner", agentID: "default", sourceUserID: "failure-visitor",
                conversationID: `recovery-${textDelivery}-${index}`, messageID: `buffered-${textDelivery}-${index}`,
                messageType: "text", text: "在吗？",
              });
              assert.equal(result.replyText, index === 6 ? FRIENDLY_CONTENT_REJECTION : index === 7 ? "你更想从哪个角度聊聊？" : notice);
              assert.equal(dispatchCalls, 2);
              assert.equal(result.billing?.chargeUnits, 0);
              assert.ok(result.warnings?.includes("interactive_no_reply_fallback"));
            }
          }
        });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
