import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSuggestionReply, configureSuggestionResponse} from './suggestionProtocol';
import {SuggestionTurn} from './nextSuggestions';
const pack=(items:any[], reason='follow_up', answer='发票抬头错误需要重开发票。',nonce='n')=>JSON.stringify({answer,nextSuggestions:{nonce,reason,items}});
const item={kind:'question',text:'重开发票需要哪些资料？',anchor:'重开发票'};
test('JSON final produces grounded suggestions and rejects unrelated memory topic',()=>{
 const r=analyzeSuggestionReply(pack([item,{kind:'question',text:'文艺片有哪些推荐',anchor:'发票抬头'}]),'n','重开','json_object');
 assert.equal(r.status,'generated');assert.equal(r.items.length,1);assert.deepEqual(r.rejected,{off_topic:1});
});
test('explicit empty reasons are distinguished from generation failures',()=>{
 assert.equal(analyzeSuggestionReply(pack([]),'n','重开','json_object').status,'unexpected_empty');
 const r=analyzeSuggestionReply(pack([],'closing','不客气'),'n','谢谢','json_object');
 assert.equal(r.status,'intentionally_empty');assert.equal(r.reason,'closing');
 assert.equal(analyzeSuggestionReply(pack([],'complete','今天是9月8日'),'n','今天几号了？','json_object').status,'intentionally_empty');
 assert.equal(analyzeSuggestionReply(pack([],'complete'),'n','开票信息怎么填','json_object').status,'intentionally_empty');
});
test('invalid JSON, nonce and truncation never leak protocol into the answer',()=>{
 for(const [raw,status] of [[pack([item]).slice(0,-3),'truncated'],[pack([item],'follow_up','正常正文','bad'),'nonce_mismatch'],['{"answer":17}','invalid_schema']] as const){
 const r=analyzeSuggestionReply(raw,'n','','json_object');assert.equal(r.status,status);assert.ok(!r.text.includes('nextSuggestions'));assert.equal(r.items.length,0);
 }
 assert.equal(analyzeSuggestionReply('正文','n').status,'missing_tail');
});
test('date answers cannot trigger unrelated recommendations even with nonempty model items',()=>{
 const r=analyzeSuggestionReply(pack([item],'follow_up','今天是9月8日'),'n','今天几号了？','json_object');
 assert.equal(r.status,'intentionally_empty');assert.equal(r.reason,'complete');
});
test('sanitized replay preserves successful and failed diagnostics and full usage',()=>{
 for(const items of [[item],[]]){
 const t=new SuggestionTurn({enabled:true,format:'json_object',sessionKey:'s',runtimeAgentID:'a',sourceClientMsgID:'m',recipientUserID:'u',ownerUserID:'u',agentID:'a',conversationID:'c',userText:'重开'});
 t.capture({role:'assistant',responseId:'r',content:pack(items,'follow_up','发票抬头错误需要重开发票。',t.nonce),usage:{input:100,output:50,totalTokens:150}});
 const r=t.parse('发票抬头错误需要重开发票。');assert.equal(r.items.length,items.length);
 assert.equal(t.diagnostics().status,items.length?'generated':'unexpected_empty');
 assert.equal(t.usageSnapshot()?.outputTokens,50);
 }
});
test('response format is scoped to the request and selected compatible model',()=>{
 const cfg={agents:{defaults:{models:{'aliyun-bailian/deepseek-v4.1-flash':{params:{temperature:.5}},other:{params:{}}}},list:[{id:'a'},{id:'b'}]}};
 const original=JSON.stringify(cfg);const r=configureSuggestionResponse(cfg,'a','aliyun-bailian/deepseek-v4.1-flash',true);
 assert.equal(r.format,'json_object');assert.equal(JSON.stringify(cfg),original);
 assert.equal(r.cfg.agents.defaults.models.other,cfg.agents.defaults.models.other);
 assert.equal(configureSuggestionResponse(cfg,'b','other',true).cfg,cfg);
 assert.equal(configureSuggestionResponse(cfg,'a','aliyun-bailian/deepseek-v4.1-flash',false).cfg,cfg);
});

test('malformed quoted answer is recovered locally without accepting auxiliary candidates',()=>{
 const raw = '{"answer":"请搜"北京天气预报"确认实时信息。","nextSuggestions":{"nonce":"n","reason":"uncertain","items":[]}}';
 const r=analyzeSuggestionReply(raw,'n','明天有雨吗','json_object');
 assert.equal(r.status,'intentionally_empty');assert.equal(r.formatRepaired,true);assert.equal(r.text,'请搜"北京天气预报"确认实时信息。');assert.equal(r.items.length,0);
});
test('combined farewell and explicit uncertainty deterministically suppress generated candidates',()=>{
 for(const [user,answer,reason] of [['谢谢，再见','再见','closing'],['明天北京有雨吗','没有可靠的实时预报，请查看天气App','uncertain']]) {
  const r=analyzeSuggestionReply(pack([item],'follow_up',answer),'n',user,'json_object');assert.equal(r.status,'intentionally_empty');assert.equal(r.reason,reason);
 }
});

