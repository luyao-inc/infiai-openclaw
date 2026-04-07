import type { ParsedTarget } from "./types";

export function parseTarget(to?: string): ParsedTarget | null {
  const raw = String(to ?? "").trim();
  if (!raw) return null;

  const t = raw.replace(/^(openim|infiai):/i, "");
  if (t.startsWith("user:")) {
    const id = t.slice("user:".length).trim();
    return id ? { kind: "user", id } : null;
  }
  if (t.startsWith("group:")) {
    const id = t.slice("group:".length).trim();
    return id ? { kind: "group", id } : null;
  }

  return { kind: "user", id: t };
}

export function getRecvAndGroupID(target: ParsedTarget): { recvID: string; groupID: string } {
  return {
    recvID: target.kind === "user" ? target.id : "",
    groupID: target.kind === "group" ? target.id : "",
  };
}
