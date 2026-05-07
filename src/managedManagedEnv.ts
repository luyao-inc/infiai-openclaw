/** Upper bound on maxDialogueRounds from workspace-state / env (sanity clamp). */
export const MANAGED_MAX_ROUNDS_HARD_CEILING = 1000;

/** Default idle window (seconds) before managed↔managed reply counter resets lazily. */
export const DEFAULT_MANAGED_MANAGED_IDLE_RESET_SEC = 180;

/** Internal: idle threshold in ms for Date.now() comparisons. */
export function resolveManagedManagedIdleResetMs(): number {
  const raw = String(process.env.MANAGED_AGENT_MANAGED_MANAGED_IDLE_RESET_SEC ?? "").trim();
  const n = raw ? Number(raw) : DEFAULT_MANAGED_MANAGED_IDLE_RESET_SEC;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MANAGED_MANAGED_IDLE_RESET_SEC * 1000;
  return Math.trunc(n) * 1000;
}

/** Max value allowed for maxDialogueRounds (workspace-state + env clamp). Default 10. */
export function resolveManagedMaxDialogueRoundsCap(): number {
  const raw = String(process.env.MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_CAP ?? "").trim();
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(Math.trunc(n), MANAGED_MAX_ROUNDS_HARD_CEILING);
}

/** Default max rounds when workspace-state omits maxDialogueRounds. Clamped to cap. Default 5. */
export function resolveManagedMaxDialogueRoundsDefault(): number {
  const cap = resolveManagedMaxDialogueRoundsCap();
  const raw = String(process.env.MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_DEFAULT ?? "").trim();
  const n = raw ? Number(raw) : 5;
  if (!Number.isFinite(n) || n < 1) return Math.min(5, cap);
  return Math.max(1, Math.min(cap, Math.trunc(n)));
}
