import { SessionType, type MessageItem } from "@openim/client-sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeManagedManagedReplySlot, resolveManagedPairKey } from "./managedManagedCap";
import { resolveManagedMaxDialogueRoundsCap, resolveManagedMaxDialogueRoundsDefault } from "./managedManagedEnv";
import { isUserInfiaiManagedInCfg, resolveInfiaiAgentIdForAccount } from "./managedManagedPredicate";
import { sendTextToTarget } from "./media";
import { ensureInfiaiReplyReady } from "./replyHeal";
import type { ChatType, InboundBodyResult, InboundMediaItem, OpenIMClientState, ParsedTarget } from "./types";
import { formatSdkError } from "./utils";

const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
/** Short TTL so workspace-state updates after toggling memory apply within a turn. */
const MEMORY_POLICY_CACHE_TTL_MS = 500;

function transcriptObsEnabled(): boolean {
  const v = String(process.env.OPENCLAW_TRANSCRIPT_OBSERVABILITY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function obsInboundLog(api: any, event: string, fields: Record<string, unknown>): void {
  if (!transcriptObsEnabled()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: "infiai-gateway-obs",
    event,
    ...fields,
  });
  api.logger?.info?.(`[openclaw-obs] ${line}`);
}
const memoryPolicyCache = new Map<string, { expireAt: number; enabled: boolean }>();
type ImagePart = { type: "image"; data: string; mimeType: string };

function resolveWorkspaceStatePath(agentEntry: any): string {
  const rawWorkspace = String(agentEntry?.workspace ?? "").trim();
  if (!rawWorkspace) return "";
  const expanded = rawWorkspace.startsWith("~/") ? path.join(os.homedir(), rawWorkspace.slice(2)) : rawWorkspace;
  return path.join(expanded, ".openclaw", "workspace-state.json");
}

/**
 * Workspace-state carries both legacy conversationMemoryEnabled and profile memoryEnabled.
 * Host UI toggles memoryEnabled only; continuity must be off if either flag is explicitly false.
 */
async function readSessionContinuityFromWorkspaceState(agentEntry: any): Promise<boolean | null> {
  const statePath = resolveWorkspaceStatePath(agentEntry);
  if (!statePath) return null;
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const mem = parsed?.memoryEnabled;
    const conv = parsed?.conversationMemoryEnabled;
    if (mem === false || conv === false) return false;
    const hasMem = typeof mem === "boolean";
    const hasConv = typeof conv === "boolean";
    if (!hasMem && !hasConv) return null;
    return true;
  } catch {
    return null;
  }
}

/**
 * Whether Infiai inbound messages join the stable OpenClaw thread for this peer.
 * Source of truth: workspace-state.json (synced from Mongo by orchestrator).
 *
 * Do not gate this on cfg.agents.list[].memorySearch.enabled — that flag tracks semantic
 * memory search tooling and may be toggled independently in Control UI; tying it here
 * caused stable-session chats to fall through to :ephemeral: keys while profile memory stayed on.
 */
async function resolveInfiaiSessionContinuityEnabled(cfg: any, agentId: string): Promise<boolean> {
  const cacheKey = String(agentId || "main");
  const now = Date.now();
  const cached = memoryPolicyCache.get(cacheKey);
  if (cached && cached.expireAt > now) return cached.enabled;

  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const agentEntry = list.find((item: any) => item && String(item.id ?? "") === cacheKey) ?? null;
  const sessionContinuity = await readSessionContinuityFromWorkspaceState(agentEntry);
  const effectiveEnabled = sessionContinuity ?? true;
  memoryPolicyCache.set(cacheKey, { enabled: effectiveEnabled, expireAt: now + MEMORY_POLICY_CACHE_TTL_MS });
  return effectiveEnabled;
}

async function readMaxDialogueRoundsFromWorkspaceState(agentEntry: any): Promise<number | null> {
  const statePath = resolveWorkspaceStatePath(agentEntry);
  if (!statePath) return null;
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const n = Number(parsed?.maxDialogueRounds);
    if (!Number.isFinite(n)) return null;
    const cap = resolveManagedMaxDialogueRoundsCap();
    return Math.max(1, Math.min(cap, Math.trunc(n)));
  } catch {
    return null;
  }
}

