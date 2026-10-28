import type { ReplyDeliveryConfig } from "./reply-plan";
import { replyPartDelayMs } from "./reply-plan";
export class ReplyNotSentError extends Error {}
export class ReplyCancelledError extends Error {
  constructor() {
    super("reply delivery cancelled");
  }
}
export class ReplyCancellationScopes {
  private scopes = new Map<
    string,
    Set<{ controller: AbortController; actor: string; at: number }>
  >();
  enter(
    key: string,
    actor: string,
    at = Date.now()
  ): { signal: AbortSignal; leave: () => void } {
    const item = { controller: new AbortController(), actor, at };
    const set = this.scopes.get(key) || new Set();
    set.add(item);
    this.scopes.set(key, set);
    return {
      signal: item.controller.signal,
      leave: () => {
        set.delete(item);
        if (!set.size) this.scopes.delete(key);
      },
    };
  }
  stop(key: string, actor?: string, cutoff = Infinity) {
    for (const item of this.scopes.get(key) || [])
      if ((!actor || item.actor === actor) && item.at <= cutoff)
        item.controller.abort();
  }
}
export async function waitForReply(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new ReplyCancelledError();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ReplyCancelledError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export type PlannedPart = { text: string; messageID: string; status: string };
export async function deliverReplyPlan(
  parts: PlannedPart[],
  config: ReplyDeliveryConfig,
  callbacks: {
    signal?: AbortSignal;
    canSend: () => Promise<boolean>;
    start: (index: number) => Promise<boolean>;
    send: (part: PlannedPart, index: number) => Promise<void>;
    confirm: (index: number, part: PlannedPart) => Promise<void>;
    notSent?: (index: number) => Promise<void>;
    wait?: (ms: number) => Promise<void>;
  }
): Promise<string[]> {
  const confirmed: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (callbacks.signal?.aborted) break;
    if (i && config.pacing !== "none")
      await (callbacks.wait || ((ms) => waitForReply(ms, callbacks.signal)))(
        replyPartDelayMs(parts[i].text)
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      if (callbacks.signal?.aborted || !(await callbacks.canSend()))
        return confirmed;
      if (!(await callbacks.start(i))) break;
      try {
        await callbacks.send(parts[i], i);
      } catch (error) {
        if (error instanceof ReplyNotSentError && callbacks.notSent) {
          await callbacks.notSent(i);
          if (attempt < 2) continue;
        }
        throw error;
      }
      // Ambiguous sends are never retried; only their confirmation may be retried.
      await callbacks.confirm(i, parts[i]);
      confirmed.push(parts[i].text);
      break;
    }
  }
  return confirmed;
}

// Serialize state mutations, including heartbeats and lost-ack retries.
export class InboundReplyTurn {
  textDelivery = false;
  voiceReplyEnabled = false;
  enabled = true;
  config: ReplyDeliveryConfig = { version: 1, mode: "auto", pacing: "natural" };
  private attempts = new Map<number, number>();
  turnID = "";
  private token = "";
  private timer?: ReturnType<typeof setInterval>;
  private tail: Promise<unknown> = Promise.resolve();
  private deliveryStarted = false;
  constructor(
    private rpc: (path: string, body: Record<string, unknown>) => Promise<any>,
    private identity: Record<string, unknown>
  ) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => {});
    return p;
  }
  private request(action: string, body: Record<string, unknown> = {}) {
    return this.serialize(() => this.rpc("/claw/internal/reply-delivery/turn", {
        ...this.identity,
        turnID: this.turnID,
        token: this.token,
        action,
        ...body,
      }));
  }
  get voiceContext() { return { turnID: this.turnID, token: this.token }; }
  async setReplyMode(mode: "inherit" | "text" | "voice", scope: "conversation" | "turn") {
    const r = await this.serialize(() => this.rpc("/claw/internal/reply-preference/update", {
      ...this.identity, ...this.voiceContext, mode, scope,
    }));
    if (r.effectiveMode === "text" || r.effectiveMode === "voice") this.voiceReplyEnabled = r.effectiveMode === "voice";
    return r;
  }
  async begin() {
    const r = await this.request("begin");
    if (!r.acquired) return false;
    this.textDelivery = r.textDelivery === true;
    this.voiceReplyEnabled = r.voiceReplyEnabled === true;
    if (this.textDelivery) {
      this.turnID = r.turnID;
      this.token = r.token;
      this.config = r.config;
      this.enabled = r.enabled !== false;
      this.timer = setInterval(() => {
        void this.request("heartbeat").catch(() => {});
      }, 20000);
      this.timer.unref?.();
    }
    return true;
  }
  async canSend() {
    const r = await this.rpc("/claw/internal/reply-delivery/check", {
      ...this.identity,
      turnID: this.turnID,
      token: this.token,
    });
    // A new text choice suppresses unsent audio; never start voice midway through a text answer.
    if (r.effectiveMode === "text" || r.effectiveMode === "voice") {
      if (!this.deliveryStarted || r.effectiveMode === "text") this.voiceReplyEnabled = r.effectiveMode === "voice";
    }
    return r.allowed === true && (r.enabled !== false || !this.enabled);
  }
  async plan(
    parts: string[],
    billing: Record<string, unknown>,
    memory: Record<string, unknown>
  ): Promise<PlannedPart[]> {
    const r = await this.request("plan", { parts, billing, memory });
    return r.parts;
  }
  async start(index: number) {
    const r = await this.request("start", { index });
    if (r.send === true) this.deliveryStarted = true;
    if (r.parts?.[index]) this.attempts.set(index, r.parts[index].attempts);
    return r.send === true;
  }
  async notSent(index: number) {
    await this.request("not_sent", {
      index,
      attempt: this.attempts.get(index) || 0,
    });
  }
  async confirm(index: number, part: PlannedPart) {
    let error: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.request("sent", {
          index,
          messageID: part.messageID,
          attempt: this.attempts.get(index) || 0,
        });
        return;
      } catch (e) {
        error = e;
        await waitForReply(100 * (i + 1));
      }
    }
    throw error;
  }
  async finish(reason = "finished") {
    if (this.timer) clearInterval(this.timer);
    if (this.textDelivery) await this.request("finish", { reason });
  }
}
