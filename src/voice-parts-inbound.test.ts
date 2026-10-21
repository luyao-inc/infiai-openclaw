import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processInboundMessage } from "./inbound";
import { registerSuggestionHooks } from "./nextSuggestions";

// Real inbound -> planner -> TTS -> SDK delivery; only external services are substituted.
test("voice uses planned parts, silent text fallback, stable IDs and stop checks", async (t) => {
 const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lingxie-voice-parts-"));
 const originalFetch = globalThis.fetch;
 try {
  await fs.mkdir(path.join(workspace, ".openclaw"));
  await fs.writeFile(path.join(workspace, ".openclaw/workspace-state.json"), JSON.stringify({automationMode:"always",conversationMemoryEnabled:false}));
  const accountId="acc_default__voice-owner__default", agentId="mg_default__voice-owner__default";
  const cfg={agents:{list:[{id:agentId,workspace}]},channels:{infiai:{accounts:{[accountId]:{enabled:true,userID:"voice-owner"}}}},bindings:[{agentId,match:{channel:"infiai",accountId}}]};
  for(const scenario of ["voice", "mixed", "stop"]){
   await t.test(scenario, async()=>{
    const sent:any[]=[], synthesis:any[]=[], warnings:string[]=[];
    let planned:any[]=[], stopped=false, prompt="";
    globalThis.fetch=async(input,init)=>{
     const url=String(input); assert.ok(url.startsWith("http://voice-test.invalid/"),url);
     const body=JSON.parse(String(init?.body||"{}"));
     let data:any={allowed:!stopped,active:false};
     if(url.endsWith("/memory/context")) data={contextText:""};
     if(url.endsWith("/reply-delivery/turn")){
      if(body.action==="plan") planned=body.parts.map((text:string,i:number)=>({text,messageID:`${scenario}-part-${i}`,status:"pending",attempts:1}));
      data={acquired:true,textDelivery:true,voiceReplyEnabled:true,turnID:`turn-${scenario}`,token:"token",enabled:true,config:{version:1,mode:"auto",pacing:"natural"},parts:planned,send:true};
     }
     if(url.endsWith("/agent-voice/synthesize")){
      synthesis.push(body);
      if(scenario==="stop")stopped=true;
      if(scenario==="mixed"&&synthesis.length===2) return new Response(JSON.stringify({errCode:500,errMsg:"ServerInternalError",errDlt:"synthetic provider finish timed out"}),{status:500});
      data={enabled:true,audioURL:"https://example.com/voice.wav",duration:4,transcript:body.text,contentType:"audio/wav"};
     }
     return new Response(JSON.stringify({errCode:0,data}),{status:200});
    };
    const parts=["第一段完整回答。","第二段完整回答。","第三段完整回答。"];
    const api={config:cfg,on:()=>{},logger:{info:()=>{},warn:(s:string)=>warnings.push(s),error:()=>{}},runtime:{channel:{routing:{resolveAgentRoute:()=>({agentId,matchedBy:"binding"})},reply:{dispatchReplyWithBufferedBlockDispatcher:async({ctx,dispatcherOptions}:any)=>{
     prompt=ctx.GroupSystemPrompt;
     await dispatcherOptions.deliver({text:parts.join("\n<<<LINGXIE_MESSAGE>>>\n")},{kind:"final"});
    }}}}};
    registerSuggestionHooks(api);
    const client={config:{accountId,userID:"voice-owner",inboundWhitelist:[],requireMention:true,chatApiAddr:"http://voice-test.invalid"},gatewayConfig:cfg,sdk:{
     createTextMessage:async(text:string)=>({data:{contentType:101,textElem:{content:text}}}),
     createSoundMessageByURL:async(sound:any)=>({data:{contentType:103,soundElem:sound}}),
     sendMessage:async(value:any)=>{sent.push(value);return{data:{clientMsgID:value.message.clientMsgID}};},
    }};
    const started=Date.now();
    await processInboundMessage(api,client as any,{sendID:"voice-visitor",recvID:"voice-owner",sessionType:1,contentType:101,textElem:{content:"为什么你一会儿和我文字，一会儿和我语音呢"},clientMsgID:`source-${scenario}`,sendTime:Date.now(),senderPlatformID:5,ex:JSON.stringify({infiai:{nextSuggestionsVersion:1}})} as any);
    assert.match(prompt,/本轮已开启语音回复/);
    assert.match(prompt,/不得断言自己没有发过语音/);
    assert.match(prompt,/LINGXIE_MESSAGE/);
    if(scenario==="stop"){assert.equal(sent.length,0);assert.equal(synthesis.length,1);return;}
    assert.equal(sent.length,3);
    assert.ok(Date.now()-started<1800,"voice must not add text pacing delays");
    assert.deepEqual(synthesis.map(x=>x.text),parts);
    assert.deepEqual(synthesis.map(x=>x.sourceMsgID),planned.map(x=>x.messageID));
    assert.deepEqual(sent.map(x=>x.message.clientMsgID),planned.map(x=>x.messageID));
    assert.deepEqual(sent.map(x=>x.message.contentType),scenario==="mixed"?[103,101,103]:[103,103,103]);
    for(const [i,value] of sent.entries()){
     const ex=JSON.parse(value.message.ex).infiai;
     assert.equal(ex.partIndex,i);assert.equal(ex.partCount,3);
     assert.equal(value.message.contentType===101?value.message.textElem.content:ex.transcript,parts[i]);
     assert.doesNotMatch(JSON.stringify(value.message),/ServerInternalError|synthetic provider|合成失败|降级|timed out/);
    }
    if(scenario==="mixed")assert.ok(warnings.some(s=>s.includes("synthetic provider finish timed out")),"internal details retained");
   });
  }
 } finally {globalThis.fetch=originalFetch;await fs.rm(workspace,{recursive:true,force:true});}
});
