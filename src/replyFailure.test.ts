import test from "node:test";
import assert from "node:assert/strict";
import { classifyReplyFailure, dispatchWithReplyRecovery, registerReplyFailureHooks, FRIENDLY_CONTENT_REJECTION, FRIENDLY_REPLY_FAILURE } from "./replyFailure";

function setup() {
  const hooks: Record<string, any> = {};
  const api = { on: (name: string, handler: any) => { hooks[name] = handler; }, logger: { info() {}, warn() {} } };
  registerReplyFailureHooks(api);
  const delivered: string[] = [];
  const options = {
    ctx: { SessionKey: "agent:a:infiai:direct:owner:visitor", MessageSid: "message", RawBody: "原始问题", BodyForAgent: "原始问题", InfiaiContext: { ownerAuthorized: false } },
    cfg: { agents: { list: [{ id: "a" }], defaults: { models: { model: { params: { response_format: { type: "json_object" } } } } } }, tools: { allow: ["web_search"] } },
    dispatcherOptions: { deliver: async (payload: any) => { delivered.push(payload.text); } },
    replyOptions: { disableBlockStreaming: true },
  };
  return { api, hooks, options, delivered };
}

test("raw provider rejection takes priority over generic schema wording", () => {
  assert.equal(classifyReplyFailure("400 Input text data may contain inappropriate content."), "content_rejected");
  assert.equal(classifyReplyFailure("content_filter"), "content_rejected");
  assert.equal(classifyReplyFailure("HTTP 503"), "transient");
  assert.equal(classifyReplyFailure("401 authentication failed"), "invalid_request");
  assert.equal(classifyReplyFailure("provider rejected the request schema or tool payload"), "invalid_request");
});

test("normal success has no extra model call; discussion of errors stays normal prose", async () => {
  const { api, options, delivered } = setup(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async (o) => { calls++; await o.dispatcherOptions.deliver({ text: "我们讨论内容审核的设计，以及 HTTP 协议。" }, { kind: "final" }); }, options);
  assert.equal(calls, 1); assert.deepEqual(result, {}); assert.equal(delivered.length, 1);
});

test("one isolated recovery keeps input and actor; blocks tools and preserves raw failure marker", async () => {
  const { api, hooks, options, delivered } = setup(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async (o) => {
    calls++;
    const ctx = { agentId: "a", sessionKey: o.ctx.SessionKey };
    if (calls === 1) {
      const marked = hooks.before_message_write({ message: { role: "assistant", stopReason: "error", errorMessage: "400 Input text data may contain inappropriate content.", content: [{ type: "text", text: "[assistant turn failed before producing content]" }], usage: { totalTokens: 12 } } }, ctx);
      assert.deepEqual(marked.message.content, []); assert.equal(marked.message.infiaiFailure, true); assert.equal(marked.message.usage.totalTokens, 12);
      await o.dispatcherOptions.deliver({ text: "LLM request failed: provider rejected the request schema or tool payload." }, { kind: "final" });
      return;
    }
    assert.match(o.ctx.SessionKey, /:ephemeral:recovery:/);
    assert.equal(o.ctx.BodyForAgent, options.ctx.BodyForAgent);
    assert.deepEqual(o.ctx.InfiaiContext, options.ctx.InfiaiContext);
    assert.deepEqual(o.cfg.tools.deny, ["*"]);
    assert.equal(o.cfg.agents.defaults.models.model.params.response_format, undefined);
    assert.match(hooks.before_prompt_build({}, ctx).appendSystemContext, /不绕过任何审核/);
    await o.dispatcherOptions.deliver({ text: "你更想了解哪一方面？" }, { kind: "final" });
  }, options);
  assert.equal(calls, 2); assert.equal(result.recovered, true); assert.equal(result.kind, "content_rejected");
  assert.equal(result.failureReply, "你更想了解哪一方面？"); assert.deepEqual(delivered, []);
  assert.ok(options.cfg.agents.defaults.models.model.params.response_format);
});

