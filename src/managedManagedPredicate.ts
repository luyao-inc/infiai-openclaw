/**
 * True when this OpenIM user is actively routed through Infiai on this gateway:
 * account exists, infiai binding exists, and agent entry exists (matches orchestrator unbind semantics).
 */
export function isUserInfiaiManagedInCfg(cfg: any, openImUserId: string): boolean {
  const uid = String(openImUserId ?? "").trim();
  if (!uid) return false;

  const accounts = cfg?.channels?.infiai?.accounts;
  if (!accounts || typeof accounts !== "object") return false;

  const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const agentsList = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const agentIds = new Set(
    agentsList.map((e: any) => String(e?.id ?? "").trim()).filter(Boolean),
  );

  for (const [accountKey, raw] of Object.entries(accounts as Record<string, unknown>)) {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const userID = String(row.userID ?? "").trim();
    if (userID !== uid) continue;

    const ak = String(accountKey ?? "").trim();
    if (!ak) continue;

    for (const b of bindings) {
      if (!b || typeof b !== "object") continue;
      const m = (b as { match?: unknown }).match;
      if (!m || typeof m !== "object") continue;
      const match = m as { channel?: unknown; accountId?: unknown };
      if (String(match.channel ?? "") !== "infiai") continue;
      if (String(match.accountId ?? "") !== ak) continue;
      const agentId = String((b as { agentId?: unknown }).agentId ?? "").trim();
      if (agentId && agentIds.has(agentId)) return true;
    }
  }

  return false;
}

/** OpenClaw agent id bound to this Infiai account (for round-cap + workspace-state; independent of resolveAgentRoute). */
export function resolveInfiaiAgentIdForAccount(cfg: any, accountId: string): string | null {
  const aid = String(accountId ?? "").trim();
  if (!aid) return null;
  const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  for (const b of bindings) {
    if (!b || typeof b !== "object") continue;
    const m = (b as { match?: unknown }).match;
    if (!m || typeof m !== "object") continue;
    const match = m as { channel?: unknown; accountId?: unknown };
    if (String(match.channel ?? "") !== "infiai") continue;
    if (String(match.accountId ?? "") !== aid) continue;
    const agentId = String((b as { agentId?: unknown }).agentId ?? "").trim();
    return agentId || null;
  }
  return null;
}
