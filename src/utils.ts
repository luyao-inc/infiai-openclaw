export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatSdkError(error: unknown): string {
  const e = error as any;
  const fields: string[] = [];
  if (e?.name) fields.push(`name=${e.name}`);
  if (e?.message) fields.push(`message=${e.message}`);
  if (e?.event) fields.push(`event=${e.event}`);
  if (e?.errCode !== undefined) fields.push(`errCode=${e.errCode}`);
  if (e?.errMsg) fields.push(`errMsg=${e.errMsg}`);
  if (e?.operationID) fields.push(`operationID=${e.operationID}`);
  if (e?.data !== undefined && e?.data !== null) fields.push(`data=${safeStringify(e.data)}`);
  if (e?.stack) fields.push(`stack=${String(e.stack).split("\n").slice(0, 8).join(" | ")}`);
  if (fields.length > 0) return fields.join(", ");
  if (e instanceof Error) return e.message;
  return safeStringify(error);
}

export function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isVerboseInfiaiLogsEnabled(): boolean {
  const raw = String(process.env.INFIAI_VERBOSE_LOGS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on" || raw === "debug" || raw === "trace";
}

export function infiaiDebug(api: any, message: string): void {
  if (!isVerboseInfiaiLogsEnabled()) return;
  api?.logger?.info?.(message);
}

export function infiaiConsoleDebug(message: string): void {
  if (!isVerboseInfiaiLogsEnabled()) return;
  console.warn(message);
}

export function resolveOpenIMSdkLogLevel(): "trace" | "debug" | "info" | "warn" | "error" | "silent" {
  const raw = String(
    process.env.INFIAI_OPENIM_LOG_LEVEL ?? process.env.OPENIM_SDK_LOG_LEVEL ?? "silent",
  )
    .trim()
    .toLowerCase();
  if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "silent";
}
