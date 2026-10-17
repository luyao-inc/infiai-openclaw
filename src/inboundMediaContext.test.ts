import test from "node:test";
import assert from "node:assert/strict";
import { buildInboundMediaContext, promptMediaReference } from "./inboundMediaContext";

test("large WeCom image payload stays out of prompt-visible attachment notes", () => {
  const imageURL = `data:image/jpeg;base64,${"A".repeat(870_720)}`;
  const stagedPath = "/root/.openclaw/media/inbound/infiai-test/attachment-1.jpg";
  const media = {
    paths: [stagedPath], urls: [imageURL], types: ["image/jpeg"],
    workspaceDir: "/root/.openclaw/media/inbound/infiai-test",
  };
  const context = buildInboundMediaContext(media);
  assert.equal(context.MediaUrl, stagedPath);
  assert.deepEqual(context.MediaUrls, [stagedPath]);
  assert.equal(context.MediaPath, stagedPath);
  assert.equal(context.MediaType, "image/jpeg");
  assert.equal(context.MediaWorkspaceDir, media.workspaceDir);
  assert.equal(JSON.stringify(context).includes("data:"), false);
  assert.ok(JSON.stringify(context).length < 1_000);
  assert.equal(media.urls[0], imageURL, "extractor must retain the binary transport URL");
  assert.equal(promptMediaReference(imageURL, stagedPath), stagedPath,
    "image-understanding fallback must not copy the Base64 into RawBody");
});

test("mixed attachments retain order, types and ordinary URLs", () => {
  const media = {
    paths: ["/tmp/first.jpg", "/tmp/second.png", "/tmp/third.pdf"],
    urls: ["https://example.test/image.jpg", " DATA:image/png;base64,AAAA", "https://example.test/file.pdf"],
    types: ["image/jpeg", "image/png", "application/pdf"],
  };
  const context = buildInboundMediaContext(media);
  assert.deepEqual(context.MediaUrls, [media.urls[0], media.paths[1], media.urls[2]]);
  assert.equal(context.MediaUrl, media.urls[0]);
  assert.deepEqual(context.MediaTypes, media.types);
  assert.deepEqual(context.MediaPaths, media.paths);
});

test("missing staging and extraction failure cannot expose an inline payload", () => {
  assert.deepEqual(buildInboundMediaContext(null), {});
  assert.deepEqual(buildInboundMediaContext({ paths: [], urls: [], types: [] }), {});
  assert.equal(promptMediaReference("data:image/png;base64,AAAA"), "");
  assert.equal(promptMediaReference("https://example.test/image.png"), "https://example.test/image.png");
  assert.equal(promptMediaReference("data:image/png,%89PNG", "/tmp/image.png"), "/tmp/image.png");
});
