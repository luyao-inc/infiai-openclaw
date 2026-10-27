import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeReplyReview } from './knowledgeReview';
test('IM and buffered surfaces review once before planning, even with duplicate final callbacks',async()=>{
 const key=Symbol.for('infiai.knowledgeAnswerGuard.v1');const p=process as any,old=p[key];let calls=0;
 p[key]=async({question,answer,sessionKey}:any)=>{calls++;assert.equal(question,'你有几个女儿');return {answer:sessionKey==='one'?'我有3个女儿。':answer,status:'corrected',usages:[{provider:'p',model:'m',usage:{input:20,output:5}}]}};
 try{const a=knowledgeReplyReview({}, {agentId:'a',sessionKey:'one',startedAt:10,question:'你有几个女儿'});const b=knowledgeReplyReview({}, {agentId:'b',sessionKey:'two',startedAt:10,question:'你有几个女儿'});assert.deepEqual(await Promise.all([a.check('错误'),a.check('错误'),b.check('别的回答')]),['我有3个女儿。','我有3个女儿。','别的回答']);assert.equal(calls,2);assert.equal(a.usages.length,1)}finally{p[key]=old}
});

const key = Symbol.for("infiai.knowledgeAnswerGuard.v1");
test("review shares one in-flight call and checks invalidation before returning cached content", async () => {
 let valid = true, checks = 0, calls = 0;
 (process as any)[key] = async ({answer}: any) => { calls++; return {answer, status:"supported", usages:[]}; };
 try {
  const review = knowledgeReplyReview({}, {agentId:"a",sessionKey:"s",startedAt:1,question:"q",validateMemory:async()=>{checks++; return valid;}});
  assert.deepEqual(await Promise.all([review.check("answer"),review.check("answer")]),["answer","answer"]);
  assert.equal(calls,1); assert.equal(checks,3); // two callers plus one post-review check
  valid=false;
  assert.equal(await review.check("answer"),"请重新发送刚才的问题。");
  assert.equal(calls,1);
 } finally { delete (process as any)[key]; }
});
test("deletion while reviewing prevents the draft from being delivered", async () => {
 let checks=0;
 (process as any)[key]=async()=>({answer:"stale fact",status:"supported",usages:[]});
 try {
  const review=knowledgeReplyReview({}, {agentId:"a",sessionKey:"s",startedAt:1,question:"q",validateMemory:async()=>++checks===1});
  assert.equal(await review.check("draft"),"请重新发送刚才的问题。");
  assert.equal(checks,2);
 } finally { delete (process as any)[key]; }
});