test('natural book suggestions are grounded in visible answer without exact anchor wording',()=>{
 const r=analyzeSuggestionReply(pack([{kind:'question',text:'挑什么样的书更容易读得进去？',anchor:'下次可以挑一本更顺手的试试'}],'follow_up','你最近在读什么书？下次可以挑一本更顺手的试试。'),'n','阅读十分钟容易分心','json_object');
 assert.equal(r.status,'generated');
});
test('syntax recovery still requires the original nonce and complete JSON',()=>{
 const raw=pack([item]).replace('"answer":','answer:');
 const r=analyzeSuggestionReply(raw,'n','重开','json_object');assert.equal(r.items.length,1);assert.equal(r.formatRepaired,true);
 assert.equal(analyzeSuggestionReply(raw,'wrong','重开','json_object').items.length,0);
 assert.equal(analyzeSuggestionReply(raw.slice(0,-2),'n','重开','json_object').items.length,0);
});

test('assistant offers are excluded without rejecting user permission questions',()=>{
 const r=analyzeSuggestionReply(pack([{kind:'question',text:'您通常读什么书？我可以帮您挑',anchor:'读什么书'},{kind:'question',text:'我可以先读短篇书吗？',anchor:'读什么书'}],'follow_up','你通常读什么书？'),'n','怎么读书','json_object');
 assert.equal(r.items.length,1);assert.equal(r.rejected.assistant_voice,1);assert.equal(r.items[0].text,'我可以先读短篇书吗？');
});


test('optional suggestions allow completed and conversational answers without hiding protocol failures',()=>{
 for(const format of ['tagged','json_object'] as const) {
  for(const reason of ['not_needed','complete']) {
   const answer='今天有点累，先歇一会儿也好。';
   const raw=format==='json_object'?pack([],reason,answer):`${answer}\n<infiai_next_suggestions_v1 nonce="n">${JSON.stringify({reason,items:[]})}</infiai_next_suggestions_v1>`;
   const result=analyzeSuggestionReply(raw,'n','今天好累',format);
   assert.equal(result.status,'intentionally_empty');assert.equal(result.text,answer);assert.equal(result.reason,reason);
  }
 }
 assert.equal(analyzeSuggestionReply(pack([],'nonsense'),'n','','json_object').status,'unexpected_empty');
 const single=analyzeSuggestionReply(pack([item]),'n','发票怎么重开','json_object');
 assert.equal(single.status,'generated');assert.equal(single.items.length,1);
});

test('optional empty output accepts natural endings without requiring exact phrasing',()=>{
 for(const [user,answer,reason] of [['谢谢，知道了','不客气','closing'],['先这样，拜拜','拜拜','closing'],['给我别人的手机号','这个涉及他人隐私，我不会提供。','refusal']]) {
  const r=analyzeSuggestionReply(pack([],reason,answer),'n',user,'json_object');
  assert.equal(r.status,'intentionally_empty');assert.equal(r.text,answer);
 }
});

test('JSON mode preserves plain provider answers but never exposes broken envelopes',()=>{
 const plain='我是你的分身，不是本人。';
 const r=analyzeSuggestionReply(plain,'n','你是谁','json_object');
 assert.equal(r.text,plain);assert.equal(r.status,'missing_tail');assert.deepEqual(r.items,[]);
 for(const raw of ['{"nextSuggestions":{"nonce":"secret","items":[]}}','{"answer":17}', '{"nextSuggestions":', '["内部结构"]', 'nextSuggestions: {nonce: "secret"}']) {
  const t=new SuggestionTurn({enabled:true,format:'json_object',sessionKey:'s',runtimeAgentID:'a',sourceClientMsgID:'m',recipientUserID:'u',ownerUserID:'u',agentID:'a',conversationID:'c',userText:'你是谁'});
  const written=t.capture({role:'assistant',content:[{type:'text',text:raw}],usage:{input:10,output:5}});
  const delivered=t.parse(written.content[0].text);
  assert.equal(delivered.text,'刚才这条回复没能正常生成，请再发一次。');
  assert.deepEqual(delivered.items,[]);assert.doesNotMatch(delivered.text,/secret|nextSuggestions/);
  assert.equal(t.answerUnavailable(),true);
  const diagnostics=t.diagnostics();
  assert.ok(['invalid_json','invalid_schema','truncated'].includes(diagnostics.status));
  assert.equal(Object.values(diagnostics.parseCounts).reduce((a:any,b:any)=>a+b,0),1);
  assert.equal(t.usageSnapshot()?.outputTokens,5);
 }
});
test('fallback and plain answer survive repeated transcript and delivery parsing',()=>{
 for(const raw of ['我是你的分身。','{"answer":"我是你的分身。","nextSuggestions":BROKEN}']) {
  const t=new SuggestionTurn({enabled:true,format:'json_object',sessionKey:'s',runtimeAgentID:'a',sourceClientMsgID:'m',recipientUserID:'u',ownerUserID:'u',agentID:'a',conversationID:'c',userText:'你是谁'});
  const first=t.parse(raw); const status=t.diagnostics().status;
  assert.equal(first.text,'我是你的分身。');
  assert.equal(t.answerUnavailable(),false);
  assert.deepEqual(t.parse(raw),first);assert.deepEqual(t.parse(first.text),first);
  assert.equal(t.diagnostics().status,status);
 }
});
