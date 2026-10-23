import { plainMarkdownText } from "./plainMarkdownText";

export type ReplyDeliveryConfig = {
  version: 1;
  mode: "auto" | "single";
  pacing: "natural" | "none";
};
export const MESSAGE_SEPARATOR = "<<<LINGXIE_MESSAGE>>>";
export const REPLY_PLAN_PROMPT = `For this text chat, express each complete idea in a brief message, usually 40–120 Chinese characters or similarly brief in the user's language. If several messages help, separate them with a standalone line ${MESSAGE_SEPARATOR}. Keep conditions with their actions and headings with their explanations. Preserve complete code, tables and requested documents. Do not add extra content to fill messages. Never expose the separator as prose. If a structured response format is required, place these boundaries inside its answer string and preserve its existing schema.`;
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
// Protect Markdown blocks locally, allowing ordinary text around code/table blocks to split.
function semanticUnits(text: string): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [],
    fence = "",
    length = 0;
  const flush = () => {
    if (buffer.length) {
      blocks.push(buffer.join("\n"));
      buffer = [];
    }
  };
  for (const line of text.split("\n")) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (!fence) {
        flush();
        fence = mark[1][0];
        length = mark[1].length;
      } else if (
        mark[1][0] === fence &&
        mark[1].length >= length &&
        !mark[2].trim()
      ) {
        buffer.push(line);
        flush();
        fence = "";
        continue;
      }
    }
    if (!fence && /^\s*$/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    if (
      !fence &&
      /^\s*(?:\d+[.、)]|[-*+] )/.test(line) &&
      buffer.length &&
      !/^\s*#{1,6}\s/.test(buffer.join("\n"))
    )
      flush();
    buffer.push(line);
  }
  flush();
  return blocks.flatMap((block) => {
    if (
      /(?:^|\n) {0,3}(?:`{3,}|~{3,})/.test(block) ||
      /(`+)[\s\S]*?\1(?!`)/.test(block) ||
      /^(?: {4}|\t)/.test(block) ||
      /^\s*(?:\||#{1,6}\s|\d+[.、)]|[-*+] )/.test(block) ||
      /\n[^\n]*\|[^\n]*\|/.test(block)
    )
      return [block];
    // Avoid punctuation inside URLs, numbers and abbreviations; split English only at terminal whitespace.
    return (
      block
        .match(/[\s\S]*?(?:[。！？]+[”’」』]?|[.!?]+["']?(?=\s+[A-Z]|$)|$)/gu)
        ?.filter(Boolean) || [block]
    );
  });
}
export function buildReplyPlan(
  text: string,
  config: ReplyDeliveryConfig,
  userText = ""
): string[] {
  // Normalize the complete answer before boundaries can separate emphasis pairs.
  const explicit = explicitMessages(plainMarkdownText(text));
  if (config.mode === "single" || requestsSingleReply(userText))
    return explicit.length ? [explicit.join("\n\n")] : [];
  const parts: string[] = [];
  for (const section of explicit) {
    if (Array.from(section).length <= 180) {
      parts.push(section);
      continue;
    }
    let current = "";
    for (const unit of semanticUnits(section)) {
      const dependent = /(?:[:：，,]|^\s*#{1,6}[^\n]*)\s*$/.test(current);
      if (
        current.trim() &&
        Array.from(current + unit).length > 180 &&
        Array.from(current.trim()).length >= 60 &&
        !dependent
      ) {
        parts.push(trimReplyBoundary(current));
        current = unit;
      } else current += (current && unit ? "\n" : "") + unit;
    }
    if (current.trim()) parts.push(trimReplyBoundary(current));
  }
  // Apply the final cap AFTER fallback splitting. Merge; never trim away content.
  while (parts.length > 8) {
    let i = 0;
    for (let j = 1; j < parts.length - 1; j++)
      if (
        parts[j].length + parts[j + 1].length <
        parts[i].length + parts[i + 1].length
      )
        i = j;
    parts.splice(i, 2, parts[i] + "\n\n" + parts[i + 1]);
  }
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
