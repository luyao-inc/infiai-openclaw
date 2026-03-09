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
  if (e?.event) fields.push(`event=${e.event}`);
  if (e?.errCode !== undefined) fields.push(`errCode=${e.errCode}`);
  if (e?.errMsg) fields.push(`errMsg=${e.errMsg}`);
  if (e?.operationID) fields.push(`operationID=${e.operationID}`);
  if (e?.data !== undefined && e?.data !== null) fields.push(`data=${safeStringify(e.data)}`);
  if (fields.length > 0) return fields.join(", ");
  if (e instanceof Error) return e.message;
  return safeStringify(error);
}

export function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
