import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenIMChannelPlugin } from "./channel";
import { startAccountClient, stopAllClients } from "./clients";

const api = { config: {}, logger: { info() {}, warn() {}, error() {} } };
afterEach(() => stopAllClients(api));

async function connect(accountId: string, fail = "") {
  const calls: Array<{ name: string; payload: any }> = [];
  const record = async (name: string, payload: any) => {
    calls.push({ name, payload });
    if (name === fail) throw new Error("test send failed");
    return { data: { clientMsgID: `${accountId}-${name}`, contentType: name.includes("Image") ? 102 : 101 } };
  };
  await startAccountClient(api, {
    accountId, enabled: true, userID: accountId, token: "test-token",
    wsAddr: "ws://test.invalid", apiAddr: "http://test.invalid", platformID: 12,
    requireMention: false, inboundWhitelist: [],
  }, { sdk: {
    on() {}, off() {}, async login() {}, async logout() {},
    createImageMessageByFile: (p: any) => record("createImageMessageByFile", p),
    createImageMessageByURL: (p: any) => record("createImageMessageByURL", p),
    createTextMessage: (p: any) => record("createTextMessage", p),
    sendMessage: (p: any) => record("sendMessage", p),
    sendMessageNotOss: (p: any) => record("sendMessageNotOss", p),
  } as any });
  return calls;
}

test("outbound sends a generated local image and caption with the selected account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lingxie-image-"));
  try {
    const image = path.join(dir, "guide.png");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLPsAAAAASUVORK5CYII=", "base64"));
    const other = await connect("other");
    const selected = await connect("selected");
    const result = await OpenIMChannelPlugin.outbound.sendMedia({ to: "user:owner", accountId: "selected", text: "这是示意图。", mediaUrl: image });
    assert.deepEqual(result, { channel: "infiai", messageId: "selected-createImageMessageByFile" });
    assert.deepEqual(other, []);
    assert.deepEqual(selected.map(c => c.name), ["createImageMessageByFile", "sendMessage", "createTextMessage", "sendMessage"]);
    assert.equal(selected[0].payload.sourcePath, image);
    assert.equal(selected[0].payload.file.type, "image/png");
    assert.equal(selected[1].payload.recvID, "owner");
    assert.equal(selected[1].payload.message.contentType, 102);
    assert.equal(selected[2].payload, "这是示意图。");
    assert.equal(selected[3].payload.recvID, "owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbound sends URL images to a group without uploading them again", async () => {
  const calls = await connect("group-account");
  const result = await OpenIMChannelPlugin.outbound.sendMedia({ to: "group:group-id", accountId: "group-account", text: "", mediaUrl: "https://example.invalid/guide.png" });
  assert.equal(result.messageId, "group-account-createImageMessageByURL");
  assert.deepEqual(calls.map(c => c.name), ["createImageMessageByURL", "sendMessageNotOss"]);
  assert.equal(calls[0].payload.sourcePicture.url, "https://example.invalid/guide.png");
  assert.equal(calls[1].payload.recvID, "");
  assert.equal(calls[1].payload.groupID, "group-id");
});

test("image failures reject instead of reporting a successful delivery", async (t) => {
  await t.test("disconnected account", async () => {
    await assert.rejects(OpenIMChannelPlugin.outbound.sendMedia({ to: "user:owner", text: "", mediaUrl: "https://example.invalid/guide.png" }), /not connected/);
  });
  const calls = await connect("failures");
  await assert.rejects(OpenIMChannelPlugin.outbound.sendMedia({ to: "", text: "", mediaUrl: "x" }), /invalid target/);
  await assert.rejects(OpenIMChannelPlugin.outbound.sendMedia({ to: "user:owner", text: "" }), /image is empty/);
  await assert.rejects(OpenIMChannelPlugin.outbound.sendMedia({ to: "user:owner", text: "", mediaUrl: path.join(tmpdir(), "missing-lingxie-image", "guide.png") }), /ENOENT/);
  assert.deepEqual(calls, []);
  for (const stage of ["createImageMessageByURL", "sendMessageNotOss", "createTextMessage"]) {
    await t.test(stage, async () => {
      await connect(stage, stage);
      await assert.rejects(OpenIMChannelPlugin.outbound.sendMedia({ to: "user:owner", accountId: stage, text: "图片说明", mediaUrl: "https://example.invalid/guide.png" }), /test send failed/);
    });
  }
});
