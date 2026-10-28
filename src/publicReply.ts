import { isModelFailureText, friendlyReplyFailure, classifyReplyFailure } from "./replyFailure";
export function publicReplyText(value: string, isError = false): string {
  let text = String(value || "");
  if (text === friendlyReplyFailure("unknown") || text === friendlyReplyFailure("content_rejected")) return text;
  if (isError || isModelFailureText(text) || /^(?:Image|Video|Music) generation failed:|^⚠️\s*🛠️|^Error:|^No API key found/i.test(text.trim())) return friendlyReplyFailure(classifyReplyFailure(text));
  // Only platform envelopes; ordinary JSON/code answers remain intact.
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && data.nextSuggestions && (Array.isArray(data.messages) || typeof data.answer === "string")) {
      text = Array.isArray(data.messages) && data.messages.every((x: unknown) => typeof x === "string") ? data.messages.join("\n\n") : typeof data.answer === "string" ? data.answer : friendlyReplyFailure("unknown");
      return publicReplyText(text);
    }
  } catch { /* Authenticated normal replies are already parsed upstream. */ }
  if (/^\s*\{\s*"(?:messages|answer)"\s*:/.test(text) && /"nextSuggestions"/.test(text)) return friendlyReplyFailure("unknown");
  return text;
}
