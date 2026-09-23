const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const file = require.resolve('@openim/client-sdk');
const expected = '824d1fd844ba4aa6656cca7dabd4b80b8e34627101c42c7dea1b821c609e70c1';
const prefix = 'var __infiaiHardenSDK=require("./infiai-safety.cjs");\n';
let source = fs.readFileSync(file, 'utf8');
if (source.startsWith(prefix)) source = source.slice(prefix.length)
  .replace(/new Proxy\(__infiaiHardenSDK\(new ([\w$]+)\),\{get:/, 'new Proxy(new $1,{get:')
  .replace('o=require("@openim/protocol").SdkWsProto', 'o=require("@openim/protocol/lib/pb/sdkws/sdkws")');
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Unsupported OpenIM SDK bytes: review upstream changes before applying Node safety adapter');
}
const pattern = /new Proxy\(new ([\w$]+),\{get:/g;
if ([...source.matchAll(pattern)].length !== 1) throw new Error('OpenIM SDK factory shape mismatch');
source = prefix + source.replace(pattern, 'new Proxy(__infiaiHardenSDK(new $1),{get:');
// hotfix.0 refers to a TS build path absent from the published protocol package.
// The official public export contains the identical PullOrder enum it needs.
if (!require('@openim/protocol').SdkWsProto?.PullOrder) throw new Error('Missing official SDK websocket enum');
source = source.replace('o=require("@openim/protocol/lib/pb/sdkws/sdkws")', 'o=require("@openim/protocol").SdkWsProto');
fs.copyFileSync(path.join(__dirname, 'sdk-safety.cjs'), path.join(path.dirname(file), 'infiai-safety.cjs'));
fs.writeFileSync(file, source);
console.log('OpenIM official 3.8.3-hotfix.0 verified; Node account safety adapter installed');
