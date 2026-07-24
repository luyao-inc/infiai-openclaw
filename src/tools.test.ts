import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeInfiaiSocialTool,
  compactPeopleSearchResult,
  publicSocialToolError,
} from "./tools";

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

test("public people search results exclude large internal prompts and expose pagination", () => {
  const result = compactPeopleSearchResult(
    {
      total: 21,
      list: [
        {
          userID: "u1",
          nickname: "Echo",
          description: "x".repeat(300),
          purpose: "large internal role prompt",
          friendCount: 3,
          isFriend: true,
        },
      ],
    },
    2,
    10,
  );
  assert.equal(result.list[0].description.length, 241);
  assert.equal("purpose" in result.list[0], false);
  assert.equal(result.hasMore, true);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 10);
});

test("social tool errors never expose SDK stacks to the model", () => {
  assert.deepEqual(
    publicSocialToolError(
      new Error("NoPermissionError\n    at internal/secret/path/tools.js:10"),
    ),
    {
      code: "permission_denied",
      message: "当前账号没有权限查看这些内容",
    },
  );
});
