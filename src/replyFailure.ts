import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type ReplyFailureKind = "content_rejected" | "transient" | "invalid_request" | "unknown";
export const FRIENDLY_REPLY_FAILURE = "这次没能好好接上你的话。你可以再说一次，我继续听。";
export const FRIENDLY_CONTENT_REJECTION = "我们换个角度聊聊吧。你也可以换一个感兴趣的话题，我继续陪你聊。";
export const FRIENDLY_INCOMPLETE_REPLY = "刚才的话还没说完整。你想从哪一点继续聊？";

export function classifyReplyFailure(value: unknown): ReplyFailureKind {
  const text = value instanceof Error ? value.message : String(value ?? "");
  if (/inappropriate content|content_filter|content_policy_violation|content moderation.*(?:reject|block)|(?:input|output).*data inspection|DataInspectionFailed|safety.*(?:reject|block)|^(?:错误[:：]\s*)?内容审核未通过/i.test(text)) return "content_rejected";
  if (/\b(?:408|429|500|502|503|504)\b|rate.?limit|cooldown|timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|fetch failed|connection (?:closed|reset)|temporarily unavailable/i.test(text)) return "transient";
  if (/\b(?:400|401|403|404|422)\b|schema|tool payload|invalid (?:params|request)|authentication|api.?key/i.test(text)) return "invalid_request";
  return "unknown";
}

export function friendlyReplyFailure(kind: ReplyFailureKind): string {
  return kind === "content_rejected" ? FRIENDLY_CONTENT_REJECTION : FRIENDLY_REPLY_FAILURE;
}

