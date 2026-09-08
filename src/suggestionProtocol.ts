import { jsonrepair } from "jsonrepair";
import type { NextSuggestion } from './nextSuggestions';

export type SuggestionStatus = 'generated' | 'intentionally_empty' | 'missing_tail' | 'invalid_json' | 'invalid_schema' | 'nonce_mismatch' | 'oversized' | 'truncated' | 'filtered_all' | 'unexpected_empty';
export type SuggestionResult = { text: string; items: NextSuggestion[]; status: SuggestionStatus; reason?: string; rawCount: number; rejected: Record<string, number>; formatRepaired?: boolean };
export type SuggestionFormat = 'tagged' | 'json_object';
const tag = 'infiai_next_suggestions_v1';
const record = (x: any): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const norm = (s: string) => s.toLowerCase().replace(/[?？!！。\s]+$/u, '').trim();
const terms = (s: string) => new Set((s.toLowerCase().match(/[a-z]{3,}|[\u3400-\u9fff]{2,}/g) || []).flatMap(x => /[a-z]/.test(x) ? [x] : Array.from({length:x.length-1},(_,i)=>x.slice(i,i+2))).filter(x=>!['the','and','for','this','that','怎么','什么','如何','可以','一下','这个','今天','明天'].includes(x)));

export function emptyReasonAllowed(reason: string, user: string, answer: string): boolean {
  if (reason === 'closing') return /^(?:谢谢(?:你)?(?:[，,]?(?:再见|拜拜))?|好的?[，,]?谢谢(?:你)?|再见|拜拜|晚安|thanks|thank you|bye)[。！!，,\s]*$/i.test(user.trim());
  if (reason === 'user_opt_out') return /(?:不要|不用|别)(?:再)?(?:给我)?(?:生成|提供|推荐)?(?:下一句|追问|建议)|no (?:follow.up|suggestions)/i.test(user);
  if (reason === 'complete') return answer.length <= 100 && /(?:今天|明天|昨天|现在).*(?:几号|星期几|日期)|what(?:'s| is) (?:the date|today)|^\s*\d+\s*[+×*÷/-]\s*\d+\s*[=?？]*\s*$/i.test(user);
  if (reason === 'uncertain') return /无法(?:确认|确定|查询|获取)|不能(?:确认|确定|保证)|不(?:太)?可靠|不能给.*打包票|没有(?:可靠|实时)|无法.*实时|cannot (?:verify|confirm)|don't have.*(?:live|reliable)/i.test(answer);
  if (reason === 'refusal') return /不能(?:帮助|协助|提供)|无法(?:帮助|协助|提供)|不能帮|cannot (?:help|assist)|can't (?:help|assist)/i.test(answer);
  return false;
}

export function validateCandidateItems(value: unknown, user: string, answer?: string, grounded = false) {
  const items: NextSuggestion[] = [], rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] || 0) + 1; };
  const seen = new Set([norm(user)]);
  if (!Array.isArray(value)) return { items, rejected, rawCount: 0 };
  for (const item of value.slice(0, 8)) {
    if (!record(item) || typeof item.text !== 'string') { reject('invalid_item'); continue; }
    const text = item.text.trim();
    if (!text || [...text].length > 80 || /[\r\n<>\u0000-\u001f]/u.test(text)) { reject('invalid_text'); continue; }
    if (/https?:\/\/|\b(?:sk-[a-zA-Z0-9]{12,}|Bearer\s+\S+)|\b1[3-9]\d{9}\b/i.test(text)) { reject('sensitive_pattern'); continue; }
    if (!['question','request','reply'].includes(item.kind)) { reject('invalid_kind'); continue; }
    if (/(?:我(?:可以|能|来)?(?:帮你|帮您|为你|为您)|要不要我|需要我|让我帮|I can help you|would you like me to)/i.test(text)) { reject('assistant_voice'); continue; }
    if (seen.has(norm(text))) { reject('duplicate'); continue; }
    if (grounded) {
      const anchor = typeof item.anchor === 'string' ? item.anchor.trim() : '';
      if (anchor.length < 2 || anchor.length > 40 || !answer?.includes(anchor)) { reject('anchor_not_in_answer'); continue; }
      const anchorTerms = terms(`${answer} ${user}`), candidateTerms = terms(text);
      for (const term of ['书','税','票','雨','风','车','灯','茶','猫','狗']) {
        if (`${answer} ${user}`.includes(term)) anchorTerms.add(term);
        if (text.includes(term)) candidateTerms.add(term);
      }
      if (![...anchorTerms].some(t=>candidateTerms.has(t))) { reject('off_topic'); continue; }
    }
    seen.add(norm(text));
    const kind = /^(?:请|帮我|给我|please\b|help me\b)/i.test(text) ? 'request' : item.kind;
    items.push({id:`s${items.length+1}`,kind,text});
    if (items.length === 3) break;
  }
  if (value.length > 8) reject('excess_items');
  return {items,rejected,rawCount:value.length};
}

