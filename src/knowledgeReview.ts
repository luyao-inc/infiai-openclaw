import type { ModelUsageRow } from "./modelUsage";

const serviceKey = Symbol.for("infiai.knowledgeAnswerGuard.v1");
type ReviewInput = { agentId: string; sessionKey: string; startedAt: number; question: string; trustedMemoryContext?: string; ownerTeachingContext?: string; memorySubject?: "owner" | "end_user"; signal?: AbortSignal; validateMemory?: () => Promise<boolean> };
type ReviewResult = { answer: string; status: string; usages: ModelUsageRow[] };

/** One review per complete draft, shared by IM and buffered office/API turns. */
export function knowledgeReplyReview(api: any, input: ReviewInput) {
  const usages: ModelUsageRow[] = [];
  const cache = new Map<string, Promise<string>>();
  return {
    usages,
    async check(answer: string): Promise<string> {
      if (input.validateMemory && !await input.validateMemory()) return "请重新发送刚才的问题。";
      const previous = cache.get(answer);
      if (previous) return previous;
      const pending = (async () => {
        if (input.validateMemory && !await input.validateMemory()) return "请重新发送刚才的问题。";
        const service = (process as any)[serviceKey] as ((value: ReviewInput & { answer: string }) => Promise<ReviewResult>) | undefined;
        if (!service) return answer; // Older runtimes retain their existing behavior.
        const learned = input.trustedMemoryContext?.match(/\[Infiai Agent Learned Context\][\s\S]*?\[End Infiai Agent Learned Context\]/g)?.join("\n") || "";
        const privateContext = (input.trustedMemoryContext || "").replace(/\[Infiai Agent Learned Context\][\s\S]*?\[End Infiai Agent Learned Context\]\s*/g, "");
        const result = await service({ ...input, trustedMemoryContext: privateContext, ownerTeachingContext: learned, answer });
        usages.push(...result.usages);
        api.logger?.info?.(`[knowledge-answer] status=${result.status} session=${input.sessionKey} calls=${result.usages.length}`);
        if (input.validateMemory && !await input.validateMemory()) return "请重新发送刚才的问题。";
        return result.answer;
      })();
      cache.set(answer, pending);
      return pending;
    },
  };
}
