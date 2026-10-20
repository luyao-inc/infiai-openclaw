import type { ModelUsageRow } from "./modelUsage";

const serviceKey = Symbol.for("infiai.knowledgeAnswerGuard.v1");
type ReviewInput = { agentId: string; sessionKey: string; startedAt: number; question: string; signal?: AbortSignal };
type ReviewResult = { answer: string; status: string; usages: ModelUsageRow[] };

/** One review per complete draft, shared by IM and buffered office/API turns. */
export function knowledgeReplyReview(api: any, input: ReviewInput) {
  const usages: ModelUsageRow[] = [];
  const cache = new Map<string, Promise<string>>();
  return {
    usages,
    check(answer: string): Promise<string> {
      const previous = cache.get(answer);
      if (previous) return previous;
      const pending = (async () => {
        const service = (process as any)[serviceKey] as ((value: ReviewInput & { answer: string }) => Promise<ReviewResult>) | undefined;
        if (!service) return answer; // Older runtimes retain their existing behavior.
        const result = await service({ ...input, answer });
        usages.push(...result.usages);
        api.logger?.info?.(`[knowledge-answer] status=${result.status} session=${input.sessionKey} calls=${result.usages.length}`);
        return result.answer;
      })();
      cache.set(answer, pending);
      return pending;
    },
  };
}
