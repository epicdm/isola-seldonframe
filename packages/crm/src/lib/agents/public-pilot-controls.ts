import { isIP } from "node:net";

export const DEEPSEEK_FLASH_PRICING = {
  model: "deepseek-flash",
  inputMicroUsdPerMillion: 300_000,
  outputMicroUsdPerMillion: 1_200_000,
  maxSerializedRequestBytes: 32_768,
  loopCalls: 6,
  loopOutputTokens: 1_024,
  regenerationCalls: 1,
  regenerationOutputTokens: 512,
  sdkRetries: 0,
} as const;

/** Truthful customer copy for pilot refusals: never "try again" when retrying cannot help, and never a promise
 * of a human follow-up (the support line is the ratified Personal Line support text). */
export const PUBLIC_CHAT_UNAVAILABLE_MESSAGE =
  "Chat is not available right now. Please message EPIC on WhatsApp at +1 767 818 0001. A person replies Monday to Saturday, 8:00 am to 6:00 pm Dominica time.";
export const PUBLIC_CHAT_CONVERSATION_LIMIT_MESSAGE =
  "This chat has reached its message limit. Refresh the page to start a new chat, or message EPIC on WhatsApp at +1 767 818 0001.";

export const MAX_PUBLIC_PILOT_BUDGET_CENTS = 1_000;
export const MAX_PUBLIC_PILOT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_PUBLIC_TURNS_PER_CONVERSATION = 5;
export const MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST = DEEPSEEK_FLASH_PRICING.maxSerializedRequestBytes;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MICRO_USD_PER_TOKEN_SCALE = BigInt(1000000);

export function isPublicPilotRequestWithinInputLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST;
  } catch {
    return false;
  }
}

export function extractCompletePublicUsage(usage: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
} | null | undefined): { inputTokens: number; outputTokens: number } | null {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || (usage.input_tokens as number) < 0 ||
      !Number.isSafeInteger(usage.output_tokens) || (usage.output_tokens as number) < 0) return null;
  const cacheTokens = [usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  if (cacheTokens.some((value) => value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0))) return null;
  const inputTokens = (usage.input_tokens as number) + cacheTokens.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  const outputTokens = usage.output_tokens as number;
  if (!Number.isSafeInteger(inputTokens)) return null;
  return { inputTokens, outputTokens };
}

export function parseTrustedProxyHops(value: string | undefined): number | null {
  if (!value || !/^\d{1,2}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : null;
}

export function isConfiguredPublicPilotTarget(
  organizationId: string,
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolvePublicPilotTarget(organizationId, agentId, env) === "target";
}

export function resolvePublicPilotTarget(
  organizationId: string,
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): "target" | "incomplete" | "other" {
  const configuredOrgId = env.PUBLIC_PILOT_ORG_ID?.trim();
  const configuredAgentId = env.PUBLIC_PILOT_AGENT_ID?.trim();
  if (!configuredOrgId || !UUID_RE.test(configuredOrgId) || configuredOrgId !== organizationId) return "other";
  if (!configuredAgentId || !UUID_RE.test(configuredAgentId)) return "incomplete";
  return configuredAgentId === agentId ? "target" : "other";
}

/** Resolve the ingress-appended client peer. This is safe only when app ingress
 * is unreachable except through the configured trusted proxy chain. */
export function resolveTrustedClientIp(headers: Headers, trustedProxyHops: number | null): string | null {
  if (!trustedProxyHops) return null;
  const raw = headers.get("x-forwarded-for");
  if (!raw) return null;

  const chain = raw.split(",").map((part) => part.trim());
  const clientIndex = chain.length - trustedProxyHops;
  if (clientIndex < 0) return null;

  const trustedSuffix = chain.slice(clientIndex);
  if (
    trustedSuffix.length !== trustedProxyHops ||
    chain.some((address) => isIP(address) === 0)
  ) return null;
  return chain[clientIndex].toLowerCase();
}

export type PublicPilotEnvelope = {
  budgetCents: number;
  startsAtMs: number;
  expiresAtMs: number;
};

/** Missing, malformed, oversized, or longer-than-14-day configuration disables public pilot admission. */
export function parsePublicPilotEnvelope(
  env: Record<string, string | undefined>,
): PublicPilotEnvelope | null {
  const budgetRaw = env.PUBLIC_PILOT_BUDGET_CENTS?.trim();
  const startsRaw = env.PUBLIC_PILOT_STARTS_AT?.trim();
  const expiresRaw = env.PUBLIC_PILOT_EXPIRES_AT?.trim();
  if (!budgetRaw || !/^[1-9]\d{0,3}$/.test(budgetRaw) || !startsRaw || !expiresRaw) return null;

  const budgetCents = Number(budgetRaw);
  if (!Number.isSafeInteger(budgetCents) || budgetCents > MAX_PUBLIC_PILOT_BUDGET_CENTS) return null;
  const parseUtc = (raw: string): number | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(raw);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, fraction = ""] = match;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const date = new Date(parsed);
    const millisecond = Number(fraction.padEnd(3, "0") || "0");
    if (
      date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) ||
      date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second) ||
      date.getUTCMilliseconds() !== millisecond
    ) return null;
    return parsed;
  };
  const startsAtMs = parseUtc(startsRaw);
  const expiresAtMs = parseUtc(expiresRaw);
  if (startsAtMs === null || expiresAtMs === null) return null;
  if (expiresAtMs <= startsAtMs || expiresAtMs - startsAtMs > MAX_PUBLIC_PILOT_WINDOW_MS) return null;
  return { budgetCents, startsAtMs, expiresAtMs };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - BigInt(1)) / denominator;
}

