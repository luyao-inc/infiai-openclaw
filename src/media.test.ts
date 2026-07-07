import test from "node:test";
import assert from "node:assert/strict";

import { sendVoiceToTarget } from "./media";

test("sendVoiceToTarget sends URL sound messages without OSS upload", async () => {
  const calls: Array<{ name: string; payload: any }> = [];
  const message = { clientMsgID: "voice-msg" };
  const client = {
    sdk: {
      createSoundMessageByURL: async (payload: any) => {
        calls.push({ name: "createSoundMessageByURL", payload });
        return { data: message };
      },
      sendMessage: async (payload: any) => {
        calls.push({ name: "sendMessage", payload });
      },
      sendMessageNotOss: async (payload: any) => {
        calls.push({ name: "sendMessageNotOss", payload });
      },
    },
  } as any;

  await sendVoiceToTarget(
    client,
    { kind: "user", id: "target-user" },
    {
      sourceUrl: "http://127.0.0.1:10002/object/voice.mp3",
      duration: 3.4,
      dataSize: 123,
    },
    { ex: "{\"infiai\":true}" },
  );

  assert.deepEqual(
    calls.map((call) => call.name),
    ["createSoundMessageByURL", "sendMessageNotOss"],
  );
  assert.equal(calls[0].payload.soundPath, "voice.mp3");
  assert.equal(calls[0].payload.duration, 3);
  assert.equal(calls[1].payload.recvID, "target-user");
  assert.equal(calls[1].payload.groupID, "");
  assert.equal(calls[1].payload.message, message);
  assert.equal((message as any).ex, "{\"infiai\":true}");
});
