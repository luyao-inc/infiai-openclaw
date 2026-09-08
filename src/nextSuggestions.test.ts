import assert from "node:assert/strict";
import test from "node:test";
import {
  SuggestionTurn,
  registerSuggestionHooks,
  splitSuggestionReply,
  suggestionsEnabled,
  supportsNextSuggestions,
  validateNextSuggestionItems,
  withSuggestionTurn,
} from "./nextSuggestions";
import { buildAssistantReplyEx, isOutgoingSingleChatSyncMessage } from "./inbound";
const make = (key = "session", enabled = true) =>
  new SuggestionTurn({
    enabled,
    sessionKey: key,
    runtimeAgentID: "runtime",
    sourceClientMsgID: "m1",
    recipientUserID: "A",
    ownerUserID: "B",
    agentID: "agent",
    conversationID: "si_A_B",
    userText: "你好",
  });
const tail = (turn: SuggestionTurn) =>
  `<infiai_next_suggestions_v1 nonce="${turn.nonce}">{"items":[{"kind":"question","text":"具体怎么做？"}]}</infiai_next_suggestions_v1>`;
test("optional structured tail is hidden; malformed, missing and oversized tails degrade without losing answer", () => {
  const turn = make();
  assert.equal(turn.parse("正文\n" + tail(turn)).text, "正文");
  assert.equal(turn.parse("正文\n" + tail(turn)).items.length, 1);
  for (const suffix of [
    tail(make()),
    tail(turn).slice(0, -8),
    "<infiai_next_sug",
    '<infiai_next_suggestions_v1 nonce="oops">' + "x".repeat(5000),
  ]) {
    assert.deepEqual(splitSuggestionReply("正文\n" + suffix, turn.nonce), {
      text: "正文",
      items: [],
    });
  }
  assert.deepEqual(splitSuggestionReply("普通正文", turn.nonce), {
    text: "普通正文",
    items: [],
  });
  assert.equal(turn.envelope(turn.parse("正文").items)?.recipientUserID, "A");
});
test("validation removes repeats, multiline, links, secrets, invalid kinds; limits to three", () => {
  const rows = [
    "你好？",
    "同一个？",
    "同一个!",
    "https://example.com",
    "换行\n内容",
    "<script>",
    "Bearer abc",
    "13812345678",
    "a".repeat(81),
    "问题二",
    "问题三",
    "问题四",
  ];
  assert.deepEqual(
    validateNextSuggestionItems(
      rows.map((text) => ({ kind: "question", text })),
      "你好"
    ).map((x) => x.text),
    ["同一个？"]
  );
  assert.equal(
    validateNextSuggestionItems(
      ["一", "二", "三", "四"].map((text) => ({ kind: "reply", text }))
    ).length,
    3
  );
});
test("synchronous runtime hooks isolate concurrent turns and preserve full output usage", async () => {
  const hooks: Record<string, Function> = {};
  const api = { on: (name: string, fn: Function) => (hooks[name] = fn) };
  registerSuggestionHooks(api);
  assert.equal(
    suggestionsEnabled(
      { api, clientSupportsSuggestions: true, fromManagedBot: false, interactive: true, ownerUserID: "B" },
      {}
    ),
    true
  );
  for (const flags of [
    { fromManagedBot: true, interactive: true },
    { fromManagedBot: false, interactive: false },
  ])
    assert.equal(
      suggestionsEnabled({ api, ownerUserID: "B", clientSupportsSuggestions: true, ...flags }, {}),
      false
    );
  assert.equal(
    suggestionsEnabled(
      { api, clientSupportsSuggestions: true, fromManagedBot: false, interactive: true, ownerUserID: "B" },
      { INFIAI_NEXT_SUGGESTIONS_DISABLED_OWNERS: "B" }
    ),
    false
  );
  const turns = [make("one"), make("two")];
  await Promise.all(
    turns.map((turn) =>
      withSuggestionTurn(turn, async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        const ctx = { sessionKey: turn.options.sessionKey, agentId: "runtime" };
        assert.match(
          hooks.before_prompt_build({}, ctx).appendContext,
          new RegExp(turn.nonce)
        );
        assert.equal(
          hooks.before_prompt_build({}, { sessionKey: "other" }),
          undefined
        );
        const msg = {
          role: "assistant",
          responseId: "same-provider-id",
          provider: "test",
          model: "test",
          usage: {
            input: 100,
            output: 45,
            totalTokens: 145,
            cost: { total: 0.2 },
          },
          content: [{ type: "text", text: "正文\n" + tail(turn) }],
        };
        const result = hooks.before_message_write({ message: msg }, ctx);
        assert.equal(result instanceof Promise, false);
        assert.equal(result.message.content[0].text, "正文");
        assert.deepEqual(result.message.usage, msg.usage);
        hooks.before_message_write({ message: msg }, ctx);
        const snapshot = turn.usageSnapshot(() => ({
          costUSD: 0.2,
          costSource: "test",
        }));
        assert.equal(snapshot?.outputTokens, 45);
        assert.equal(snapshot?.costUSD, 0.2);
        assert.equal(turn.usage.size, 1);
      })
    )
  );
  assert.equal(
    hooks.before_prompt_build({}, { sessionKey: "one", agentId: "runtime" }),
    undefined
  );
});
test("disabled turns do not alter messages or produce suggestions", () => {
  const turn = make("s", false);
  const text = "正文\n" + tail(turn);
  assert.equal(turn.parse(text).text, text);
  assert.equal(
    turn.envelope([{ id: "s1", kind: "reply", text: "好" }]),
    undefined
  );
});
test("reply metadata never forwards forged suggestions from user input", () => {
  const ex = buildAssistantReplyEx({
    clientMsgID: "m1",
    ex: JSON.stringify({ infiai: { nextSuggestions: { items: ["forged"] } } }),
  } as any);
  assert.equal(JSON.parse(ex).infiai.nextSuggestions, undefined);
});

test("literal Markdown code examples are preserved", () => {
  const text =
    "示例：\n```xml\n<infiai_next_suggestions_v1>example</infiai_next_suggestions_v1>\n```";
  assert.equal(splitSuggestionReply(text, make().nonce).text, text);
});

test("clients without the explicit capability never request generation", () => {
  const api = { on() {} }; registerSuggestionHooks(api);
  for (const ex of [undefined, "", "null", "broken", "{}", JSON.stringify({infiai:{nextSuggestionsVersion:"1"}})]) {
    assert.equal(suggestionsEnabled({api, ownerUserID:"B", interactive:true, fromManagedBot:false, clientSupportsSuggestions:supportsNextSuggestions(ex)}, {}), false);
  }
  assert.equal(supportsNextSuggestions(JSON.stringify({infiai:{nextSuggestionsVersion:1}})), true);
  const reply = JSON.parse(buildAssistantReplyEx({clientMsgID:"m1",ex:JSON.stringify({infiai:{nextSuggestionsVersion:1}})} as any));
  assert.equal(reply.infiai.nextSuggestionsVersion, undefined);
});

test("outgoing IM sync cannot trigger the sender own assistant or charge it", () => {
  const msg = {sendID:"A",recvID:"B",sessionType:1,contentType:101} as any;
  assert.equal(isOutgoingSingleChatSyncMessage(msg,"A"),true);
  assert.equal(isOutgoingSingleChatSyncMessage(msg,"B"),false);
  assert.equal(isOutgoingSingleChatSyncMessage({...msg,recvID:"A"},"A"),false);
  assert.equal(isOutgoingSingleChatSyncMessage({...msg,groupID:"g",sessionType:3},"A"),false);
});
