import assert from "node:assert/strict";
import test from "node:test";

import { BoundedExpiringCache } from "./expiringCache";

test("bounded cache prunes expired entries before enforcing capacity", () => {
  const cache = new BoundedExpiringCache<string>();
  cache.set("expired", "old", { expiresAt: 10, maxEntries: 2, now: 0 });
  cache.set("fresh", "one", { expiresAt: 100, maxEntries: 2, now: 20 });
  cache.set("new", "two", { expiresAt: 100, maxEntries: 2, now: 20 });

  assert.equal(cache.size, 2);
  assert.equal(cache.get("expired", 20), undefined);
  assert.equal(cache.get("fresh", 20), "one");
  assert.equal(cache.get("new", 20), "two");
});

test("bounded cache evicts the oldest entry and refresh moves a key to the end", () => {
  const cache = new BoundedExpiringCache<string>();
  cache.set("a", "a1", { expiresAt: 100, maxEntries: 2, now: 0 });
  cache.set("b", "b", { expiresAt: 100, maxEntries: 2, now: 0 });
  cache.set("a", "a2", { expiresAt: 100, maxEntries: 2, now: 0 });
  cache.set("c", "c", { expiresAt: 100, maxEntries: 2, now: 0 });

  assert.equal(cache.size, 2);
  assert.equal(cache.get("a", 1), "a2");
  assert.equal(cache.get("b", 1), undefined);
  assert.equal(cache.get("c", 1), "c");
});
