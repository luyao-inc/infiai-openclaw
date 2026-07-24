import assert from "node:assert/strict";
import test from "node:test";
import { scheduledTaskToolBlockReason } from "./index";

test("scheduled task guard blocks stateful runtime tools", () => {
  assert.match(
    scheduledTaskToolBlockReason({ toolName: "exec" }, { sessionKey: "agent:a:task:ctr_1" }),
    /only allowed/,
  );
  assert.match(
    scheduledTaskToolBlockReason({ toolName: "sessions_spawn" }, { sessionKey: "agent:a:task:ctr_1" }),
    /not allowed/,
  );
  assert.match(
    scheduledTaskToolBlockReason({ toolName: "infiai_send_file" }, { sessionKey: "agent:a:task:ctr_1" }),
    /not allowed/,
  );
  assert.match(
    scheduledTaskToolBlockReason({ toolName: "infiai_send_image" }, { sessionKey: "agent:a:task:ctr_1" }),
    /not allowed/,
  );
  assert.match(
    scheduledTaskToolBlockReason({ toolName: "infiai_send_video" }, { sessionKey: "agent:a:task:ctr_1" }),
    /not allowed/,
  );
});

test("scheduled task guard allows only audited read-only skill exec commands", () => {
  const task = { sessionKey: "agent:a:task:ctr_1:attempt:1" };
  for (const command of [
    'cd ~/.openclaw/skills/serper && python3 scripts/search.py -q "今日加密货币新闻" --mode current --gl cn --hl zh 2>/dev/null',
    'python3 "/root/.openclaw/skills/crypto-market/crypto_market_snapshot.py" BTCUSDT 1d 200',
  ]) {
    assert.equal(
      scheduledTaskToolBlockReason({ toolName: "exec", params: { command } }, task),
      "",
      command,
    );
  }
  for (const command of [
    "rm -rf /tmp/example",
    'cd ~/.openclaw/skills/serper && python3 scripts/search.py -q "news"; id',
    'cd ~/.openclaw/skills/serper && python3 scripts/search.py -q "$(id)"',
    'python3 "/root/.openclaw/skills/crypto-market/crypto_market_snapshot.py" BTCUSDT 1d 200 > /tmp/result',
    'cd ~/.openclaw/skills/serper && python3 scripts/search.py -q "news" --unknown value',
  ]) {
    assert.match(
      scheduledTaskToolBlockReason({ toolName: "exec", params: { command } }, task),
      /only allowed/,
      command,
    );
  }
});

test("scheduled task guard allows read tools and does not affect normal chats", () => {
  assert.equal(
    scheduledTaskToolBlockReason({ toolName: "web_search" }, { sessionKey: "agent:a:task:ctr_1" }),
    "",
  );
  assert.equal(
    scheduledTaskToolBlockReason({ toolName: "exec" }, { sessionKey: "agent:a:infiai:dm:u1" }),
    "",
  );
  assert.equal(
    scheduledTaskToolBlockReason({ toolName: "infiai_send_text" }, { sessionKey: "agent:a:task:ctr_1" }),
    "",
  );
  assert.equal(
    scheduledTaskToolBlockReason({ toolName: "infiai_apply_friends" }, { sessionKey: "agent:a:task:ctr_1" }),
    "",
  );
  assert.equal(
    scheduledTaskToolBlockReason({ toolName: "infiai_apply_groups" }, { sessionKey: "agent:a:task:ctr_1" }),
    "",
  );
});