export function isModelFailureText(text: string): boolean {
  return text === FRIENDLY_REPLY_FAILURE || text === FRIENDLY_CONTENT_REJECTION ||
    /^(?:⚠️\s*)?(?:Agent (?:failed before reply|couldn't generate a response)|LLM request failed|(?:400 )?Input text data may contain inappropriate content|HTTP \d{3}|provider cooldown|Something went wrong while processing your request|Processing failed:|Message failed)|ended with an incomplete terminal response|midstream error/i.test(text);
}

type Capture = { error: string; recovery: boolean; agentId?: string; sessionKey?: string; toolsUsed: boolean; modelFailed?: boolean };
const storage = new AsyncLocalStorage<Capture>();
const registered = new WeakSet<object>();
export function isReplyRecovery(): boolean { return storage.getStore()?.recovery === true; }
const RECOVERY_POLICY = `本轮仅作一次对话恢复。遵守所有原有安全、权限和隐私约束，不绕过任何审核。不要调用工具或执行操作，不声称操作已完成，不编造事实或假装已核实外部信息。如果原问题无法回答，只回答其中明确允许且有依据的部分，或简短提出澄清问题、邀请换个角度。不要复述被拒绝的材料，不猜测具体受限原因。用自然友好的对话口吻，不展示技术错误、错误码或内部提示。仅返回一段简短纯文本，不输出 JSON、推荐问题协议或工具进度。`;

export function registerReplyFailureHooks(api: any): void {
  if (registered.has(api) || typeof api.on !== "function") return;
  api.on("before_message_write", (event: any, ctx: any) => {
    const capture = storage.getStore();
    if (!capture || (ctx?.agentId && capture.agentId && ctx.agentId !== capture.agentId) || (ctx?.sessionKey && capture.sessionKey && ctx.sessionKey !== capture.sessionKey)) return;
    const message = event?.message;
    if (message?.role === "assistant" && (message.stopReason === "error" || message.errorMessage)) {
      capture.error = String(message.errorMessage || "LLM request failed");
      capture.modelFailed = true;
      // Keep the structured terminal marker for model-input cleanup, never its
      // generated placeholder prose. Transcript usage and diagnostics survive.
      return { message: { ...message, content: [], infiaiFailure: true } };
    }
  }, { priority: 500 });
  api.on("before_tool_call", () => {
    const capture = storage.getStore();
    if (!capture) return;
    capture.toolsUsed = true;
    if (capture.recovery) return { block: true, blockReason: "Conversation recovery is text-only" };
  }, { priority: 1000 });
  api.on("before_prompt_build", (_event: any, ctx: any) => {
    const capture = storage.getStore();
    if (capture?.recovery && (!ctx?.sessionKey || ctx.sessionKey === capture.sessionKey)) return { appendSystemContext: RECOVERY_POLICY };
  }, { priority: 500 });
  registered.add(api);
}

async function waitForRecovery<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("reply recovery cancelled or timed out"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Same agent and exact user input; at most one isolated, tool-free recovery.
 * Recovery text is returned as a notice, never normal billed/learned output.
 * A model policy refusal is never retried verbatim with the rejected evidence.
 */
export async function dispatchWithReplyRecovery(api: any, dispatch: (options: any) => Promise<unknown>, options: any, hasReply?: () => boolean): Promise<{ failureReply?: string; kind?: ReplyFailureKind; recovered?: boolean }> {
  const capture: Capture = { error: "", recovery: false, agentId: undefined, sessionKey: options.ctx?.SessionKey, toolsUsed: false };
  let visible = false;
  let silent = false;
  const deliver = options.dispatcherOptions.deliver;
  const wrapped = { ...options, dispatcherOptions: { ...options.dispatcherOptions,
    deliver: async (payload: any, info: any) => {
      const text = String(payload?.text || "").trim();
      if (/^(?:NO_REPLY|NO_ANSWER)\.?$/.test(text)) silent = true;
      if (payload?.isError === true || isModelFailureText(text)) { capture.error ||= text || "LLM request failed"; capture.modelFailed = true; return; }
      if (text && (!info?.kind || info.kind === "final")) visible = true;
      await deliver(payload, info);
    },
    onError: (error: unknown, info: any) => { capture.error ||= String(error); options.dispatcherOptions.onError?.(error, info); },
  } };
  try { await storage.run(capture, () => dispatch(wrapped)); }
  catch (error) {
    if (options.replyOptions?.abortSignal?.aborted || ["AbortError", "ReplyCancelledError", "HumanReceptionSuppressedError"].includes((error as any)?.name)) throw error;
    capture.error ||= String(error);
  }
  if (silent || (hasReply ? hasReply() : visible) || (visible && !capture.modelFailed) || !capture.error) return {};
  const kind = classifyReplyFailure(capture.error);
  api.logger?.warn?.(`[infiai] reply failure kind=${kind} toolsUsed=${capture.toolsUsed}`);
  if (options.replyOptions?.abortSignal?.aborted) return {};
  // Unknown/auth/schema failures do not benefit from another paid generation.
  // Tool side effects must never be repeated. The recovery has no tools/history.
  if (kind !== "content_rejected" && kind !== "transient") return { failureReply: friendlyReplyFailure(kind), kind };
  const key = `${options.ctx.SessionKey}:ephemeral:recovery:${randomUUID()}`;
  const recovery: Capture = { error: "", recovery: true, sessionKey: key, toolsUsed: false };
  let recoveryText = "";
  const signal = options.replyOptions?.abortSignal;
  const timeout = AbortSignal.timeout(20_000);
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cfg = { ...options.cfg, tools: { ...options.cfg?.tools, deny: ["*"] }, agents: { ...options.cfg?.agents,
    defaults: { ...options.cfg?.agents?.defaults, models: Object.fromEntries(Object.entries(options.cfg?.agents?.defaults?.models || {}).map(([key, value]: [string, any]) => {
      const params = { ...value.params }; delete params.response_format; delete params.responseFormat;
      return [key, { ...value, params }];
    })) },
    list: options.cfg?.agents?.list?.map((agent: any) => {
      const params = { ...agent.params }; delete params.response_format; delete params.responseFormat;
      return { ...agent, params, tools: { ...agent.tools, deny: ["*"] } };
    }),
  } };
  try {
    await waitForRecovery(storage.run(recovery, () => dispatch({ ...options, cfg,
      ctx: { ...options.ctx, SessionKey: key, GroupSystemPrompt: `${options.ctx.GroupSystemPrompt || ""}\n${RECOVERY_POLICY}`, MessageSid: `${options.ctx.MessageSid || "turn"}:recovery`,
        _infiai: { ...options.ctx._infiai, conversationId: key } },
      dispatcherOptions: {
        deliver: async (payload: any, info: any) => {
          const text = String(payload?.text || "").trim();
          if (payload?.isError === true || isModelFailureText(text)) { recovery.error ||= text || "LLM request failed"; return; }
          if (text && (!info?.kind || info.kind === "final")) recoveryText = text;
        },
        onError: (error: unknown) => { recovery.error ||= String(error); },
      },
      replyOptions: { disableBlockStreaming: true, abortSignal, images: options.replyOptions?.images || [] },
    })), abortSignal);
  } catch { recovery.error ||= "recovery_failed"; }
  if (signal?.aborted) return {};
  // Transport JSON/suggestion envelopes must not be shown as notice text.
  const usable = recoveryText && Array.from(recoveryText).length <= 600 && !recovery.error && !recovery.toolsUsed &&
    !/^(?:NO_REPLY|NO_ANSWER)\.?$|^\s*[\[{]|<infiai_|⚠️|\b(?:API|HTTP|LLM)\b|系统.{0,6}(?:错误|故障|繁忙)|生成.{0,4}(?:异常|失败)|(?:连接|网络).{0,4}(?:失败|异常|故障)|请求.{0,6}(?:失败|无法完成)|服务.{0,6}(?:不可用|异常|故障|繁忙)/i.test(recoveryText);
  api.logger?.info?.(`[infiai] reply recovery kind=${kind} recovered=${Boolean(usable)}`);
  return { failureReply: usable ? recoveryText : friendlyReplyFailure(kind), kind, recovered: Boolean(usable) };
}
