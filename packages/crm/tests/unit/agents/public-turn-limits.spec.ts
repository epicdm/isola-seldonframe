import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PUBLIC_TURN_LIMITS,
  checkPublicTurnAllowed,
  resolvePublicRequestIp,
  resolvePublicTurnLimits,
} from "../../../src/lib/agents/public-turn-limits";

const uid = () => Math.random().toString(36).slice(2);

describe("public turn spend protection", () => {
  test("defaults are modest and positive", () => {
    assert.deepEqual(DEFAULT_PUBLIC_TURN_LIMITS, { perIpPerMinute: 12, perIpPerDay: 150, perAgentPerDay: 1500 });
    assert.deepEqual(resolvePublicTurnLimits({}), DEFAULT_PUBLIC_TURN_LIMITS);
  });

  test("env overrides apply; junk, zero, negative and oversized values fall back to the default", () => {
    assert.deepEqual(
      resolvePublicTurnLimits({ PUBLIC_TURN_IP_PER_MINUTE: "5", PUBLIC_TURN_IP_PER_DAY: " 40 ", PUBLIC_TURN_AGENT_PER_DAY: "300" }),
      { perIpPerMinute: 5, perIpPerDay: 40, perAgentPerDay: 300 },
    );
    for (const bad of ["", "abc", "0", "-3", "1.5", "99999999", "1e3"]) {
      assert.equal(resolvePublicTurnLimits({ PUBLIC_TURN_IP_PER_MINUTE: bad }).perIpPerMinute, 12, bad);
    }
  });

  test("POSITIVE CONTROL: requests under the limit are allowed", async () => {
    const limits = { perIpPerMinute: 3, perIpPerDay: 100, perAgentPerDay: 100 };
    const ip = `ip-${uid()}`, agentId = `agent-${uid()}`;
    for (let i = 0; i < 3; i++) assert.deepEqual(await checkPublicTurnAllowed({ ip, agentId, limits }), { ok: true });
  });

  test("the per-minute limit blocks the next request from the same IP, but not another IP", async () => {
    const limits = { perIpPerMinute: 3, perIpPerDay: 100, perAgentPerDay: 100 };
    const ip = `ip-${uid()}`, agentId = `agent-${uid()}`;
    for (let i = 0; i < 3; i++) await checkPublicTurnAllowed({ ip, agentId, limits });
    assert.deepEqual(await checkPublicTurnAllowed({ ip, agentId, limits }), { ok: false, scope: "ip_minute" });
    assert.deepEqual(await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId, limits }), { ok: true });
  });

  test("the per-day IP limit blocks even when the per-minute window is fine", async () => {
    const limits = { perIpPerMinute: 100, perIpPerDay: 2, perAgentPerDay: 100 };
    const ip = `ip-${uid()}`, agentId = `agent-${uid()}`;
    await checkPublicTurnAllowed({ ip, agentId, limits });
    await checkPublicTurnAllowed({ ip, agentId, limits });
    assert.deepEqual(await checkPublicTurnAllowed({ ip, agentId, limits }), { ok: false, scope: "ip_day" });
  });

  test("the per-agent daily ceiling holds across DIFFERENT IPs (spoofed X-Forwarded-For cannot bypass it)", async () => {
    const limits = { perIpPerMinute: 100, perIpPerDay: 100, perAgentPerDay: 4 };
    const agentId = `agent-${uid()}`;
    for (let i = 0; i < 4; i++) assert.deepEqual(await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId, limits }), { ok: true });
    assert.deepEqual(await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId, limits }), { ok: false, scope: "agent_day" });
    assert.deepEqual(await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId: `agent-${uid()}`, limits }), { ok: true });
  });

  test("a rejected request does not consume the wider budgets", async () => {
    const limits = { perIpPerMinute: 1, perIpPerDay: 5, perAgentPerDay: 5 };
    const agentId = `agent-${uid()}`, ip = `ip-${uid()}`;
    await checkPublicTurnAllowed({ ip, agentId, limits });
    for (let i = 0; i < 4; i++) assert.equal((await checkPublicTurnAllowed({ ip, agentId, limits })).ok, false);
    // only 1 of the 5 agent-day slots was used by the one allowed request
    for (let i = 0; i < 4; i++) assert.deepEqual(await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId, limits }), { ok: true });
    assert.equal((await checkPublicTurnAllowed({ ip: `ip-${uid()}`, agentId, limits })).ok, false);
  });

  test("the client IP is the first X-Forwarded-For hop, then X-Real-IP, then 'unknown'", () => {
    assert.equal(resolvePublicRequestIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" })), "203.0.113.9");
    assert.equal(resolvePublicRequestIp(new Headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
    assert.equal(resolvePublicRequestIp(new Headers()), "unknown");
  });
});

describe("turn route wiring", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/turn/route.ts"),
    "utf8",
  );
  test("the spend check runs before the conversation is created and before any turn executes", () => {
    const check = source.indexOf("checkPublicTurnAllowed(");
    assert.ok(check > 0, "check missing");
    assert.ok(check < source.indexOf("insert(agentConversations)"), "must precede conversation creation");
    assert.ok(check < source.indexOf("executeTurn("), "must precede executeTurn");
  });
  test("an over-limit request gets 429 with Retry-After and a visitor-facing message", () => {
    assert.match(source, /error: "rate_limited", message: PUBLIC_TURN_RATE_LIMITED_MESSAGE/);
    assert.match(source, /status: 429, headers: \{ \.\.\.CORS_HEADERS, "Retry-After": "60" \}/);
  });
});
