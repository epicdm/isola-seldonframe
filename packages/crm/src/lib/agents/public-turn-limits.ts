// Spend protection for the ANONYMOUS public chat endpoint (POST /api/v1/public/agent/<org>--<agent>/turn).
//
// Every public turn calls the model provider, so an endpoint that is open to the internet and has no limit lets
// anyone spend the operator's money. Three fixed-window counters (the existing rate limiter) bound that:
//   - per client IP, per minute      (stops scripted bursts)
//   - per client IP, per day         (stops one visitor draining the budget)
//   - per agent, per day             (a hard ceiling that does not depend on the client IP being honest)
// The defaults are deliberately modest and can be changed with env vars without a release.
// A limiter failure FAILS CLOSED: the visitor is told to retry, and no model call is made.
import { checkRateLimit } from "@/lib/utils/rate-limit";

export type PublicTurnLimits = {
  perIpPerMinute: number;
  perIpPerDay: number;
  perAgentPerDay: number;
};

export const DEFAULT_PUBLIC_TURN_LIMITS: PublicTurnLimits = {
  perIpPerMinute: 12,
  perIpPerDay: 150,
  perAgentPerDay: 1500,
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return parsed >= 1 ? parsed : fallback;
}

export function resolvePublicTurnLimits(
  env: Record<string, string | undefined> = process.env,
): PublicTurnLimits {
  return {
    perIpPerMinute: positiveInt(env.PUBLIC_TURN_IP_PER_MINUTE, DEFAULT_PUBLIC_TURN_LIMITS.perIpPerMinute),
    perIpPerDay: positiveInt(env.PUBLIC_TURN_IP_PER_DAY, DEFAULT_PUBLIC_TURN_LIMITS.perIpPerDay),
    perAgentPerDay: positiveInt(env.PUBLIC_TURN_AGENT_PER_DAY, DEFAULT_PUBLIC_TURN_LIMITS.perAgentPerDay),
  };
}

/** Behind the platform proxy the first X-Forwarded-For hop is the client. */
export function resolvePublicRequestIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
}

export type PublicTurnDecision =
  | { ok: true }
  | { ok: false; scope: "ip_minute" | "ip_day" | "agent_day" | "limiter_error" };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export async function checkPublicTurnAllowed(input: {
  ip: string;
  agentId: string;
  limits: PublicTurnLimits;
}): Promise<PublicTurnDecision> {
  try {
    const { ip, agentId, limits } = input;
    // Cheapest and most specific first; a rejected request must not consume the wider budgets.
    if (!(await checkRateLimit(`public-turn:ip-min:${ip}`, limits.perIpPerMinute, MINUTE))) {
      return { ok: false, scope: "ip_minute" };
    }
    if (!(await checkRateLimit(`public-turn:ip-day:${ip}`, limits.perIpPerDay, DAY))) {
      return { ok: false, scope: "ip_day" };
    }
    if (!(await checkRateLimit(`public-turn:agent-day:${agentId}`, limits.perAgentPerDay, DAY))) {
      return { ok: false, scope: "agent_day" };
    }
    return { ok: true };
  } catch {
    return { ok: false, scope: "limiter_error" };
  }
}

export const PUBLIC_TURN_RATE_LIMITED_MESSAGE =
  "You're sending messages too quickly, or the chat has reached its limit for now. Please try again a little later.";
