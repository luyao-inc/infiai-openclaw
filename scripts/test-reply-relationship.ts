// Local transport acceptance: real OpenIM SDK + Chat HTTP ledger, synthetic accounts.
import "../src/polyfills";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { getSDK, LogLevel } from "@openim/client-sdk";
import { InboundReplyTurn, deliverReplyPlan } from "../src/reply-delivery";
import { sendTextToTarget, sendVoiceToTarget } from "../src/media";

const fixture = process.env.INFIAI_RELATIONSHIP_QA_FIXTURE;
if (!fixture) throw Error("local synthetic fixture required");
const f = JSON.parse(readFileSync(fixture, "utf8"));
const chat = process.env.INFIAI_RELATIONSHIP_QA_CHAT!;
const secret = process.env.INFIAI_RELATIONSHIP_QA_SECRET!;
for (const address of [chat, f.imURL, f.wsURL])
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(address).hostname), "local endpoints required");
const sdk = getSDK();
const humanMessageID = randomUUID();
const config = { version: 1 as const, mode: "auto" as const, pacing: "none" as const };
const identity = { ownerUserID: f.owner.userID, agentID: "default", accountId: `acc_default__${f.owner.userID}__default`, actorUserID: f.peer.userID, conversationID: `si_${[f.owner.userID, f.peer.userID].sort().join("_")}` };
async function im(path: string, body: unknown) {
  const response = await fetch(f.imURL + path, { method: "POST", headers: { "Content-Type": "application/json", token: f.adminIMToken, operationID: randomUUID() }, body: JSON.stringify(body) });
  const result = await response.json() as any;
  assert.equal(result.errCode, 0, path + " error " + result.errCode);
  return result.data;
}
async function rpc(path: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const response = await fetch(chat + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Claw-Signature": createHmac("sha256", secret).update(raw).digest("hex"), operationID: randomUUID() }, body: raw });
  const result = await response.json() as any;
  assert.equal(response.status, 200, "Chat transport error");
  if ("errCode" in result) assert.equal(result.errCode, 0, "Chat business error " + result.errCode);
  return "data" in result ? result.data : result;
}
async function login(platformID: number) {
  await sdk.login({ userID: f.owner.userID, token: platformID === 12 ? f.owner.botToken : f.owner.webToken, platformID, apiAddr: f.imURL, wsAddr: f.wsURL, logLevel: LogLevel.Silent, isLogStandardOutput: false });
}
async function reply(source: string, rejectionCode = 0, voice = false) {
  const turn = new InboundReplyTurn(rpc, { ...identity, sourceMsgID: source, sourceTime: Date.now() });
  assert.ok(await turn.begin());
  // No model is called in this transport test, so no model billing or memory payload.
  const plan = await turn.plan([source + " first", source + " tail"], undefined as any, undefined as any);
  const send = () => deliverReplyPlan(plan, config, {
    canSend: () => turn.canSend(), start: i => turn.start(i),
    send: async p => {
      if (voice) await sendVoiceToTarget({ sdk } as any, { kind: "user", id: f.peer.userID }, { sourceUrl: chat + "/qa.wav", duration: 1, dataSize: 32044, soundType: "wav" }, { clientMsgID: p.messageID });
      else await sendTextToTarget({ sdk } as any, { kind: "user", id: f.peer.userID }, p.text, { clientMsgID: p.messageID });
    },
    confirm: (i, p) => turn.confirm(i, p), notSent: i => turn.notSent(i), failed: (i, code) => turn.failed(i, code),
  });
  try {
    if (rejectionCode) await assert.rejects(send, (error: any) => error?.errCode === rejectionCode);
    else assert.equal((await send()).length, 2);
  } finally { await turn.finish(); }
}
try {
  const initial = await im("/friend/is_friend", { userID1: f.owner.userID, userID2: f.peer.userID });
  if (initial.inUser1Friends) await im("/friend/delete_friend", { ownerUserID: f.owner.userID, friendUserID: f.peer.userID });
  if (initial.inUser2Friends) await im("/friend/delete_friend", { ownerUserID: f.peer.userID, friendUserID: f.owner.userID });
  await login(12);
  await reply("qa-not-friends", 1303);
  await reply("qa-voice-not-friends", 1303, true);
  await sdk.logout();
  await login(5);
  await assert.rejects(() => sendTextToTarget({ sdk } as any, { kind: "user", id: f.peer.userID }, "human denied"), (error: any) => error?.errCode === 1303);
  // The normal application + auto-accept callback establishes the relationship.
  await im("/friend/add_friend", { fromUserID: f.peer.userID, toUserID: f.owner.userID, reqMsg: "local relationship regression" });
  for (let i = 0; ; i++) {
    const state = await im("/friend/is_friend", { userID1: f.owner.userID, userID2: f.peer.userID });
    if (state.inUser1Friends && state.inUser2Friends) break;
    assert.ok(i < 40, "auto-accepted friendship did not become visible");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await sendTextToTarget({ sdk } as any, { kind: "user", id: f.peer.userID }, "qa-human-after-accept", { clientMsgID: humanMessageID });
  await sdk.logout();
  await login(12);
  await reply("qa-friends");
  await reply("qa-voice-friends", 0, true);
  // A real one-way deletion must still prevent the owner's next reply.
  await im("/friend/delete_friend", { ownerUserID: f.peer.userID, friendUserID: f.owner.userID });
  await reply("qa-deleted-friend", 1303);
  await im("/friend/import_friend", { ownerUserID: f.owner.userID, friendUserIDs: [f.peer.userID] });
  await im("/friend/add_black", { ownerUserID: f.peer.userID, blackUserID: f.owner.userID });
  try { await reply("qa-blocked", 1302); }
  finally { await im("/friend/remove_black", { ownerUserID: f.peer.userID, blackUserID: f.owner.userID }); }
  console.log(JSON.stringify({ nonfriendBotRejected: true, nonfriendHumanRejected: true, normalAutoAccept: true, humanSent: true, botPartsSent: 4, voiceTransportVerified: true, deletedFriendRejected: true, blacklistRejected: true, humanMessageID }));
} finally { await sdk.logout().catch(() => {}); }