/** Reserve worst-case cost for seven capped requests. Input is bounded by the
 * complete serialized API body, priced as if every byte were an uncached token. */
export function maximumPublicTurnReservationMicroUsd(): bigint {
  const calls = BigInt(DEEPSEEK_FLASH_PRICING.loopCalls + DEEPSEEK_FLASH_PRICING.regenerationCalls);
  const maxOutput = BigInt(
    DEEPSEEK_FLASH_PRICING.loopCalls * DEEPSEEK_FLASH_PRICING.loopOutputTokens +
      DEEPSEEK_FLASH_PRICING.regenerationOutputTokens,
  );
  const maxInput = calls * BigInt(DEEPSEEK_FLASH_PRICING.maxSerializedRequestBytes);
  const inputCost = ceilDiv(maxInput * BigInt(DEEPSEEK_FLASH_PRICING.inputMicroUsdPerMillion), MICRO_USD_PER_TOKEN_SCALE);
  const outputCost = ceilDiv(maxOutput * BigInt(DEEPSEEK_FLASH_PRICING.outputMicroUsdPerMillion), MICRO_USD_PER_TOKEN_SCALE);
  return inputCost + outputCost;
}

export function actualPublicTurnCostMicroUsd(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): bigint | null {
  if (input.model !== DEEPSEEK_FLASH_PRICING.model) return null;
  if (
    !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0
  ) return null;

  const inputCost = ceilDiv(
    BigInt(input.inputTokens) * BigInt(DEEPSEEK_FLASH_PRICING.inputMicroUsdPerMillion),
    MICRO_USD_PER_TOKEN_SCALE,
  );
  const outputCost = ceilDiv(
    BigInt(input.outputTokens) * BigInt(DEEPSEEK_FLASH_PRICING.outputMicroUsdPerMillion),
    MICRO_USD_PER_TOKEN_SCALE,
  );
  return inputCost + outputCost;
}

export type PilotSpendSnapshot = {
  enabled: boolean;
  organizationId: string;
  agentId: string;
  model: string;
  budgetMicroUsd: bigint;
  spentMicroUsd: bigint;
  reservedMicroUsd: bigint;
  uncertainMicroUsd: bigint;
  startsAtMs: number;
  expiresAtMs: number;
};

export function canReservePilotSpend(input: {
  gate: PilotSpendSnapshot | null;
  organizationId: string;
  agentId: string;
  model: string;
  reserveMicroUsd: bigint;
  nowMs: number;
  conversationTurns?: number;
}): boolean {
  const gate = input.gate;
  if (!gate || !gate.enabled || gate.organizationId !== input.organizationId || gate.agentId !== input.agentId) return false;
  if (gate.model !== input.model || input.model !== DEEPSEEK_FLASH_PRICING.model) return false;
  if (input.nowMs < gate.startsAtMs || input.nowMs >= gate.expiresAtMs) return false;
  if ((input.conversationTurns ?? 0) >= MAX_PUBLIC_TURNS_PER_CONVERSATION) return false;
  if (input.reserveMicroUsd <= BigInt(0)) return false;
  return gate.spentMicroUsd + gate.reservedMicroUsd + gate.uncertainMicroUsd + input.reserveMicroUsd <= gate.budgetMicroUsd;
}
