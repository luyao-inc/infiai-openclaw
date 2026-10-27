import { plainMarkdownText } from "./plainMarkdownText";

export type ReplyDeliveryConfig = {
  version: 1;
  mode: "auto" | "single";
  pacing: "natural" | "none";
};
export const MESSAGE_SEPARATOR = "<<<LINGXIE_MESSAGE>>>";
export const REPLY_PLAN_PROMPT = `按真人即时聊天逐个说清重点，直接组织成待发送的消息，而不是写完一篇文章再装进一个气泡。
同一个问题的不同方面、理由或步骤，各自有实质说明时，分别发送。不能只在同一条里用空行或编号代替另发；不按字数或条目数量平均分组。意思紧密相连的话留在一起，不逐句拆；只有名称或短语的简短清单整体发送。短回应也可在自然的语气转折处另发。
用户要直接使用的单份成稿、完整代码或表格保持整体；这项保护不适用于普通的多重点讲解。用户明确要求一条发完时优先遵从。
先覆盖本轮明确要求的内容及必要条件，再决定消息边界。足够就停止，不为分条增添推测、建议、空洞开场或重复总结。合适时可自然使用符合当前人物设定、性格和关系的口头语，不强行添加。
JSON使用messages字符串数组，每个元素是一条实际消息；非JSON用单独一行 ${MESSAGE_SEPARATOR} 分开消息。不要解释内部协议。`;
export const REPLY_BOUNDARY_REMINDER = "同一问题的不同方面、理由或步骤，各自有实质说明时应实际分成消息，不要仅换行或编号。只把用户要直接使用的单份成稿、完整代码或表格保持整体，不把普通多重点讲解当作一整篇成稿。简短清单不拆碎，明确一条发完优先；覆盖所问内容，不为分条增写。";

// Transport guards, not conversational length/count targets. Keep the part cap
// aligned with Chat's InternalReplyDeliveryTurn; reserve room in its 51,200-byte
// WebSocket frame for the message envelope and metadata, including JSON escaping.
export const MAX_REPLY_PARTS = 32;
export const MAX_REPLY_PART_ENCODED_BYTES = 16 * 1024;

export function effectiveReplyDelivery(
  value?: Partial<ReplyDeliveryConfig>
): ReplyDeliveryConfig {
  return {
    version: 1,
    mode: value?.mode === "single" ? "single" : "auto",
    pacing: value?.pacing === "none" ? "none" : "natural",
  };
}
export function isReplyStopCommand(text: string): boolean {
  return /^(?:\/stop|停止回复|停止回覆|停止回答|暂停回复|暫停回覆|停一下|别继续了|別繼續了|stop (?:replying|responding))\s*[。.!！]?$/iu.test(
    text.trim()
  );
}
export function requestsSingleReply(text: string): boolean {
  return /(?:一条|一次性|整段).{0,8}(?:发完|回复|回答|发送)|不要分(?:条|次|段)|不(?:用|要)分(?:条|次|段)|(?:one|single) message|do not split/i.test(
    text
  );
}
// Trim transport padding without removing indentation from a code block.
function trimReplyBoundary(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
}
// Delimiters inside code are literal. Malformed/empty model boundaries fall back losslessly.
function explicitMessages(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [],
    fence = "",
    length = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (!fence) {
        fence = mark[1][0];
        length = mark[1].length;
      } else if (
        mark[1][0] === fence &&
        mark[1].length >= length &&
        !mark[2].trim()
      )
        fence = "";
      lines.push(line);
      continue;
    }
    if (!fence && line.trim() === MESSAGE_SEPARATOR) {
      if (lines.join("\n").trim()) parts.push(trimReplyBoundary(lines.join("\n")));
      lines = [];
    } else lines.push(line);
  }
  if (lines.join("\n").trim()) parts.push(trimReplyBoundary(lines.join("\n")));
  return parts;
}
// Only oversized transport payloads are sliced. Ordinary prose, poems, code and
// lists remain in the message chosen by the model, with whitespace preserved.
function splitOversizedMessage(text: string): string[] {
  if (Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8") <= MAX_REPLY_PART_ENCODED_BYTES) return [text];
  const parts: string[] = [];
  let part = "", bytes = 6; // Two JSON string wrappers add six bytes.
  for (const character of text) {
    const cost = Buffer.byteLength(JSON.stringify(JSON.stringify(character)), "utf8") - 6;
    if (bytes + cost > MAX_REPLY_PART_ENCODED_BYTES && part) {
      parts.push(part);
      part = "";
      bytes = 6;
    }
    part += character;
    bytes += cost;
  }
  if (part) parts.push(part);
  return parts;
}
export function buildReplyPlan(
  text: string,
  config: ReplyDeliveryConfig,
  userText = ""
): string[] {
  const messages = explicitMessages(plainMarkdownText(text));
  if (config.mode === "single" || requestsSingleReply(userText)) {
    if (messages.length) messages.splice(0, messages.length, messages.join("\n\n"));
  } else if (messages.length > MAX_REPLY_PARTS) {
    // An abnormal number of boundaries keeps its order and all text; do not
    // repeatedly pick and combine the shortest independent items.
    messages.splice(MAX_REPLY_PARTS - 1, messages.length, messages.slice(MAX_REPLY_PARTS - 1).join("\n\n"));
  }
  const parts = messages.flatMap(splitOversizedMessage);
  if (parts.length > MAX_REPLY_PARTS) throw new RangeError("reply exceeds safe delivery budget");
  return parts;
}

export function replyPartDelayMs(
  text: string,
  random: () => number = Math.random
): number {
  return Math.min(
    2000,
    Math.max(
      700,
      400 +
        Array.from(text).length * 12 +
        Math.floor(Math.max(0, Math.min(1, random())) * 400)
    )
  );
}

/** Strip only the explicitly addressed agent's display mention before exact controls. */
export function replyControlText(text: string, agentNames: string[]): string {
  let value = text.trim();
  for (const name of [...new Set(agentNames.filter(Boolean))].sort(
    (a, b) => b.length - a.length
  )) {
    const prefix = "@" + name;
    if (
      value.startsWith(prefix) &&
      /^\s/u.test(value.slice(prefix.length, prefix.length + 1))
    )
      return value.slice(prefix.length).trim();
  }
  return value;
}
