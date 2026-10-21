import { getInfiaiToolContext } from "./toolContext";
import { createHash } from "node:crypto";
export function memoryVersionedSessionKey(key: string, version?: string): string {
 const base = key.replace(/:memory-v1:[a-f0-9]{16}$/, "");
 // The v1 boundary also retires historical sessions whose memory had no version.
 const hash = createHash("sha256").update(version || "off").digest("hex").slice(0,16);
 return `${base}:memory-v1:${hash}`;
}
export function stripStoredMemory(text: string): string {
 return text.replace(/\[Infiai Long-Term Memory Context\][\s\S]*?\[End Infiai Long-Term Memory Context\]\s*/g, "");
}
export function registerMemoryBoundaryHooks(api: any): void {
 api.on?.("before_prompt_build", (_event: any, ctx: any) => {
  const trusted = getInfiaiToolContext();
  if (!trusted?.memoryContext || trusted.agentId !== ctx?.agentId || (ctx?.sessionKey && trusted.sessionKey !== ctx.sessionKey)) return;
  // Inject fresh backend facts independently of transcript persistence. User
  // text can never create this trusted context, and concurrent turns use ALS.
  return {appendSystemContext: trusted.memoryContext};
 }, {priority:350});
 api.on?.("before_message_write", (event: any) => {
  const message = event.message;
  if(message?.role !== "user") return;
  const content = message.content;
  const clean = typeof content === "string" ? stripStoredMemory(content) : Array.isArray(content) ? content.map((part:any)=> part?.type === "text" ? {...part,text:stripStoredMemory(part.text || "")} : part) : content;
  return {message:{...message,content:clean}};
 }, {priority:300});
}
