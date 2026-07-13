export class BoundedExpiringCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  get(key: string, now = Date.now()): T | undefined {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(
    key: string,
    value: T,
    options: { expiresAt: number; maxEntries: number; now?: number },
  ): void {
    const now = options.now ?? Date.now();
    this.pruneExpired(now);

    // Reinsert updates the insertion order, so capacity eviction removes the
    // oldest cached identity rather than a recently refreshed one.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: options.expiresAt });

    const maxEntries = Math.max(1, Math.floor(options.maxEntries));
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [key, item] of this.entries) {
      if (item.expiresAt > now) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
