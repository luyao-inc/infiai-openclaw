type StagedMediaReferences = {
  paths: string[];
  urls: string[];
  types: string[];
  workspaceDir?: string;
};

/** Data URLs are transport payloads, never prompt-visible attachment URLs. */
export function promptMediaReference(url: string, stagedPath = ""): string {
  return /^data:/i.test(url.trim()) ? stagedPath : url;
}

export function buildInboundMediaContext(media?: StagedMediaReferences | null) {
  if (!media?.paths.length) return {};
  // OpenClaw includes MediaUrl(s) verbatim in its text attachment note. Keep
  // positional alignment for mixed attachments, while retaining the original
  // URLs in the staging result for extraction and binary image processing.
  const urls = media.paths.map((stagedPath, index) =>
    promptMediaReference(media.urls[index] || "", stagedPath)
  );
  return {
    MediaPath: media.paths[0],
    MediaPaths: media.paths,
    MediaWorkspaceDir: media.workspaceDir,
    MediaUrl: urls[0],
    MediaType: media.types[0],
    MediaUrls: urls,
    MediaTypes: media.types,
  };
}
