import test from "node:test";
import assert from "node:assert/strict";
import { createSonarSearchProvider } from "./sonarSearch";
import { registerSearchPolicyHooks, WEB_SEARCH_POLICY } from "./searchPolicy";

const completed = {
  id: "test-response", usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20 }, cost: 0.005 },
  choices: [{ finish_reason: "stop", message: { content: "官方通报[2]。", annotations: [
    { type: "url_citation", url_citation: { url: "https://example.com/first", title: "First" } },
    { type: "url_citation", url_citation: { url: "https://example.com/official", title: "官方通报" } },
  ] } }],
};

test("Sonar search preserves full numbered citations and isolated usage, without stale local cache", async () => {
  process.env.OPENROUTER_API_KEY = "test-secret";
  let requests = 0;
  const provider = createSonarSearchProvider((async (url, init) => {
    requests++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "perplexity/sonar");
    assert.equal(body.messages[1].content, "公开事件");
    assert.equal(body.messages.length, 2);
    assert.equal(body.max_tokens, 2048);
    assert.match(body.messages[0].content, /当前 UTC 时间：\d{4}-\d{2}-\d{2}T/);
    assert.match(body.messages[0].content, /检索资料助手/);
    assert.doesNotMatch(body.messages[0].content, /300字以内/);
    return Response.json(completed);
  }) as typeof fetch);
  const config = {};
  provider.setCredentialValue(config, "test-secret");
  assert.deepEqual(config, {});
  const tool = provider.createTool();
  const result = await tool.execute({ query: "公开事件", count: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.citations[1].url, "https://example.com/official");
  assert.equal(result.auxiliaryUsage.input, 80);
  assert.equal(result.auxiliaryUsage.cacheRead, 20);
  assert.equal(result.auxiliaryUsage.costUSD, 0.005);
  assert.equal(result.billingPolicy, "display-only-no-user-charge");
  assert.equal(result.coverageNote, undefined);
  assert.ok(result.answer.includes("[2]"));
  await tool.execute({ query: "公开事件", count: 1 });
  assert.equal(requests, 2);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(tool.execute({ query: "公开事件" }, { signal: cancelled.signal }), /abort/i);
  await assert.rejects(tool.execute({ query: "", count: 2 }), /Invalid/);
  await assert.rejects(tool.execute({ query: "公开事件", count: "2" }), /Invalid/);
});

test("citation fallback preserves source numbers, filters unsafe URLs, and rejects unmapped citations", async () => {
  const data = { ...completed, citations: ["javascript:bad", "https://example.com/official", "https://user:pass@example.com/"] };
  const tool = createSonarSearchProvider((async () => Response.json(data)) as typeof fetch).createTool();
  const result = await tool.execute({ query: "公开事件" });
  assert.deepEqual(result.citations.map((s) => s.citation), [2]);
  data.choices = [{ finish_reason: "stop", message: { content: "通报[1]", annotations: [] } }];
  await assert.rejects(tool.execute({ query: "公开事件" }), /unmapped citation/);
});

test("incomplete, source-free and HTTP failures cannot become fabricated search success", async () => {
  for (const response of [Response.json({ ...completed, choices: [{ ...completed.choices[0], finish_reason: "length" }] }), Response.json({ choices: [{ finish_reason: "stop", message: { content: "No sources" } }] }), new Response("secret upstream body", { status: 401 })]) {
    const tool = createSonarSearchProvider((async () => response) as typeof fetch).createTool();
    await assert.rejects(tool.execute({ query: "公开事件" }), (error: any) => !error.message.includes("secret upstream body"));
  }
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(createSonarSearchProvider().createTool().execute({ query: "公开事件" }), /requires OPENROUTER_API_KEY/);
});

test("central search policy uses supported system context hook without making a classifier request", () => {
  let registered: any;
  registerSearchPolicyHooks({ on: (name: string, handler: any) => { assert.equal(name, "before_prompt_build"); registered = handler; } });
  const result = registered();
  const context = result.appendSystemContext;
  assert.match(context, /^当前 UTC 时间：\d{4}-\d{2}-\d{2}T/);
  assert.ok(context.endsWith(WEB_SEARCH_POLICY));
  assert.match(result.appendContext, /历史回复不作为本轮篇幅和格式模板/);
  assert.match(result.appendContext, /完整交付/);
});