test("repeated content refusal ends in friendly fixed text, without recursive retries", async () => {
  const { api, hooks, options } = setup(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async (o) => {
    calls++; hooks.before_message_write({ message: { role: "assistant", stopReason: "error", errorMessage: "400 Input text data may contain inappropriate content." } }, { sessionKey: o.ctx.SessionKey });
  }, options);
  assert.equal(calls, 2); assert.equal(result.failureReply, FRIENDLY_CONTENT_REJECTION); assert.equal(result.recovered, false);
});

test("transient failure has a single text-only recovery; schema/auth failure is not retried", async () => {
  for (const error of ["HTTP 503", "401 authentication failed", "400 invalid request"]) {
    const { api, options } = setup(); let calls = 0;
    const result = await dispatchWithReplyRecovery(api, async () => { calls++; throw new Error(error); }, options);
    assert.equal(calls, error === "HTTP 503" ? 2 : 1); assert.equal(result.failureReply, FRIENDLY_REPLY_FAILURE);
  }
});

test("already delivered answer and explicit silence are not retried", async () => {
  for (const text of ["已发送的答案", "NO_REPLY"]) {
    const { api, options } = setup(); let calls = 0;
    const result = await dispatchWithReplyRecovery(api, async (o) => { calls++; await o.dispatcherOptions.deliver({ text }, { kind: "final" }); o.dispatcherOptions.onError(new Error("HTTP 503"), {}); }, options);
    assert.equal(calls, 1); assert.deepEqual(result, {});
  }
});

test("stop cancels recovery; recovery tool attempts cannot produce a success notice", async () => {
  const { api, hooks, options } = setup(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async (o) => {
    calls++;
    if (calls === 1) throw new Error("HTTP 503");
    assert.equal(hooks.before_tool_call({ toolName: "infiai_send_text" }).block, true);
    await o.dispatcherOptions.deliver({ text: "已经替你发送。" }, { kind: "final" });
  }, options);
  assert.equal(result.failureReply, FRIENDLY_REPLY_FAILURE);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(dispatchWithReplyRecovery(api, async () => { throw new DOMException("stopped", "AbortError"); }, { ...options, replyOptions: { abortSignal: controller.signal } }), /stopped/);
});

test("concurrent conversations do not share refusal state", async () => {
  const { api, hooks, options } = setup();
  const results = await Promise.all(["one", "two"].map((id) => dispatchWithReplyRecovery(api, async (o) => {
    await new Promise(resolve => setTimeout(resolve, id === "one" ? 5 : 1));
    if (id === "one") hooks.before_message_write({ message: { role: "assistant", stopReason: "error", errorMessage: "400 Input text data may contain inappropriate content." } }, { sessionKey: o.ctx.SessionKey });
    else await o.dispatcherOptions.deliver({ text: "你好" }, { kind: "final" });
  }, { ...options, ctx: { ...options.ctx, SessionKey: id } })));
  assert.equal(results[0].failureReply, FRIENDLY_CONTENT_REJECTION); assert.deepEqual(results[1], {});
});

test("delivery uncertainty never starts another generation", async () => {
  const { api, options } = setup(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async (o) => {
    calls++;
    await o.dispatcherOptions.deliver({ text: "正常答案" }, { kind: "final" });
    o.dispatcherOptions.onError(new Error("connection reset"), { kind: "final" });
  }, options, () => false);
  assert.equal(calls, 1); assert.deepEqual(result, {});
});

test("parent stop bounds even a recovery dispatcher that ignores abort", async () => {
  const { api, options } = setup(); const controller = new AbortController(); let calls = 0;
  const result = await dispatchWithReplyRecovery(api, async () => {
    calls++;
    if (calls === 1) throw new Error("HTTP 503");
    controller.abort(); await new Promise(() => {});
  }, { ...options, replyOptions: { abortSignal: controller.signal } });
  assert.equal(calls, 2); assert.deepEqual(result, {});
});
