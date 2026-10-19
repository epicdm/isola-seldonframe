import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RELAY_CONTEXT_META_KEY = "com.epic.uplink/relay-context-v1";
export const RELAY_CONTEXT_BINDING_KEY = "_isola_relay_binding_v1";

export function persistedChatwootConversationId(channelMeta: unknown): string | undefined {
  if (typeof channelMeta !== "object" || channelMeta === null || Array.isArray(channelMeta)) return undefined;
  const binding = (channelMeta as Record<string, unknown>)[RELAY_CONTEXT_BINDING_KEY];
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return undefined;
  const conversationId = (binding as Record<string, unknown>).chatwootConversationId;
  return typeof conversationId === "string" && /^\d{1,20}$/.test(conversationId)
    ? conversationId
    : undefined;
}

export type RelayContextBinding = {
  accountId: number;
  inboxId: number;
  chatwootConversationId: string;
  workspaceId: string;
  agentId: string;
  agentSlug: string;
  sessionId: string;
};

export type TrustedRelayToolContext = {
  kind: "chatwoot";
  proof: string;
  binding: RelayContextBinding;
};

export type RelayContextExpected = Omit<RelayContextBinding, "chatwootConversationId"> & {
  uplinkConversationId: string | null;
  chatwootConversationId?: string;
  chatwootMessageId?: string;
};

type RelayContextClaims = RelayContextBinding & {
  kid: string;
  uplinkConversationId: string | null;
  chatwootMessageId: string;
  messageSha256: string;
  plAssertion: string;
  iat: number;
  nonce: string;
};

const KEY_ID = /^[a-z0-9]{1,16}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readRelayContextKey(
  env: Record<string, string | undefined> = process.env,
): Promise<{ kid: string; key: string } | null> {
  const path = env.UPLINK_RELAY_CONTEXT_KEY_FILE?.trim();
  const kid = env.UPLINK_RELAY_CONTEXT_KEY_ID?.trim();
  if (!path || !kid || !KEY_ID.test(kid)) return null;
  try {
    const key = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    if (Buffer.byteLength(key, "utf8") < 32 || /\s/.test(key)) return null;
    return { kid, key };
  } catch {
    return null;
  }
}

export function hashRelayMessage(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeMacMatches(key: string, payloadPart: string, signaturePart: string): boolean {
  const expected = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(`v1.${payloadPart}`, "utf8")
    .digest();
  const supplied = Buffer.from(signaturePart, "base64url");
  return supplied.length === expected.length
    && supplied.toString("base64url") === signaturePart
    && timingSafeEqual(supplied, expected);
}

export function verifyRelayContext(input: {
  token: unknown;
  key: string;
  kid: string;
  nowMs?: number;
  message: string;
  expected: RelayContextExpected;
}): { ok: true; claims: RelayContextClaims; binding: RelayContextBinding } | { ok: false } {
  const { token, key, kid, message, expected } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (typeof token !== "string" || token.length > 8192
    || Buffer.byteLength(key, "utf8") < 32 || !KEY_ID.test(kid)) return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1"
    || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { ok: false };

  let parsed: unknown;
  try {
    const raw = Buffer.from(parts[1], "base64url");
    if (raw.toString("base64url") !== parts[1]) return { ok: false };
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (!isObject(parsed) || parsed.kid !== kid
    || !constantTimeMacMatches(key, parts[1], parts[2])) return { ok: false };

  const claims = parsed as unknown as RelayContextClaims;
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(claims.iat) || Math.abs(nowSec - claims.iat) > 60
    || !NONCE.test(claims.nonce)
    || !/^[a-f0-9]{64}$/.test(claims.messageSha256)
    || claims.messageSha256 !== hashRelayMessage(message)
    || typeof claims.plAssertion !== "string"
    || claims.plAssertion.length > 2048
    || !claims.plAssertion.startsWith("v1.")) return { ok: false };

  if (claims.accountId !== 2 || claims.inboxId !== 11
    || typeof claims.workspaceId !== "string"
    || typeof claims.agentId !== "string" || !UUID.test(claims.agentId)
    || typeof claims.agentSlug !== "string" || claims.agentSlug.length < 1 || claims.agentSlug.length > 128
    || typeof claims.sessionId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(claims.sessionId)
    || (claims.uplinkConversationId !== null && (typeof claims.uplinkConversationId !== "string" || !UUID.test(claims.uplinkConversationId)))
    || typeof claims.chatwootConversationId !== "string" || !/^\d{1,20}$/.test(claims.chatwootConversationId)
    || typeof claims.chatwootMessageId !== "string" || !/^\d{1,20}$/.test(claims.chatwootMessageId)) return { ok: false };

  for (const field of [
    "accountId", "inboxId", "workspaceId", "agentId", "agentSlug", "sessionId", "uplinkConversationId",
    "chatwootConversationId", "chatwootMessageId",
  ] as const) {
    if (expected[field] !== undefined && claims[field] !== expected[field]) return { ok: false };
  }

  const binding: RelayContextBinding = {
    accountId: claims.accountId,
    inboxId: claims.inboxId,
    chatwootConversationId: claims.chatwootConversationId,
    workspaceId: claims.workspaceId,
    agentId: claims.agentId,
    agentSlug: claims.agentSlug,
    sessionId: claims.sessionId,
  };
  return { ok: true, claims, binding };
}

export function sameRelayBinding(value: unknown, expected: RelayContextBinding): boolean {
  if (!isObject(value)) return false;
  return value.accountId === expected.accountId
    && value.inboxId === expected.inboxId
    && value.chatwootConversationId === expected.chatwootConversationId
    && value.workspaceId === expected.workspaceId
    && value.agentId === expected.agentId
    && value.agentSlug === expected.agentSlug
    && value.sessionId === expected.sessionId;
}
