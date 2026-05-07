import { resolveManagedManagedIdleResetMs } from "./managedManagedEnv";

export type ManagedManagedReplyCapState = {
  count: number;
  lastActivityAt: number;
};

const managedManagedReplyState = new Map<string, ManagedManagedReplyCapState>();

const DAY_MS = 24 * 60 * 60 * 1000;
/** Drop stale pair keys to bound memory (no effect on cap semantics). */
const MANAGED_REPLY_STATE_IDLE_PRUNE_MS = 7 * DAY_MS;

export function resolveManagedPairKey(a: string, b: string): string {
  return [a, b].map((v) => v.trim().toLowerCase()).sort().join("|");
}

/**
 * Round cap for managed↔managed bot DMs: up to maxRounds consecutive auto-replies per (pair, replyAgent).
 * If idle longer than configured seconds since last counter change, counter resets lazily.
 * When count would exceed the cap, block this reply and reset the counter to 0.
 */
export function consumeManagedManagedReplySlot(
  replyCapKey: string,
  maxRounds: number,
  now = Date.now(),
): { allowed: boolean; countAtDecision: number; maxRounds: number } {
  const idleResetMs = resolveManagedManagedIdleResetMs();

  if (managedManagedReplyState.size > 5000) {
    const pruneBefore = now - MANAGED_REPLY_STATE_IDLE_PRUNE_MS;
    for (const [k, v] of managedManagedReplyState.entries()) {
      if (v.lastActivityAt > 0 && v.lastActivityAt < pruneBefore) managedManagedReplyState.delete(k);
    }
  }

  let state = managedManagedReplyState.get(replyCapKey);

  if (!state) {
    state = { count: 0, lastActivityAt: now };
  } else if (state.lastActivityAt > 0 && now - state.lastActivityAt >= idleResetMs) {
    state = { count: 0, lastActivityAt: now };
    managedManagedReplyState.set(replyCapKey, state);
  }

  if (state.count >= maxRounds) {
    managedManagedReplyState.set(replyCapKey, { count: 0, lastActivityAt: now });
    return { allowed: false, countAtDecision: state.count, maxRounds };
  }

  state.count += 1;
  state.lastActivityAt = now;
  managedManagedReplyState.set(replyCapKey, state);
  return { allowed: true, countAtDecision: state.count, maxRounds };
}
