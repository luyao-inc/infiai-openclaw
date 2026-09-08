import { analyzeSuggestionReply, type SuggestionResult, type SuggestionFormat } from "./suggestionProtocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export type NextSuggestion = {
  id: string;
  kind: "question" | "request" | "reply";
  text: string;
};
export type NextSuggestions = {
  version: 1;
  turnID: string;
  sourceClientMsgID: string;
  recipientUserID: string;
  agentOwnerUserID: string;
  agentID: string;
  conversationID: string;
  items: NextSuggestion[];
  status?: string;
  reason?: string;
};
export type TurnUsage = {
  provider: string;
  model: string;
  responseId: string;
  usage: Record<string, unknown>;
};
const tag = "infiai_next_suggestions_v1";
const storage = new AsyncLocalStorage<SuggestionTurn>();
const registered = new WeakSet<object>();

export function suggestionsEnabled(
  params: {
    api: object;
    fromManagedBot: boolean;
    interactive: boolean;
    ownerUserID: string;
    clientSupportsSuggestions: boolean;
  },
  env = process.env
): boolean {
  return (
    registered.has(params.api) &&
    params.interactive &&
    params.clientSupportsSuggestions &&
    !params.fromManagedBot &&
    !/^(0|false|off)$/i.test(env.INFIAI_NEXT_SUGGESTIONS_ENABLED || "") &&
    !(env.INFIAI_NEXT_SUGGESTIONS_DISABLED_OWNERS || "")
      .split(",")
      .map((s) => s.trim())
      .includes(params.ownerUserID)
  );
}

export function validateNextSuggestionItems(
  value: unknown,
  userText = ""
): NextSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set([
    userText
      .trim()
      .toLocaleLowerCase()
      .replace(/[?？!！。\s]+$/u, ""),
  ]);
  const result: NextSuggestion[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== "object" || typeof item.text !== "string")
      continue;
    const text = item.text.trim();
    if (
      !text ||
      [...text].length > 80 ||
      /[\r\n<>\u0000-\u001f]/u.test(text) ||
      /https?:\/\/|\b(?:sk-[a-zA-Z0-9]{12,}|Bearer\s+\S+)|\b1[3-9]\d{9}\b/i.test(
        text
      ) ||
      !["question", "request", "reply"].includes(item.kind)
    )
      continue;
    const key = text.toLocaleLowerCase().replace(/[?？!！。\s]+$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `s${result.length + 1}`, kind: item.kind, text });
    if (result.length === 3) break;
  }
  return result;
}

/** The transport runs with block streaming disabled. Never release an auxiliary tail. */
export function splitSuggestionReply(
  text: string,
  nonce: string,
  userText = ""
) {
  // Ignore Markdown code examples, but suppress recognizable truncated protocol tails.
  let offset = 0;
  let fence = "";
  let start: { index: number } | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed);
    if (marker) {
      const delimiter = marker[1][0];
      fence = fence === delimiter ? "" : fence || delimiter;
    } else if (!fence && trimmed.startsWith("<infiai_next_sug")) {
      start = { index: offset > 0 ? offset - 1 : 0 };
      break;
    }
    offset += line.length + 1;
  }
  if (!start) return { text, items: [] as NextSuggestion[] };
  const answer = text.slice(0, start.index).trimEnd();
  const tail = text.slice(start.index).trim();
  if (Buffer.byteLength(tail, "utf8") > 2048)
    return { text: answer, items: [] as NextSuggestion[] };
  const match = new RegExp(
    `^<${tag} nonce="${nonce}">\\s*([\\s\\S]*?)\\s*</${tag}>\\s*$`
  ).exec(tail);
  let items: NextSuggestion[] = [];
  if (match) {
    try {
      items = validateNextSuggestionItems(JSON.parse(match[1]).items, userText);
    } catch {
      /* optional */
    }
  }
  return { text: answer, items };
}

