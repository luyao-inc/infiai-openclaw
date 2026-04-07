import { getConnectedClient } from "./clients";
import { sendFileToTarget, sendImageToTarget, sendTextToTarget, sendVideoToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

export function registerOpenIMTools(api: any): void {
  if (typeof api.registerTool !== "function") return;

  const ensureTargetAndClient = (params: { target?: string; accountId?: string }) => {
    const target = parseTarget(params.target);
    if (!target) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "Invalid target format. Expected user:<id> or group:<id>." }],
        },
      };
    }
    const client = getConnectedClient(params.accountId);
    if (!client) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "Infiai is not connected." }],
        },
      };
    }
    return { ok: true as const, target, client };
  };

  api.registerTool({
    name: "infiai_send_text",
    description: "Send a text message via Infiai. target format: user:ID or group:ID.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        text: { type: "string", description: "Text to send" },
        accountId: { type: "string", description: "Optional account ID. Defaults to `default` or the first connected account." },
      },
      required: ["target", "text"],
    },
    async execute(_id: string, params: { target: string; text: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendTextToTarget(checked.client, checked.target, params.text);
        return { content: [{ type: "text", text: "Sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "infiai_send_image",
    description: "Send an image via Infiai. `image` supports a local path or an http(s) URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        image: { type: "string", description: "Local path (`file://` supported) or URL" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "image"],
    },
    async execute(_id: string, params: { target: string; image: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendImageToTarget(checked.client, checked.target, params.image);
        return { content: [{ type: "text", text: "Image sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "infiai_send_video",
    description: "Send a video via Infiai (delivered as a file message). `video` supports a local path or URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        video: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "video"],
    },
    async execute(_id: string, params: { target: string; video: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendVideoToTarget(checked.client, checked.target, params.video, params.name);
        return { content: [{ type: "text", text: "Video sent successfully as a file" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "infiai_send_file",
    description: "Send a file via Infiai. `file` supports a local path or URL; `name` is optional.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        file: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "file"],
    },
    async execute(_id: string, params: { target: string; file: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendFileToTarget(checked.client, checked.target, params.file, params.name);
        return { content: [{ type: "text", text: "File sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });
}
