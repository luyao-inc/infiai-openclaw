import test from 'node:test';
import assert from 'node:assert/strict';
import {createBailianImageProvider} from './bailianImage';
import {publicReplyText} from './publicReply';
test('Bailian provider uses native endpoint and suppresses raw upstream diagnostics',async()=>{
 const old=process.env.BAILIAN_TEXT_API_KEY;process.env.BAILIAN_TEXT_API_KEY='test-key';
 try {
  const fail=createBailianImageProvider(async()=>new Response('secret /root/path API key', {status:403}));
  await assert.rejects(fail.generateImage({model:'qwen-image-3.0-pro',prompt:'dog'}),e=>String(e)==='Error: Image service HTTP 403');
  const png=Buffer.from([137,80,78,71,13,10,26,10]);let calls=0;
  const p=createBailianImageProvider(async(url,opts)=>{calls++;if(calls===1){assert.match(String(url),/multimodal-generation\/generation$/);assert.equal(JSON.parse(String(opts?.body)).model,'qwen-image-3.0-pro');return Response.json({output:{choices:[{message:{content:[{image:'https://test.aliyuncs.com/dog.png'}]}}]}});}return new Response(png);});
  assert.equal((await p.generateImage({model:'qwen-image-3.0-pro',prompt:'dog'})).images[0].mimeType,'image/png');
  await assert.rejects(p.generateImage({model:'google/model'}),/Unsupported/);
 }finally{if(old===undefined)delete process.env.BAILIAN_TEXT_API_KEY;else process.env.BAILIAN_TEXT_API_KEY=old;}
});
test('public boundary unwraps only platform envelopes and never sends diagnostic errors',()=>{
 for(const error of ['Image generation failed: No API key found /root/secret','Error: fetch failed','⚠️ 🛠️ Exec failed: cat /etc/os-release'])assert.doesNotMatch(publicReplyText(error),/API key|\/root|Exec|fetch/);
 assert.equal(publicReplyText(JSON.stringify({messages:['你好'],nextSuggestions:{nonce:'x'}})),'你好');
 for(const text of ['{"value":42}','```ts\nthrow new Error("example")\n```','HTTP 是协议的名称。'])assert.equal(publicReplyText(text),text);
});