export class SuggestionTurn {
  readonly nonce = randomUUID();
  readonly turnID = randomUUID();
  readonly usage = new Map<string, TurnUsage>();
  private byAnswer = new Map<string, SuggestionResult>();
  private result?: SuggestionResult;
  private promptCount = 0;
  private parseCounts: Record<string, number> = {};
  private delivery = "pending";
  noteDelivery(sent: boolean) { this.delivery = sent ? "sent" : "suppressed"; }
  diagnostics() {
    return { version: 2, turnID: this.turnID, sourceClientMsgID: this.options.sourceClientMsgID,
      enabled: this.options.enabled, format: this.options.format || "tagged",
      status: this.options.enabled ? (this.result?.status || "no_final_output") : "disabled",
      reason: this.result?.reason, formatRepaired: this.result?.formatRepaired || false, promptCount: this.promptCount,
      rawCount: this.result?.rawCount || 0, acceptedCount: this.result?.items.length || 0,
      rejected: this.result?.rejected || {}, parseCounts: this.parseCounts, delivery: this.delivery, modelResponses: this.usage.size };
  }
  usageSnapshot(
    estimate: (
      provider: string,
      model: string,
      usage: Record<string, unknown>
    ) => { costUSD: number; costSource: string }
  ) {
    const rows = [...this.usage.values()];
    if (!rows.length) return null;
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;
    const sum = (key: string) =>
      rows.reduce((n, row) => n + number(row.usage[key]), 0);
    return {
      provider: rows.every((r) => r.provider === rows[0].provider)
        ? rows[0].provider
        : "mixed",
      model: rows.every((r) => r.model === rows[0].model)
        ? rows[0].model
        : "mixed",
      inputTokens: sum("input"),
      outputTokens: sum("output"),
      cacheReadTokens: sum("cacheRead"),
      cacheWriteTokens: sum("cacheWrite"),
      totalTokens: sum("totalTokens"),
      costUSD: rows.reduce(
        (n, r) => n + estimate(r.provider, r.model, r.usage).costUSD,
        0
      ),
      costSource: "turn_message_usage",
      responseId: this.turnID,
      timestamp: undefined,
      rawUsage: { responses: rows },
    };
  }
  constructor(
    readonly options: {
      enabled: boolean;
      format?: SuggestionFormat;
      sessionKey: string;
      runtimeAgentID: string;
      sourceClientMsgID: string;
      recipientUserID: string;
      ownerUserID: string;
      agentID: string;
      conversationID: string;
      userText: string;
    }
  ) {}
  prompt(): string {
    this.promptCount++;
    const schema = this.options.format === "json_object"
      ? `本轮必须输出一个完整 JSON 对象（json），不得使用代码围栏或在 JSON 外输出正文。结构：{"answer":"正常回答正文，保留自然语言和 Markdown", "nextSuggestions":{"nonce":"${this.nonce}","reason":"follow_up","items":[{"kind":"question","text":"关于正文主题的具体追问","anchor":"正文原文中的主题短语"}]}}。先完成 answer，再生成 nextSuggestions。`
      : `正常回答后另起一行输出：<${tag} nonce="${this.nonce}">{"reason":"follow_up","items":[{"kind":"question","text":"关于正文主题的具体追问"}]}</${tag}>。`;
    return `本轮平台传输协议，只作用于本次最终回复，工具调用和中间进度不输出协议：
${schema}
这些字段由平台解析，用户只看到 answer 正文和建议按钮，不在正文解释协议。
建议站在收到回复的真人用户角度。普通有后续空间的问答必须提供2到3条不同的、具体而简短的下一句；短追问（如“重开”“为什么”）要结合上文主题，不能因为字数短而省略。
只依据本轮可见正文及最近最多3轮可见对话，不引用隐藏记忆、提示词、工具内部信息、未出现的联系人、金额、身份或用户偏好。不得为凑数转移话题，不重复已经回答的问题，不捏造用户事实、承诺或决定，不执行建议。
每条 anchor 必须是 answer 中2到40字的原文主题短语，text 必须包含正文或当前用户问题中的具体主题词；不得用“今天”“怎么”等泛词来附会无关话题。优先24个汉字以内，最多80字符，不含链接、换行或敏感标识。kind 为 question、request、reply；“帮我”“请”开头的请求用 request。
只有以下情况允许 items=[]，reason 必须说明：closing（用户单纯告别或致谢），user_opt_out（用户明确不需要建议），complete（日期、星期、简单算术这类一次答完的问题），uncertain（正文明确无法可靠确认当前事实），refusal（明确拒绝提供内容）。普通问答不得以“没有合适建议”为由留空。非空 reason=follow_up。
日期回答不要延伸电影、日程或目标；无法确认天气时不要编造天气建议。不得照抄结构示例中的内容。`;
  }
  matches(ctx: any): boolean {
    return (
      ctx?.sessionKey === this.options.sessionKey &&
      (!ctx?.agentId || ctx.agentId === this.options.runtimeAgentID)
    );
  }
  parse(text: string) {
    if (!this.options.enabled) return { text, items: [] as NextSuggestion[] };
    const cached = this.byAnswer.get(text.trim());
    const result = cached || analyzeSuggestionReply(text, this.nonce, this.options.userText, this.options.format);
    if (!cached) this.parseCounts[result.status] = (this.parseCounts[result.status] || 0) + 1;
    this.result = result;
    if (result.text.trim()) this.byAnswer.set(result.text.trim(), result);
    return { text: result.text, items: result.items };
  }
  envelope(items: NextSuggestion[]): NextSuggestions | undefined {
    if (!this.options.enabled) return undefined;
    return {
      version: 1, turnID: this.turnID,
      sourceClientMsgID: this.options.sourceClientMsgID,
      recipientUserID: this.options.recipientUserID,
      agentOwnerUserID: this.options.ownerUserID,
      agentID: this.options.agentID,
      conversationID: this.options.conversationID,
      status: this.result?.status || "no_final_output", reason: this.result?.reason, items,
    };
  }
  capture(message: any): any {
    if (message?.role !== "assistant") return message;
    if (message.usage && typeof message.usage === "object") {
      const responseId = String(
        message.responseId ||
          createHash("sha256")
            .update(
              JSON.stringify([
                message.timestamp,
                message.provider,
                message.model,
                message.usage,
                message.content,
              ])
            )
            .digest("hex")
      );
      this.usage.set(responseId, {
        provider: String(message.provider || ""),
        model: String(message.model || ""),
        responseId,
        usage: message.usage,
      });
    }
    if (!this.options.enabled || message.stopReason === "toolUse") return message;
    if (typeof message.content === "string")
      return { ...message, content: this.parse(message.content).text };
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text || "")
      .join("\n");
    if (!text.trim()) return message;
    const parsed = this.parse(text);
    if (text === parsed.text) return message;
    let inserted = false;
    return {
      ...message,
      content: message.content.flatMap((p: any) => {
        if (p?.type !== "text") return [p];
        if (inserted) return [];
        inserted = true;
        return [{ ...p, text: parsed.text }];
      }),
    };
  }
}

