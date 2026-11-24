import test from "node:test";
import assert from "node:assert/strict";
import type { ApiService } from "@openim/client-sdk";
import { startAccountClient, stopAccountClient } from "./clients";
import { withInfiaiToolContext } from "./toolContext";

import {
  authorizeInfiaiSocialTool,
  compactPeopleSearchResult,
  publicSocialToolError,
  registerOpenIMTools,
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

test("send text binds direct authorization to the current owner self-chat", async (t) => {
  let execute!: (id: string, params: Record<string, unknown>) => Promise<any>;
  const api = {
    registerTool(tool: any) {
      if (tool.name === "infiai_send_text") execute = tool.execute;
    },
  };
  registerOpenIMTools(api);
  const accountId = "acc_default__owner__default";
  await startAccountClient(api, {
    accountId, userID: "owner", token: "fixture", enabled: true,
    wsAddr: "ws://localhost:10001", apiAddr: "http://localhost:10002",
    chatApiAddr: "http://localhost:10008",
    platformID: 12, requireMention: false, inboundWhitelist: [],
  }, { sdk: {
    on() {}, off() {}, async login() {}, async logout() {},
  } as unknown as ApiService });
  t.after(() => stopAccountClient(api, accountId));

  const requests: Record<string, unknown>[] = [];
  let response: () => Response = () => Response.json({
    errCode: 1002, errMsg: "NoPermissionError", errDlt: "managed conversation reply paused",
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return response();
  });
  const self = {
    accountId, managedUserId: "owner", senderId: "owner", agentId: "default",
    sessionKey: "self", ownerAuthorized: true, source: "inbound" as const,
    humanSelfAssistant: true,
  };
  const params = { target: "user:friend", text: "更正消息" };
  const result = await withInfiaiToolContext(self, () => execute("direct", params));
  assert.equal(requests.at(-1)?.ownerDirectSend, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false, code: "conversation_send_paused", message: "这条消息被系统拦截，未发送",
    instruction: "STOP. Report only the stated delivery outcome and any confirmed reason. Do not infer recipient settings, suggest a setting change, or retry automatically.",
  });
  for (const [context, input] of [
    [{ ...self, humanSelfAssistant: false }, { ...params, ownerDirectSend: true }],
    [{ ...self, source: "voice_call" as const }, params],
    [self, { ...params, target: "group:team" }],
    [self, { ...params, taskID: "task", runID: "run" }],
  ] as const) {
    await withInfiaiToolContext(context, () => execute("ordinary", input));
    assert.equal(requests.at(-1)?.ownerDirectSend, undefined);
  }
  const before = requests.length;
  await withInfiaiToolContext({ ...self, senderId: "visitor", ownerAuthorized: false }, () => execute("visitor", params));
  await withInfiaiToolContext(self, () => execute("other", { ...params, accountId: "some-other-account" }));
  assert.equal(requests.length, before);

  const cases = [
    [{ errCode: 1002, errMsg: "NoPermissionError", errDlt: "target user is not a friend" }, "target_not_friend"],
    [{ errCode: 1303, errMsg: "NotPeersFriend" }, "target_not_friend"],
    [{ errCode: 1302, errMsg: "BlockedByPeer" }, "send_rejected"],
    [{ errCode: 1002, errMsg: "NoPermissionError", errDlt: "not a member of target group" }, "send_rejected"],
    [{ errCode: 1002, errMsg: "NoPermissionError", errDlt: "task action is already processing or failed" }, "send_unconfirmed"],
    [{ errCode: 1002, errMsg: "NoPermissionError", errDlt: "private diagnostic details" }, "send_unconfirmed"],
    [{ errCode: 500, errMsg: "managed conversation delivery receipt unavailable" }, "send_unconfirmed"],
    [{ errCode: 0, data: {} }, "send_unconfirmed"],
    [{ ok: true, target: "user:friend", message: { serverMsgID: "message-id" } }, "send_unconfirmed"],
    [{ errCode: 0, ok: true, target: "user:friend", message: { serverMsgID: "message-id" } }, "send_unconfirmed"],
    [{ errCode: 0, data: { ok: true, target: "user:friend", message: {} } }, "send_unconfirmed"],
    [{ errCode: 0, data: { ok: true, target: "user:other", message: { serverMsgID: "message-id" } } }, "send_unconfirmed"],
  ] as const;
  for (const [body, code] of cases) {
    response = () => Response.json(body);
    const result = await withInfiaiToolContext(self, () => execute("failure", params));
    const reply = JSON.parse(result.content[0].text);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, code);
    assert.match(reply.instruction, /or retry automatically/);
    assert.doesNotMatch(reply.message, /查看|private diagnostic details|BlockedByPeer/);
    assert.match(reply.message, code === "send_unconfirmed" ? /无法确认.*是否送达/ : /未发送/);
  }

  response = () => { throw new Error("network timeout"); };
  const beforeTimeout = requests.length;
  const timeout = await withInfiaiToolContext(self, () => execute("timeout", params));
  assert.equal(JSON.parse(timeout.content[0].text).code, "send_unconfirmed");
  assert.equal(requests.length, beforeTimeout + 1);

  const receipt = { ok: true, target: "user:friend", message: { serverMsgID: "message-id" } };
  response = () => Response.json({ errCode: 0, data: receipt });
  const sent = await withInfiaiToolContext(self, () => execute("success", params));
  assert.deepEqual(JSON.parse(sent.content[0].text), receipt);
});