function hasUnclosedJSON(raw: string): boolean {
  let depth = 0, quoted = false, escaped = false;
  for (const c of raw) {
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth > 0 || quoted;
}

export function analyzeSuggestionReply(text: string, nonce: string, user = '', format: SuggestionFormat = 'tagged'): SuggestionResult {
  let formatRepaired = false;
  const result = (body: string, status: SuggestionStatus, extra: Partial<SuggestionResult> = {}): SuggestionResult => ({text:body,items:[],status,rawCount:0,rejected:{},...(formatRepaired ? {formatRepaired:true} : {}),...extra});
  let body = text, data: any;
  if (format === 'json_object') {
    // Do not parse arbitrary JSON in normal tagged-mode answers. In constrained mode
    // only the answer field may reach IM, transcript, TTS or long-term memory.
    const raw = text.trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/,'');
    try { data = JSON.parse(raw); }
    catch {
      const truncated = raw.startsWith('{') && hasUnclosedJSON(raw);
      let repaired: any;
      if (raw.startsWith('{') && Buffer.byteLength(raw, 'utf8') <= 128 * 1024) {
        try { repaired = JSON.parse(jsonrepair(raw)); } catch { /* no model retry */ }
      }
      if (!truncated && record(repaired) && typeof repaired.answer === 'string') {
        // Syntax-only recovery is followed by the same nonce/schema/grounding checks.
        data = repaired;
        formatRepaired = true;
      } else {
        const match = /"answer"\s*:\s*("(?:[^"\\]|\\.)*")/s.exec(raw);
        let recovered = record(repaired) && typeof repaired.answer === 'string' ? repaired.answer : '';
        if (!recovered && match) { try { recovered = JSON.parse(match[1]); } catch {} }
        return result(recovered, truncated ? 'truncated' : 'invalid_json');
      }
    }
    if (!record(data) || typeof data.answer !== 'string') return result('', 'invalid_schema', {reason:'answer_missing_or_invalid'});
    body = data.answer;
    data = data.nextSuggestions;
    if (!record(data)) return result(body, 'invalid_schema', {reason:'suggestions_missing_or_invalid'});
    if (data.nonce !== nonce) return result(body, 'nonce_mismatch');
  } else {
    let offset=0, fence='', start=-1;
    for (const line of text.split('\n')) {
      const trimmed=line.trimStart(), marker=/^(`{3,}|~{3,})/.exec(trimmed);
      if(marker){const delimiter=marker[1][0];fence=fence===delimiter?'':fence||delimiter;}
      else if(!fence && trimmed.startsWith('<infiai_next_sug')){start=offset;break;}
      offset+=line.length+1;
    }
    if(start<0) return result(body,'missing_tail');
    body=text.slice(0,start).trimEnd();const tail=text.slice(start).trim();
    if(Buffer.byteLength(tail,'utf8')>2048)return result(body,'oversized');
    const match=new RegExp(`^<${tag} nonce="([^"]*)">\\s*([\\s\\S]*?)\\s*</${tag}>\\s*$`).exec(tail);
    if(!match)return result(body,'truncated');
    if(match[1]!==nonce)return result(body,'nonce_mismatch');
    try{data=JSON.parse(match[2]);}catch{return result(body,'invalid_json');}
  }
  if(!record(data)||!Array.isArray(data.items))return result(body,'invalid_schema',{reason:'items_missing_or_invalid'});
  if(Buffer.byteLength(JSON.stringify(data),'utf8')>2048)return result(body,'oversized');
  const reason=typeof data.reason==='string' ? data.reason : '';
  if(!data.items.length) return result(body,emptyReasonAllowed(reason,user,body)?'intentionally_empty':'unexpected_empty',{reason:['closing','user_opt_out','complete','uncertain','refusal'].includes(reason)?reason:'unspecified'});
  // Explicit user opt-out and closure are deterministic, even if the model returns items.
  for(const r of ['closing','user_opt_out','complete','uncertain','refusal'])if(emptyReasonAllowed(r,user,body))return result(body,'intentionally_empty',{reason:r,rawCount:data.items.length});
  const checked=validateCandidateItems(data.items,user,body,format==='json_object');
  return result(body,checked.items.length?'generated':'filtered_all',checked);
}

/** Copy only this model's request configuration; no shared runtime mutation. */
export function configureSuggestionResponse(cfg: any, agentId: string, primaryModel: string, enabled: boolean) {
  const agent=cfg?.agents?.list?.find((a:any)=>a.id===agentId);
  if(!enabled || !/^deepseek\/deepseek-v4-(?:flash|pro)$/.test(primaryModel) || agent?.params?.response_format || agent?.params?.responseFormat) return {cfg,format:'tagged' as SuggestionFormat};
  const defaults=cfg.agents?.defaults||{}, models=defaults.models||{}, model=models[primaryModel]||{};
  return {format:'json_object' as SuggestionFormat,cfg:{...cfg,agents:{...cfg.agents,defaults:{...defaults,models:{...models,[primaryModel]:{...model,params:{...model.params,response_format:{type:'json_object'}}}}}}}};
}
