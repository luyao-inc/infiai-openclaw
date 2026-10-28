const MODEL = "qwen-image-3.0-pro";
export function createBailianImageProvider(fetcher: typeof fetch = fetch) {
  return {
    id: "infiai-bailian-image", label: "百炼图片生成", defaultModel: MODEL, models: [MODEL],
    capabilities: { generate: { maxCount: 1, supportsSize: true, supportsAspectRatio: false, supportsResolution: false }, edit: { enabled: false, maxInputImages: 0 } },
    isConfigured: () => Boolean(process.env.BAILIAN_TEXT_API_KEY?.trim()),
    generateImage: async (req: any) => {
      if (req.model !== MODEL || req.inputImages?.length || (req.count ?? 1) !== 1) throw new Error("Unsupported image request");
      const key = process.env.BAILIAN_TEXT_API_KEY?.trim();
      if (!key) throw new Error("Image service unavailable");
      const base = (process.env.BAILIAN_TEXT_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").split("/compatible-mode")[0].replace(/\/$/, "");
      const signal = AbortSignal.timeout(Math.min(req.timeoutMs || 120000, 120000));
      const response = await fetcher(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal,
        body: JSON.stringify({ model: MODEL, input: { messages: [{ role: "user", content: [{ text: req.prompt }] }] }, parameters: { n: 1, size: (req.size || "1024*1024").replace("x", "*"), prompt_extend: false } }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Image service HTTP ${response.status}`); }
      const data: any = await response.json();
      const urls = (data.output?.choices || []).flatMap((c: any) => c.message?.content || []).filter((c: any) => typeof c.image === "string").map((c: any) => c.image);
      if (urls.length !== 1) throw new Error("Image service returned no image");
      const url = new URL(urls[0]);
      if (url.protocol !== "https:" || !/(?:^|\.)(?:aliyuncs\.com|aliyun\.com)$/.test(url.hostname)) throw new Error("Invalid image result host");
      const image = await fetcher(url, { signal, redirect: "error" });
      if (!image.ok) { await image.body?.cancel(); throw new Error("Image download failed"); }
      const buffer = Buffer.from(await image.arrayBuffer());
      if (buffer.length > 20 * 1024 * 1024 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Invalid generated image");
      return { images: [{ buffer, mimeType: "image/png", fileName: "generated.png" }], model: MODEL, metadata: { requestID: data.request_id } };
    },
  };
}