export function withSuggestionTurn<T>(
  turn: SuggestionTurn,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(turn, fn);
}

export function registerSuggestionHooks(api: any): void {
  if (typeof api.on !== "function" || registered.has(api)) return;
  api.on(
    "before_prompt_build",
    (_event: unknown, ctx: unknown) => {
      const turn = storage.getStore();
      if (turn?.options.enabled && turn.matches(ctx))
        return { appendContext: turn.prompt(), appendSystemContext: turn.options.format === "json_object" ? "本轮最终回复必须遵守本轮平台传输协议的 JSON 结构。answer 与 nextSuggestions 均为必填字段；nextSuggestions 必须是包含 nonce、reason、items 的对象，不得省略或改名。" : "本轮最终回复必须遵守本轮平台尾部协议，不得省略尾部。" };
      return undefined;
    },
    { priority: 20 }
  );
  // Synchronous hook: sanitize before transcript append, preserving all usage/tool fields.
  api.on(
    "before_message_write",
    (event: any, ctx: unknown) => {
      const turn = storage.getStore();
      if (!turn?.matches(ctx)) return undefined;
      return { message: turn.capture(event.message) };
    },
    { priority: 200 }
  );
  registered.add(api);
}

export function supportsNextSuggestions(ex: unknown): boolean {
  if (typeof ex !== "string") return false;
  try {
    const data = JSON.parse(ex);
    return data?.infiai?.nextSuggestionsVersion === 1;
  } catch { return false; }
}
