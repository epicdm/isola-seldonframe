import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as controls from "../src/lib/agents/public-pilot-controls";
import {
  canReservePilotSpend,
  DEEPSEEK_FLASH_PRICING,
  MAX_VERIFIED_RELAY_INPUT_BYTES_PER_REQUEST,
  maximumPublicTurnReservationMicroUsd,
  type PilotSpendSnapshot,
} from "../src/lib/agents/public-pilot-controls";

// Owner decision dec-owner-pl-remove-temporary-pilot-limits-prepare-live-2026-10-14: the five-turn cutoff, the 32/96 KiB
// request ceilings and the dollar budget/expiry no longer refuse a turn. Actual-cost telemetry and the kill switch remain.

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("the 32/96 KiB pilot ceilings are gone; only the provider-window guard (384 KiB) remains, before both model calls", () => {
  assert.equal("isPublicPilotRequestWithinInputLimit" in controls, false);
  assert.equal(controls.MAX_MODEL_REQUEST_BYTES, 393_216);
  const requestAt = (n: number) => ({ body: "x".repeat(n - Buffer.byteLength(JSON.stringify({ body: "" }), "utf8")) });
  // requests the pilot used to refuse are admitted (anonymous 33 KB, relay 200 KB) ...
  assert.equal(controls.isWithinModelRequestLimit(requestAt(33_000)), true);
  assert.equal(controls.isWithinModelRequestLimit(requestAt(200_000)), true);
  assert.equal(controls.isWithinModelRequestLimit(requestAt(393_216)), true);
  // ... and the guard still says no beyond the provider window (proves it can fail)
  assert.equal(controls.isWithinModelRequestLimit(requestAt(393_217)), false);
  const runtime = read("src/lib/agents/runtime.ts");
  assert.doesNotMatch(runtime, /isPublicPilotRequestWithinInputLimit|MAX_VERIFIED_RELAY_INPUT_BYTES_PER_REQUEST : undefined/);
  assert.equal((runtime.match(/isWithinModelRequestLimit\((requestParams|regenParams)\)/g) ?? []).length, 2);
  assert.equal((runtime.match(/anthropic\.messages\.create\(/g) ?? []).length, 2);
  assert.match(runtime, /input\.publicPilotSpend \? \{ maxRetries: 0 \} : undefined/);
  // a relay conversation that outgrows the window answers the code the relay rotates on (relay rc10l relay.js:655)
  const route = read("src/app/api/v1/public/agent/[slug]/turn/route.ts");
  assert.match(route, /result\.reason === "request_too_large" && trustedRelayToolContext[\s\S]{0,200}PUBLIC_CHAT_CONVERSATION_LIMIT/);
});

test("public chat no longer depends on the PUBLIC_PILOT budget/window envelope being valid", () => {
  const spend = read("src/lib/agents/public-turn-spend.ts");
  assert.doesNotMatch(spend, /parsePublicPilotEnvelope/);
  // control: the envelope parser itself still rejects an over-limit budget, so the assertion above is meaningful
  assert.equal(controls.parsePublicPilotEnvelope({ PUBLIC_PILOT_BUDGET_CENTS: "5000", PUBLIC_PILOT_STARTS_AT: "2026-10-01T00:00:00Z", PUBLIC_PILOT_EXPIRES_AT: "2026-10-05T00:00:00Z" }), null);
});

test("reservation is still recorded at the same estimate (telemetry, not a ceiling)", () => {
  const calls = DEEPSEEK_FLASH_PRICING.loopCalls + DEEPSEEK_FLASH_PRICING.regenerationCalls;
  const maxOutput = DEEPSEEK_FLASH_PRICING.loopCalls * DEEPSEEK_FLASH_PRICING.loopOutputTokens + DEEPSEEK_FLASH_PRICING.regenerationOutputTokens;
  const expected = (BigInt(calls * MAX_VERIFIED_RELAY_INPUT_BYTES_PER_REQUEST) * BigInt(DEEPSEEK_FLASH_PRICING.inputMicroUsdPerMillion) + BigInt(999_999)) / BigInt(1_000_000)
    + (BigInt(maxOutput) * BigInt(DEEPSEEK_FLASH_PRICING.outputMicroUsdPerMillion) + BigInt(999_999)) / BigInt(1_000_000);
  assert.equal(maximumPublicTurnReservationMicroUsd(), BigInt(76_801));
  assert.equal(maximumPublicTurnReservationMicroUsd(MAX_VERIFIED_RELAY_INPUT_BYTES_PER_REQUEST), expected);
  assert.equal(expected, BigInt(214_427));
});

test("turn count, budget and expiry no longer refuse; kill switch, workspace and model still do", () => {
  const gate: PilotSpendSnapshot = {
    enabled: true,
    organizationId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    model: DEEPSEEK_FLASH_PRICING.model,
    budgetMicroUsd: BigInt(1_000_000),
    spentMicroUsd: BigInt(100_000),
    reservedMicroUsd: BigInt(200_000),
    uncertainMicroUsd: BigInt(50_000),
    startsAtMs: 100,
    expiresAtMs: 10_000,
  };
  const input = { gate, organizationId: gate.organizationId, agentId: gate.agentId, model: gate.model, reserveMicroUsd: BigInt(100_000), nowMs: 1_000 };
  // the old refusals, each now admitted (anonymous AND verified relay)
  for (const verifiedRelay of [false, true]) {
    assert.equal(canReservePilotSpend({ ...input, verifiedRelay, conversationTurns: 50 }), true, "past turn 5");
    assert.equal(canReservePilotSpend({ ...input, verifiedRelay, reserveMicroUsd: BigInt(5_000_000) }), true, "over the old budget");
    assert.equal(canReservePilotSpend({ ...input, verifiedRelay, nowMs: 50_000 }), true, "after the old expiry");
    assert.equal(canReservePilotSpend({ ...input, verifiedRelay, nowMs: 1 }), true, "before the old start");
  }
  // refusals that must remain (proves the predicate can still say no)
  assert.equal(canReservePilotSpend({ ...input, gate: { ...gate, enabled: false } }), false, "operator kill switch");
  assert.equal(canReservePilotSpend({ ...input, gate: null }), false, "no gate row");
  assert.equal(canReservePilotSpend({ ...input, organizationId: "33333333-3333-4333-8333-333333333333" }), false, "other workspace");
  assert.equal(canReservePilotSpend({ ...input, model: "deepseek-v4-pro" }), false, "other model");
  assert.equal(canReservePilotSpend({ ...input, reserveMicroUsd: BigInt(0) }), false, "non-positive estimate");
});

test("reservation SQL keeps the row lock and kill switch but no budget/window/turn predicates; settlement records cost above the estimate", () => {
  const spend = read("src/lib/agents/public-turn-spend.ts");
  assert.match(spend, /FOR UPDATE/);
  assert.match(spend, /publicTurnSpendGates\.enabled\} = true`/);
  assert.doesNotMatch(spend, /startsAt\} <= now\(\)|expiresAt\} > now\(\)/);
  assert.doesNotMatch(spend, /<= \$\{publicTurnSpendGates\.budgetMicroUsd\}/);
  assert.doesNotMatch(spend, /MAX_PUBLIC_TURNS_PER_CONVERSATION|publicConversationAtLimit/);
  assert.doesNotMatch(spend, /reservedMicroUsd\} >= \$\{input\.actualMicroUsd/);
  // positive control: settlement still adds the ACTUAL cost to spent, and uncertain still holds the full reservation
  assert.match(spend, /spentMicroUsd: sql`\$\{publicTurnSpendGates\.spentMicroUsd\} \+ \$\{input\.actualMicroUsd!\.toString\(\)\}`/);
  assert.match(spend, /uncertainMicroUsd: sql`\$\{publicTurnSpendGates\.uncertainMicroUsd\} \+ \$\{reservation\.reservedMicroUsd\}`/);
  assert.match(spend, /if \(!input\.usageComplete\) return Promise\.resolve\(false\)/);
});
