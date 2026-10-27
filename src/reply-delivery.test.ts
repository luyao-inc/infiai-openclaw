import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverReplyPlan,
  ReplyCancellationScopes,
  waitForReply,
  InboundReplyTurn,
} from "./reply-delivery";
const parts = ["甲", "乙", "丙"].map((text, i) => ({
  text,
  messageID: String(i),
  status: "pending",
}));
const config = {
  version: 1 as const,
  mode: "auto" as const,
  pacing: "natural" as const,
};
test("send, confirm, delay and next send are strictly ordered", async () => {
  const events: string[] = [];
  const result = await deliverReplyPlan(parts, config, {
    canSend: async () => true,
    start: async (i) => (events.push("start" + i), true),
    send: async (_, i) => {
      events.push("send" + i);
    },
    confirm: async (i) => {
      events.push("ack" + i);
    },
    wait: async () => {
      events.push("wait");
    },
  });
  assert.deepEqual(result, ["甲", "乙", "丙"]);
  assert.deepEqual(events, [
    "start0",
    "send0",
    "ack0",
    "wait",
    "start1",
    "send1",
    "ack1",
    "wait",
    "start2",
    "send2",
    "ack2",
  ]);
});
test("stop during an interval sends no tail", async () => {
  const ctl = new AbortController(),
    sent: string[] = [];
  await deliverReplyPlan(parts, config, {
    signal: ctl.signal,
    canSend: async () => true,
    start: async () => true,
    send: async (p) => {
      sent.push(p.text);
    },
    confirm: async () => {},
    wait: async () => {
      ctl.abort();
    },
  });
  assert.deepEqual(sent, ["甲"]);
});
test("a transport failure never retries or sends a fallback", async () => {
  const sent: string[] = [];
  await assert.rejects(
    deliverReplyPlan(parts, config, {
      canSend: async () => true,
      start: async () => true,
      send: async (p) => {
        sent.push(p.text);
        if (p.text === "乙") throw Error("unknown");
      },
      confirm: async () => {},
      wait: async () => {},
    })
  );
  assert.deepEqual(sent, ["甲", "乙"]);
});
test("expired eligibility stops before start and no pacing still serializes", async () => {
  let n = 0;
  const sent: string[] = [];
  await deliverReplyPlan(
    parts,
    { ...config, pacing: "none" },
    {
      canSend: async () => ++n < 2,
      start: async () => true,
      send: async (p) => {
        sent.push(p.text);
      },
      confirm: async () => {},
      wait: async () => {
        throw Error("unexpected wait");
      },
    }
  );
  assert.deepEqual(sent, ["甲"]);
});
test("stop cancels active and queued visitor turns without affecting others or future turns", () => {
  const scopes = new ReplyCancellationScopes(),
    a = scopes.enter("group", "a"),
    b = scopes.enter("group", "b"),
    queued = scopes.enter("group", "a");
  scopes.stop("group", "a");
  assert.ok(a.signal.aborted && queued.signal.aborted);
  assert.ok(!b.signal.aborted);
  const next = scopes.enter("group", "a");
  assert.ok(!next.signal.aborted);
  for (const x of [a, b, queued, next]) x.leave();
});
test("waiting is interruptible", async () => {
  const c = new AbortController();
  const p = waitForReply(10000, c.signal);
  c.abort();
  await assert.rejects(p, /cancelled/);
});
test("lost confirmation is retried without resending a message", async () => {
  let confirms = 0;
  const turn = new InboundReplyTurn(async (_path, req) => {
    if (req.action === "begin")
      return {
        acquired: true,
        textDelivery: true,
        turnID: "turn",
        token: "token",
        config,
      };
    if (req.action === "sent" && ++confirms === 1) throw Error("response lost");
    return {};
  }, {});
  await turn.begin();
  await turn.confirm(0, parts[0]);
  await turn.finish();
  assert.equal(confirms, 2);
});

test("definitely unsent retries only the current part, at most three attempts", async () => {
  const { ReplyNotSentError } = await import("./reply-delivery");
  let attempts = 0;
  const sent: string[] = [],
    acks: string[] = [];
  await deliverReplyPlan(parts, config, {
    canSend: async () => true,
    start: async () => true,
    send: async (p) => {
      if (p.text === "乙" && attempts++ < 1)
        throw new ReplyNotSentError("local create failed");
      sent.push(p.text);
    },
    confirm: async (_, p) => {
      acks.push(p.messageID);
    },
    notSent: async () => {},
    wait: async () => {},
  });
  assert.deepEqual(sent, ["甲", "乙", "丙"]);
  assert.deepEqual(acks, ["0", "1", "2"]);
  assert.equal(attempts, 2);
  let failures = 0;
  await assert.rejects(
    deliverReplyPlan(parts, config, {
      canSend: async () => true,
      start: async () => true,
      send: async () => {
        failures++;
        throw new ReplyNotSentError("not sent");
      },
      confirm: async () => {},
      notSent: async () => {},
      wait: async () => {},
    })
  );
  assert.equal(failures, 3);
});
test("an old replayed stop does not cancel a newer local turn", () => {
  const s = new ReplyCancellationScopes(),
    old = s.enter("lane", "a", 100),
    newer = s.enter("lane", "a", 300);
  s.stop("lane", "a", 200);
  assert.ok(old.signal.aborted);
  assert.ok(!newer.signal.aborted);
  old.leave();
  newer.leave();
});

// Each attempt needs one fresh server decision, including attempts after pacing.
test("one eligibility request per send attempt, with fresh checks after pacing", async () => {
 let checks = 0; const sent: string[] = [];
 await deliverReplyPlan(parts, config, {
  canSend: async () => ++checks < 2, start: async () => true,
  send: async p => { sent.push(p.text); }, confirm: async () => {}, wait: async () => {},
 });
 assert.deepEqual(sent, ["甲"]); assert.equal(checks, 2);
});
