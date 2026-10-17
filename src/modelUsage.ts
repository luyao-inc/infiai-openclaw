export type ModelUsageRow = { provider: string; model: string; usage: Record<string, unknown>; responseId?: string };

// Runtime reports token buckets only. Chat is the single CNY pricing authority.
export function aggregateModelUsage(rows: ModelUsageRow[], responseId: string) {
  if (!rows.length) return null;
  const number = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
  const sum = (key: string) => rows.reduce((n, r) => n + number(r.usage[key]), 0);
  const input = sum("input"), output = sum("output"), cacheRead = sum("cacheRead"), cacheWrite = sum("cacheWrite");
  return {
    provider: rows.every((r) => r.provider === rows[0].provider) ? rows[0].provider : "mixed",
    model: rows.every((r) => r.model === rows[0].model) ? rows[0].model : "mixed",
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    totalTokens: sum("totalTokens") || input + output + cacheRead + cacheWrite,
    responseId, timestamp: undefined as string | undefined,
    rawUsage: { input, output, cacheRead, cacheWrite, responses: rows },
  };
}
