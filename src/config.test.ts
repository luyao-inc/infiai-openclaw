import test from "node:test";
import assert from "node:assert/strict";

import { getOpenIMAccountConfig, listAccountIds, resolveAccountConfig } from "./config";

const validAccount = {
  enabled: true,
  userID: "u1",
  token: "token",
  wsAddr: "ws://openim:10001",
  apiAddr: "http://openim:10002",
  chatApiAddr: "http://chat:10008",
  platformID: 12,
};

test("listAccountIds ignores disabled default sentinel and keeps real accounts", () => {
  const cfg = {
    channels: {
      infiai: {
        enabled: true,
        defaultAccount: "default",
        accounts: {
          default: { enabled: false },
          acc_tenant__u1__default: validAccount,
        },
      },
    },
  };

  assert.deepEqual(listAccountIds(cfg), ["acc_tenant__u1__default"]);
  assert.equal(getOpenIMAccountConfig(cfg, "default"), null);
  assert.equal(getOpenIMAccountConfig(cfg, "acc_tenant__u1__default")?.userID, "u1");
});

test("legacy top-level default account remains supported when accounts are absent", () => {
  const cfg = {
    channels: {
      infiai: {
        ...validAccount,
        accounts: undefined,
      },
    },
  };

  assert.deepEqual(listAccountIds(cfg), ["default"]);
  assert.equal(getOpenIMAccountConfig(cfg, "default")?.accountId, "default");
});

test("missing account returns null config and preserves requested account id for resolution", () => {
  const cfg = {
    channels: {
      infiai: {
        accounts: {
          default: { enabled: false },
        },
      },
    },
  };

  assert.deepEqual(listAccountIds(cfg), []);
  assert.equal(getOpenIMAccountConfig(cfg, "missing"), null);
  assert.deepEqual(resolveAccountConfig(cfg, "missing"), { accountId: "missing" });
});
