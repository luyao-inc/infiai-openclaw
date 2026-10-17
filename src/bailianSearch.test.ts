import test from "node:test";
import assert from "node:assert/strict";
import { createBailianSearchProvider } from "./bailianSearch";

const completed = {
  id: "test-response", status: "completed", usage: { x_tools: { web_search: { count: 1 } } },
  output: [
    { type: "web_search_call", status: "completed", action: { sources: [{ url: "https://help.aliyun.com/doc" }, { url: "javascript:bad" }, { url: "https://help.aliyun.com/doc" }] } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "找到官方说明。" }] },
  ],
};

test("native search uses the same model, requires real search events, caches without new charges", async () => {
  process.env.BAILIAN_TEXT_API_KEY = "test-secret";
  process.env.BAILIAN_TEXT_BASE_URL = "https://example.invalid/compatible-mode/v1";
  process.env.BAILIAN_TEXT_MODEL = "deepseek-v4.1-flash";
  let requests = 0;
  const provider = createBailianSearchProvider((async (url, init) => {
    requests++;
    assert.equal(url, "https://example.invalid/compatible-mode/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.model, "deepseek-v4.1-flash");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.equal(body.max_tool_calls, 1);
    return Response.json(completed);
  }) as typeof fetch);
  const tool = provider.createTool();
  const resolvedSearchConfig = {};
  assert.doesNotThrow(() => provider.setCredentialValue(resolvedSearchConfig, "test-secret"));
  assert.deepEqual(resolvedSearchConfig, {});
  const result = await tool.execute({ query: "官方文档", count: 3 });
  assert.equal(result.count, 1);
  assert.equal(result.billingPolicy, "display-only-no-user-charge");
  assert.equal((await tool.execute({ query: "官方文档", count: 3 })).cached, true);
  assert.equal(requests, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(tool.execute({ query: "官方文档" }, { signal: cancelled.signal }), /abort/i);
  await assert.rejects(tool.execute({ query: "" }), /Invalid/);
});

test("incomplete, source-free and HTTP failures cannot become fabricated search success", async () => {
  process.env.BAILIAN_TEXT_API_KEY = "test-secret";
  process.env.BAILIAN_TEXT_BASE_URL = "https://example.invalid/compatible-mode/v1";
  for (const response of [Response.json({ ...completed, status: "incomplete" }), Response.json({ status: "completed", output: [] }), new Response("secret upstream body", { status: 401 })]) {
    const tool = createBailianSearchProvider((async () => response) as typeof fetch).createTool();
    await assert.rejects(tool.execute({ query: "测试" }), (error: any) => !error.message.includes("secret upstream body"));
  }
});