async function resolveInfiaiMaxDialogueRounds(cfg: any, agentId: string): Promise<number> {
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const item = list.find((entry: any) => entry && String(entry.id ?? "") === String(agentId || "main"));
  const fromWorkspace = await readMaxDialogueRoundsFromWorkspaceState(item);
  if (fromWorkspace && fromWorkspace > 0) return fromWorkspace;
  return resolveManagedMaxDialogueRoundsDefault();
}

/**
 * Platform ID used when the managed pool logs into OpenIM as the bot tenant (must match
 * chat/orchestrator `OPENCLAW_MANAGED_IM_PLATFORM`, typically 12). Real users send from
 * Web/iOS/Android with other IDs — see OpenIM `senderPlatformID` on messages.
 */
function resolveManagedImBotPlatformId(): number {
  const raw = String(process.env.OPENCLAW_MANAGED_IM_PLATFORM ?? process.env.INFIAI_MANAGED_IM_PLATFORM ?? "").trim();
  if (!raw) return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.trunc(n);
}

/** True only if this inbound looks like another managed-runtime send (bot↔bot), not a human client. */
function isInboundFromManagedBotSession(msg: MessageItem): boolean {
  const m = msg as MessageItem & { senderPlatformID?: number };
  const pid = Number(m.senderPlatformID);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return pid === resolveManagedImBotPlatformId();
}

function normalizeImageMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.startsWith("image/") ? mime : undefined;
}

function normalizeMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.includes("/") ? mime : undefined;
}

