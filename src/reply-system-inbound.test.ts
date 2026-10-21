import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInfiaiToolContext } from "./toolContext";
import { processInboundMessage } from "./inbound";

// Exercise the real OpenIM entrypoint up to dispatch; no network or model calls.
test("OpenIM dispatch separates system contracts from owner and visitor messages", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lingxie-prompt-test-"));
  const originalFetch = globalThis.fetch;
  const originalParts = process.env.INFIAI_REPLY_PARTS_ENABLED;
  process.env.INFIAI_REPLY_PARTS_ENABLED = "false";
  const requests: string[] = [];
  try {
    await fs.mkdir(path.join(workspace, ".openclaw"));
    await fs.writeFile(path.join(workspace, ".openclaw/workspace-state.json"), JSON.stringify({version:2,automationMode:"always",conversationMemoryEnabled:false}));
    const accountId = "acc_default__prompt-owner__default";
    const agentId = "mg_default__prompt-owner__default";
    const cfg = {agents:{list:[{id:agentId,workspace}]},channels:{infiai:{accounts:{[accountId]:{enabled:true,userID:"prompt-owner"}}}},bindings:[{agentId,match:{channel:"infiai",accountId}}]};
    globalThis.fetch = async (input) => {
      const url = String(input); requests.push(url);
      assert.ok(url.startsWith("http://prompt-test.invalid/"), url);
      const data = url.endsWith("/memory/context") ? {contextText:"[Infiai Long-Term Memory Context]\n- 用户喜欢科幻电影\n[End Infiai Long-Term Memory Context]"} : url.endsWith("/reply-delivery/turn") ? {acquired:true,textDelivery:true,turnID:"test-turn",token:"test-token",enabled:false,config:{version:1,mode:"single",pacing:"none"}} : {allowed:true};
      return new Response(JSON.stringify({errCode:0,data}), {status:200});
    };
    const captured: any[] = [];
    const api = {config:cfg,logger:{warn:()=>{},info:()=>{},error:()=>{}},runtime:{channel:{routing:{resolveAgentRoute:()=>({agentId,matchedBy:"binding"})},reply:{dispatchReplyWithBufferedBlockDispatcher:async ({ctx}:any)=>{captured.push({...ctx,trustedMemoryForTest:getInfiaiToolContext()?.memoryContext});throw new Error("test stops before model generation");}}}}};
    const client = {config:{accountId,userID:"prompt-owner",inboundWhitelist:[],requireMention:true,chatApiAddr:"http://prompt-test.invalid"},gatewayConfig:cfg,sdk:{}};
    for (const sender of ["prompt-owner", "prompt-visitor"]) {
      await processInboundMessage(api, client as any, {sendID:sender,recvID:"prompt-owner",sessionType:1,contentType:101,textElem:{content:"你好"},clientMsgID:"prompt-system-"+sender,sendTime:Date.now(),senderNickname:sender,senderPlatformID:5,ex:JSON.stringify({infiai:{source:sender==="prompt-owner"?"infiai_human_self_assistant":""}})} as any);
    }
    for (const mentioned of [true, false]) {
      await processInboundMessage(api, client as any, {sendID:"prompt-visitor",recvID:"prompt-owner",groupID:"prompt-group",sessionType:3,contentType:106,atTextElem:{text:"你好",atUserList:mentioned?["prompt-owner"]:[]},clientMsgID:"prompt-group-"+mentioned,sendTime:Date.now(),senderNickname:"访客",senderPlatformID:5} as any);
    }
    assert.equal(captured.length, 3, JSON.stringify(requests));
    assert.equal(captured[2].InfiaiContext.currentChatType, "group");
    for (const [i, ctx] of captured.entries()) {
      assert.match(ctx.GroupSystemPrompt, /Infiai Interactive Reply Contract/);
      assert.doesNotMatch(ctx.GroupSystemPrompt, /LINGXIE_MESSAGE/);
      assert.doesNotMatch(ctx.BodyForAgent, /Interactive Reply Contract|Reply delivery contract|<<<LINGXIE_MESSAGE>>>/);
      assert.doesNotMatch(ctx.BodyForAgent, /用户喜欢科幻电影/);
      assert.match(ctx.trustedMemoryForTest, /用户喜欢科幻电影/);
      assert.equal(ctx.GroupSystemPrompt.includes("本轮为访客对话"), i !== 0);
      assert.equal(ctx.InfiaiContext.ownerAuthorized, i === 0);
      assert.equal(ctx.InfiaiContext.socialTools, i === 0 ? "allowed" : "denied");
    }
    assert.notEqual(captured[0].SessionKey, captured[1].SessionKey);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParts === undefined) delete process.env.INFIAI_REPLY_PARTS_ENABLED; else process.env.INFIAI_REPLY_PARTS_ENABLED = originalParts;
    await fs.rm(workspace, {recursive:true,force:true});
  }
});
