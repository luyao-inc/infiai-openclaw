import test from "node:test";
import assert from "node:assert/strict";

import { authorizeInfiaiSocialTool } from "./tools";

test("social tools allow the owner from the current runtime context", () => {
  assert.deepEqual(
    authorizeInfiaiSocialTool({ accountId: "acc_owner", ownerAuthorized: true }, "acc_owner"),
    { ok: true },
  );
});

test("social tools reject visitors and cross-account calls", () => {
  assert.deepEqual(
    authorizeInfiaiSocialTool({ accountId: "acc_owner", ownerAuthorized: false }, "acc_owner"),
    { ok: false, reason: "current_actor_is_not_owner" },
  );
  assert.deepEqual(
    authorizeInfiaiSocialTool({ accountId: "acc_owner", ownerAuthorized: true }, "acc_other"),
    { ok: false, reason: "account_context_mismatch" },
  );
});

test("contextless calls fail closed unless Chat can validate a scheduled task", () => {
  assert.deepEqual(authorizeInfiaiSocialTool(null, "acc_owner"), {
    ok: false,
    reason: "missing_runtime_context",
  });
  assert.deepEqual(authorizeInfiaiSocialTool(null, "acc_owner", "task_123"), { ok: true });
});