function normalizeString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeSize(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function summarizeMedia(item: InboundMediaItem): string {
  if (item.kind === "image") {
    return item.url ? `[Image] ${item.url}` : "[Image message]";
  }

  if (item.kind === "video") {
    const parts = ["[Video]"];
    if (item.fileName) parts.push(`name=${item.fileName}`);
    if (item.url) parts.push(`video=${item.url}`);
    if (item.snapshotUrl) parts.push(`snapshot=${item.snapshotUrl}`);
    if (item.size) parts.push(`size=${item.size}`);
    return parts.join(" ");
  }

  const parts = ["[File]"];
  if (item.fileName) parts.push(`name=${item.fileName}`);
  if (item.mimeType) parts.push(`type=${item.mimeType}`);
  if (item.url) parts.push(`url=${item.url}`);
  if (item.size) parts.push(`size=${item.size}`);
  return parts.join(" ");
}

/** Drop model "Reasoning:/Thinking:" preambles that some providers still emit as plain text. */
function stripVisibleReasoningPreamble(text: string): string {
  let s = String(text ?? "").replace(/\r\n/g, "\n");
  let prev = "";
  while (s !== prev) {
    prev = s;
    const parts = s.split(/\n\n+/);
    if (parts.length < 2) break;
    const head = parts[0].trim();
    if (
      /^reasoning\s*:/i.test(head) ||
      /^thinking\s*:/i.test(head) ||
      /^thought\s*:/i.test(head) ||
      /^分析\s*[:：]/i.test(head)
    ) {
      s = parts.slice(1).join("\n\n").trim();
    }
  }
   return s;
}

/** Remove provider/model placeholders that leak into user-visible replies. */
function stripInfiaiReplyArtifacts(text: string): string {
  let s = String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
  let prev = "";
  while (s !== prev) {
    prev = s;
    // Do not require whitespace before NO_REPLY — CJK punctuation is often glued (e.g. "烦不烦？NO_REPLY").
    s = s.replace(/NO_REPLY\.?\s*$/i, "").trimEnd();
    s = s.replace(/NO_ANSWER\.?\s*$/i, "").trimEnd();
  }
  const lines = s.split("\n");
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? "").trim();
    if (last === "" || /^NO_REPLY\.?$/i.test(last) || /^NO_ANSWER\.?$/i.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

function mergeInboundResults(parts: Array<InboundBodyResult | null | undefined>): InboundBodyResult {
  const valid = parts.filter(Boolean) as InboundBodyResult[];
  if (valid.length === 0) return { body: "", kind: "unknown" };

  const bodies = valid.map((item) => item.body).filter(Boolean);
  const media = valid.flatMap((item) => item.media ?? []);
  if (valid.length === 1) {
    return {
      body: bodies[0] || "",
      kind: valid[0].kind,
      media: media.length > 0 ? media : undefined,
    };
  }

  return {
    body: bodies.join("\n"),
    kind: "mixed",
    media: media.length > 0 ? media : undefined,
  };
}

async function fetchImageAsContentPart(url: string, hintedMimeType?: string): Promise<ImagePart> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`image fetch timeout after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`image fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buffer.byteLength} bytes`);
  }

  const mimeType = normalizeImageMimeType(response.headers.get("content-type")) ?? normalizeImageMimeType(hintedMimeType) ?? "image/jpeg";
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
  };
}

function buildTextEnvelope(
  runtime: any,
  cfg: any,
  fromLabel: string,
  senderId: string,
  timestamp: number,
  bodyText: string,
  chatType: ChatType
): string {
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const formatted = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "Infiai",
    from: fromLabel,
    timestamp,
    body: bodyText,
    chatType,
    sender: { name: fromLabel, id: senderId },
    envelope: envelopeOptions,
  });
  return typeof formatted === "string" ? formatted : bodyText;
}

async function materializeInboundMedia(media: InboundMediaItem[] | undefined): Promise<{ images: ImagePart[]; warnings: string[] }> {
  if (!Array.isArray(media) || media.length === 0) {
    return { images: [], warnings: [] };
  }

  const images: ImagePart[] = [];
  const warnings: string[] = [];

  for (const item of media) {
    try {
      if (item.kind === "image" && item.url) {
        images.push(await fetchImageAsContentPart(item.url, item.mimeType));
        continue;
      }

      if (item.kind === "video" && item.snapshotUrl) {
        images.push(await fetchImageAsContentPart(item.snapshotUrl));
        continue;
      }
    } catch (err) {
      warnings.push(`${summarizeMedia(item)} => ${formatSdkError(err)}`);
    }
  }

  return { images, warnings };
}

function extractPictureMedia(msg: MessageItem): InboundMediaItem[] {
  const pic = msg.pictureElem;
  if (!pic) return [];
  const source = pic.sourcePicture;
  const big = pic.bigPicture;
  const snapshot = pic.snapshotPicture;
  const url = normalizeString(source?.url) || normalizeString(big?.url) || normalizeString(snapshot?.url);
  const mimeType = normalizeImageMimeType(source?.type) || normalizeImageMimeType(big?.type) || normalizeImageMimeType(snapshot?.type);
  return [{ kind: "image", url, mimeType }];
}

function extractVideoMedia(msg: MessageItem): InboundMediaItem[] {
  const video = msg.videoElem as any;
  if (!video) return [];
  return [
    {
      kind: "video",
      url: normalizeString(video.videoUrl),
      snapshotUrl: normalizeString(video.snapshotUrl),
      fileName: normalizeString(video.videoName ?? video.fileName ?? video.snapshotName),
      size: normalizeSize(video.videoSize ?? video.duration),
      mimeType: normalizeMimeType(video.videoType ?? video.type),
    },
  ];
}

function extractFileMedia(msg: MessageItem): InboundMediaItem[] {
  const file = msg.fileElem as any;
  if (!file) return [];
  return [
    {
      kind: "file",
      url: normalizeString(file.sourceUrl),
      fileName: normalizeString(file.fileName),
      size: normalizeSize(file.fileSize),
      mimeType: normalizeMimeType(file.fileType ?? file.type),
    },
  ];
}

function extractInboundBody(msg: MessageItem, depth = 0): InboundBodyResult {
  const text = String(msg.textElem?.content ?? msg.atTextElem?.text ?? "").trim();
  const imageMedia = extractPictureMedia(msg);
  const videoMedia = extractVideoMedia(msg);
  const fileMedia = extractFileMedia(msg);

  if (msg.quoteElem?.quoteMessage) {
    const quotedMsg = msg.quoteElem.quoteMessage;
    const quotedSender = String(quotedMsg.senderNickname || quotedMsg.sendID || "unknown");
    const quoted = depth < 2 ? extractInboundBody(quotedMsg, depth + 1) : { body: "[quoted message]", kind: "mixed" as const };
    const currentParts: string[] = [];
    if (text) currentParts.push(`Reply: ${text}`);
    for (const item of [...imageMedia, ...videoMedia, ...fileMedia]) {
      currentParts.push(`Reply attachment: ${summarizeMedia(item)}`);
    }

    const bodyLines = [`[Quote] ${quotedSender}: ${quoted.body || "[empty message]"}`];
    if (currentParts.length > 0) bodyLines.push(currentParts.join("\n"));

    return {
      body: bodyLines.join("\n"),
      kind: currentParts.length > 0 ? "mixed" : quoted.kind,
      media: [...imageMedia, ...videoMedia, ...fileMedia],
    };
  }

  const parts: InboundBodyResult[] = [];
  if (text) parts.push({ body: text, kind: "text" });

  for (const item of imageMedia) {
    parts.push({ body: summarizeMedia(item), kind: "image", media: [item] });
  }
  for (const item of videoMedia) {
    parts.push({ body: summarizeMedia(item), kind: "video", media: [item] });
  }
  for (const item of fileMedia) {
    parts.push({ body: summarizeMedia(item), kind: "file", media: [item] });
  }

  if (msg.customElem?.data || msg.customElem?.description || msg.customElem?.extension) {
    const customText = msg.customElem.description || msg.customElem.data || msg.customElem.extension || "[Custom message]";
    parts.push({ body: `[Custom message] ${customText}`, kind: "mixed" });
  }

  return mergeInboundResults(parts);
}

function shouldProcessInboundMessage(accountId: string, msg: MessageItem): boolean {
  const idPart = String(msg.clientMsgID || msg.serverMsgID || `${msg.sendID}-${msg.seq || msg.createTime || 0}`);
  if (!idPart) return true;

  const key = `${accountId}:${idPart}`;
  const now = Date.now();
  const last = inboundDedup.get(key);
  inboundDedup.set(key, now);

  if (inboundDedup.size > 2000) {
    for (const [k, ts] of inboundDedup.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundDedup.delete(k);
    }
  }

  return !(last && now - last < INBOUND_DEDUP_TTL_MS);
}

function isGroupMessage(msg: MessageItem): boolean {
  return msg.sessionType === SessionType.Group && !!msg.groupID;
}

function isMentionedInGroup(msg: MessageItem, selfUserID: string): boolean {
  const list = msg.atTextElem?.atUserList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const id = String(selfUserID);
  return list.some((item) => String(item) === id);
}

function isWhitelistedSender(client: OpenIMClientState, msg: MessageItem): boolean {
  const whitelist = client.config.inboundWhitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  const senderId = String(msg.sendID || "").trim();
  if (!senderId) return false;
  return whitelist.some((id) => id === senderId);
}

async function sendReplyFromInbound(client: OpenIMClientState, msg: MessageItem, text: string): Promise<void> {
  const isGroup = isGroupMessage(msg);
  const target: ParsedTarget = isGroup ? { kind: "group", id: String(msg.groupID) } : { kind: "user", id: String(msg.sendID) };
  await sendTextToTarget(client, target, text);
}

export async function processInboundMessage(api: any, client: OpenIMClientState, msg: MessageItem): Promise<void> {
  await ensureInfiaiReplyReady(api);

  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[infiai] runtime.channel.reply not available after self-heal");
    return;
  }

  if (String(msg.sendID) === String(client.config.userID)) {
    return;
  }
  if (!shouldProcessInboundMessage(client.config.accountId, msg)) {
    api.logger?.info?.(
      `[infiai] inbound dedup skip: accountId=${client.config.accountId} clientMsgID=${msg.clientMsgID || ""} serverMsgID=${msg.serverMsgID || ""} sendID=${msg.sendID}`
    );
    return;
  }

  const inbound = extractInboundBody(msg);
  if (!inbound.body) {
    api.logger?.info?.(
      `[infiai] ignore unsupported message: contentType=${msg.contentType}, clientMsgID=${msg.clientMsgID || "unknown"}`
    );
    return;
  }

  const group = isGroupMessage(msg);
  const mentioned = group && isMentionedInGroup(msg, client.config.userID);
  const hasWhitelist = client.config.inboundWhitelist.length > 0;
  if (hasWhitelist) {
    if (!isWhitelistedSender(client, msg)) {
      return;
    }
    if (group && !mentioned) {
      return;
    }
  } else if (group && client.config.requireMention && !mentioned) {
    return;
  }

  // 单聊不能只按 sendID（对端用户）建 session：同一真人发给两个托管号时 sendID 相同，
  // 会合并成一条 OpenClaw 会话、同一条 agent 记忆与 dashboard 线程。必须纳入本侧托管号 userID。
  const selfUid = String(client.config.userID).trim();
  const accountScope = String(client.config.accountId || selfUid || "default").trim().toLowerCase();
  const baseSessionKey = group
    ? `infiai:group:${accountScope}:${String(msg.groupID).trim()}`.toLowerCase()
    : `infiai:direct:${selfUid}:${String(msg.sendID).trim()}`.toLowerCase();
  const cfg = api.config;

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      sessionKey: baseSessionKey,
      channel: "infiai",
      accountId: client.config.accountId,
    }) ?? { agentId: "main", sessionKey: baseSessionKey };

  const sessionKey = String(route?.sessionKey ?? baseSessionKey).trim() || baseSessionKey;
  const timestamp = msg.sendTime || Date.now();
  const sessionContinuityEnabled = await resolveInfiaiSessionContinuityEnabled(cfg, String(route?.agentId ?? "main"));
  const effectiveSessionKey = sessionContinuityEnabled
    ? sessionKey
    : `${sessionKey}:ephemeral:${msg.clientMsgID || msg.serverMsgID || timestamp}`;

  const storePath =
    runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
      agentId: route.agentId,
    }) ?? "";

  const chatType: ChatType = group ? "group" : "direct";
  const fromLabel = String(msg.senderNickname || msg.sendID);
  const senderId = String(msg.sendID);
  const selfManaged = isUserInfiaiManagedInCfg(cfg, selfUid);
  const senderManaged = isUserInfiaiManagedInCfg(cfg, senderId);
  // Round-cap only for managed↔managed **bot traffic**. Same OpenIM userId may also log in as a
  // human (e.g. Web); those sends carry a non-bot senderPlatformID and must not trip the cap.
  if (!group && selfManaged && senderManaged && isInboundFromManagedBotSession(msg)) {
    const pairKey = resolveManagedPairKey(selfUid, senderId);
    const routeAgentId = String(route?.agentId ?? "main");
    // Round-cap must follow cfg.bindings for this account — resolveAgentRoute can point at another
    // tenant's agent (wrong session) while the Infiai account is still correctly provisioned.
    const replyAgentForCap = resolveInfiaiAgentIdForAccount(cfg, client.config.accountId) ?? routeAgentId;
    if (replyAgentForCap !== routeAgentId) {
      api.logger?.info?.(
        `[infiai] managed round-cap: using binding agent ${replyAgentForCap} (resolveAgentRoute=${routeAgentId}) accountId=${client.config.accountId}`
      );
    }
    const replyCapKey = `${pairKey}|reply|${replyAgentForCap}`;
    const maxDialogueRounds = await resolveInfiaiMaxDialogueRounds(cfg, replyAgentForCap);
    const slot = consumeManagedManagedReplySlot(replyCapKey, maxDialogueRounds);
    if (!slot.allowed) {
      api.logger?.warn?.(
        `[infiai] managed dialogue capped: pair=${pairKey}, replyAgent=${replyAgentForCap}, reason=round_cap count=${slot.countAtDecision}, maxRounds=${slot.maxRounds}, counterReset=1, session=${effectiveSessionKey}, clientMsgID=${msg.clientMsgID || ""}`
      );
      return;
    }
  }
  const mediaResult = await materializeInboundMedia(inbound.media);
  const warningText = mediaResult.warnings.map((warning) => `[Media fetch failed] ${warning}`).join("\n");
  const rawBody = warningText ? `${inbound.body}\n${warningText}` : inbound.body;
  const body = buildTextEnvelope(runtime, cfg, fromLabel, senderId, timestamp, rawBody, chatType);

  if (mediaResult.warnings.length > 0) {
    for (const warning of mediaResult.warnings) {
      api.logger?.warn?.(`[infiai] inbound media fetch failed: ${warning}`);
    }
  }

  const ctxPayload = {
    Body: body,
    RawBody: rawBody,
    From: group ? `infiai:group:${accountScope}:${msg.groupID}` : `infiai:direct:${selfUid}:${msg.sendID}`,
    To: `infiai:${client.config.userID}`,
    SessionKey: effectiveSessionKey,
    AccountId: client.config.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: fromLabel,
    SenderId: senderId,
    Provider: "infiai",
    Surface: "infiai",
    MessageSid: msg.clientMsgID || `infiai-${Date.now()}`,
    Timestamp: timestamp,
    OriginatingChannel: "infiai",
    OriginatingTo: `infiai:${client.config.userID}`,
    CommandAuthorized: true,
    _infiai: {
      accountId: client.config.accountId,
      isGroup: group,
      senderId,
      groupId: String(msg.groupID || ""),
      messageKind: inbound.kind,
      mediaCount: inbound.media?.length ?? 0,
      sessionContinuityEnabled,
    },
  };

  obsInboundLog(api, "inbound.accept", {
    accountId: client.config.accountId,
    managedUserId: selfUid,
    agentId: String(route?.agentId ?? "main"),
    sessionKey,
    effectiveSessionKey,
    sessionContinuityEnabled,
    storePath: storePath || undefined,
    clientMsgID: msg.clientMsgID || undefined,
    serverMsgID: msg.serverMsgID || undefined,
    imSeq: typeof msg.seq === "number" ? msg.seq : undefined,
    contentType: msg.contentType,
    senderId,
    bodyChars: rawBody.length,
  });

  if (sessionContinuityEnabled && runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: effectiveSessionKey,
      ctx: ctxPayload,
      updateLastRoute: !group
        ? {
            sessionKey: effectiveSessionKey,
            channel: "infiai",
            to: String(msg.sendID),
            accountId: client.config.accountId,
          }
        : undefined,
      onRecordError: (err: unknown) => api.logger?.warn?.(`[infiai] recordInboundSession: ${String(err)}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "infiai",
      accountId: client.config.accountId,
      direction: "inbound",
    });
  }

  const dispatchObsStart = transcriptObsEnabled() ? Date.now() : 0;
  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          if (!payload.text) return;
          const cleaned = stripInfiaiReplyArtifacts(stripVisibleReasoningPreamble(payload.text));
          if (!cleaned.trim()) return;
          try {
            await sendReplyFromInbound(client, msg, cleaned);
          } catch (e: any) {
            api.logger?.error?.(`[infiai] deliver failed: ${formatSdkError(e)}`);
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[infiai] ${info?.kind || "reply"} failed: ${String(err)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
        images: mediaResult.images,
      },
    });
    if (dispatchObsStart) {
      obsInboundLog(api, "inbound.dispatch.done", {
        accountId: client.config.accountId,
        agentId: String(route?.agentId ?? "main"),
        effectiveSessionKey,
        clientMsgID: msg.clientMsgID || undefined,
        durationMs: Date.now() - dispatchObsStart,
      });
    }
  } catch (err: any) {
    if (dispatchObsStart) {
      obsInboundLog(api, "inbound.dispatch.fail", {
        accountId: client.config.accountId,
        agentId: String(route?.agentId ?? "main"),
        effectiveSessionKey,
        clientMsgID: msg.clientMsgID || undefined,
        durationMs: Date.now() - dispatchObsStart,
        error: formatSdkError(err).slice(0, 500),
      });
    }
    api.logger?.error?.(`[infiai] dispatch failed: ${formatSdkError(err)}`);
    try {
      const errMsg = formatSdkError(err);
      await sendReplyFromInbound(client, msg, `Processing failed: ${errMsg.slice(0, 80)}`);
    } catch {
      // ignore secondary send errors
    }
  }
}
