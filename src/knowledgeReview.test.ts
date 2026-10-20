import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeReplyReview } from './knowledgeReview';
test('IM and buffered surfaces review once before planning, even with duplicate final callbacks',async()=>{
 const key=Symbol.for('infiai.knowledgeAnswerGuard.v1');const p=process as any,old=p[key];let calls=0;
 p[key]=async({question,answer,sessionKey}:any)=>{calls++;assert.equal(question,'你有几个女儿');return {answer:sessionKey==='one'?'我有3个女儿。':answer,status:'corrected',usages:[{provider:'p',model:'m',usage:{input:20,output:5}}]}};
 try{const a=knowledgeReplyReview({}, {agentId:'a',sessionKey:'one',startedAt:10,question:'你有几个女儿'});const b=knowledgeReplyReview({}, {agentId:'b',sessionKey:'two',startedAt:10,question:'你有几个女儿'});assert.deepEqual(await Promise.all([a.check('错误'),a.check('错误'),b.check('别的回答')]),['我有3个女儿。','我有3个女儿。','别的回答']);assert.equal(calls,2);assert.equal(a.usages.length,1)}finally{p[key]=old}
});
