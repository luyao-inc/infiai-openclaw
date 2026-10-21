import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryVersionedSessionKey, stripStoredMemory, registerMemoryBoundaryHooks } from './memoryBoundary';
test('memory deletion retires old sessions and is stable across restarts',()=>{
 const old='agent:a:direct:u';const first=memoryVersionedSessionKey(old,'facts-v1:1:1');
 assert.notEqual(first,old);assert.equal(memoryVersionedSessionKey(first,'facts-v1:1:1'),first);
 assert.notEqual(memoryVersionedSessionKey(old,'facts-v1:2:2'),first);
 assert.notEqual(memoryVersionedSessionKey('agent:b:direct:u','facts-v1:1:1'),first);
});
test('only ephemeral injected blocks are removed from transcript, without dropping the real user request',()=>{
 const injected='[Infiai Long-Term Memory Context]\nobsolete biography\n[End Infiai Long-Term Memory Context]\n\n真实问题';
 assert.equal(stripStoredMemory(injected),'真实问题');
 let hook:any;registerMemoryBoundaryHooks({on:(_name:string,fn:any)=>{hook=fn}});
 const result=hook({message:{role:'user',content:[{type:'text',text:injected},{type:'image',data:'preserved'}]}});
 assert.equal(result.message.content[0].text,'真实问题');assert.equal(result.message.content[1].data,'preserved');
 assert.equal(hook({message:{role:'assistant',content:'normal'}}),undefined);
});

import {withInfiaiToolContext} from './toolContext';
test('fresh memory reaches the model separately from storage and is scoped to the active turn',async()=>{
 const hooks:Record<string,any>={};registerMemoryBoundaryHooks({on:(name:string,fn:any)=>{hooks[name]=fn}});
 const make=(value:string)=>withInfiaiToolContext({accountId:'a',managedUserId:'u',senderId:'u',agentId:'agent',sessionKey:'session',ownerAuthorized:true,source:'inbound',memoryContext:value},async()=>{
  await Promise.resolve();return hooks.before_prompt_build({}, {agentId:'agent',sessionKey:'session'}).appendSystemContext;
 });
 assert.deepEqual(await Promise.all([make('first user facts'),make('second user facts')]),['first user facts','second user facts']);
 assert.equal(hooks.before_prompt_build({}, {agentId:'agent',sessionKey:'session'}),undefined);
});
