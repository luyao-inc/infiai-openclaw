import { AsyncLocalStorage } from "node:async_hooks";

export interface InfiaiToolContext {
  accountId: string;
  managedUserId: string;
  senderId: string;
  agentId: string;
  sessionKey: string;
  ownerAuthorized: boolean;
  source: "inbound" | "open_platform" | "voice_call";
}

const storage = new AsyncLocalStorage<InfiaiToolContext>();
const activeByAccountId = new Map<string, InfiaiToolContext[]>();

function normalizeAccountId(accountId?: string): string {
  return String(accountId || "").trim();
}

export async function withInfiaiToolContext<T>(
  context: InfiaiToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  const accountId = normalizeAccountId(context.accountId);
  const stack = activeByAccountId.get(accountId) ?? [];
  stack.push(context);
  activeByAccountId.set(accountId, stack);
  try {
    return await storage.run(context, fn);
  } finally {
    const current = activeByAccountId.get(accountId) ?? [];
    const index = current.lastIndexOf(context);
    if (index >= 0) current.splice(index, 1);
    if (current.length > 0) {
      activeByAccountId.set(accountId, current);
    } else {
      activeByAccountId.delete(accountId);
    }
  }
}

export function getInfiaiToolContext(accountId?: string): InfiaiToolContext | null {
  const scoped = storage.getStore();
  if (scoped) return scoped;

  const normalized = normalizeAccountId(accountId);
  if (!normalized) return null;
  const stack = activeByAccountId.get(normalized);
  return stack && stack.length > 0 ? stack[stack.length - 1] ?? null : null;
}
