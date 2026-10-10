import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { publicTurnSpendGates, publicTurnSpendReservations } from "@/db/schema";
import {
  actualPublicTurnCostMicroUsd,
  isConfiguredPublicPilotTarget,
  MAX_PUBLIC_TURNS_PER_CONVERSATION,
  maximumPublicTurnReservationMicroUsd,
  parseTrustedProxyHops,
  parsePublicPilotEnvelope,
} from "./public-pilot-controls";

const GATE_ID = "uplink-personal-line-public-14d";
const MODEL = "deepseek-flash";
async function effectiveEnabled(gate: {
  enabled: boolean;
  organizationId: string;
  agentId: string;
  model: string;
  budgetMicroUsd: number;
  startsAt: Date;
  expiresAt: Date;
}) {
  if (!gate.enabled || !(await publicPilotConfigReady()) || !isConfiguredPublicPilotTarget(gate.organizationId, gate.agentId)) return false;
  const envelope = parsePublicPilotEnvelope(process.env);
  if (!envelope) return false;
  const now = Date.now();
  return gate.model === MODEL &&
    gate.budgetMicroUsd === Number(envelopeBudgetMicroUsd(envelope.budgetCents)) &&
    gate.startsAt.getTime() === envelope.startsAtMs && gate.expiresAt.getTime() === envelope.expiresAtMs &&
    now >= envelope.startsAtMs && now < envelope.expiresAtMs;
}

export type PublicSpendReservation = { id: string };

function returnedRows<T>(result: unknown): T[] {
  if (!result || typeof result !== "object" || !("rows" in result)) return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

async function publicPilotConfigReady(): Promise<boolean> {
  const env = process.env;
  const required = Boolean(
    process.env.DB_DRIVER?.trim().toLowerCase() === "pg" &&
    process.env.MODEL_API_KEY_FILE?.trim() &&
    process.env.MODEL_BASE_URL?.replace(/\/+$/, "") === "https://api.deepseek.com/anthropic" &&
    process.env.MODEL_NAME?.trim() === MODEL &&
    isConfiguredPublicPilotTarget(process.env.PUBLIC_PILOT_ORG_ID ?? "", process.env.PUBLIC_PILOT_AGENT_ID ?? "") &&
    // A distributed limiter is required only when the operator opts in; the durable dollar gate is the primary control.
    (process.env.PUBLIC_PILOT_REQUIRE_DISTRIBUTED_LIMITER !== "1" ||
      Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim())) &&
    parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS) !== null &&
    parsePublicPilotEnvelope(env),
  );
  if (!required) return false;
  try {
    const keyFile = env.MODEL_API_KEY_FILE!;
    const metadata = await stat(keyFile);
    if (!metadata.isFile()) return false;
    await access(keyFile, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function envelopeBudgetMicroUsd(budgetCents: number): string {
  return (BigInt(budgetCents) * BigInt(10000)).toString();
}

function dateMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

/**
 * One transaction serializes all pilot admissions on its single gate row. The
 * same lock protects the aggregate dollar ceiling and per-conversation turn
 * count, so neither can be oversubscribed by concurrent requests.
 *
 * This deliberately requires DB_DRIVER=pg: Neon HTTP does not provide an
 * interactive transaction. A missing setting/config, wrong model, missing
 * gate, expiry, cap, per-conversation limit, or DB failure disables public
 * admission. Internal authenticated test-mode calls never invoke this gate.
 */
export async function reservePublicTurnSpend(input: {
  organizationId: string;
  agentId: string;
  conversationId: string;
}): Promise<PublicSpendReservation | null> {
  if (!(await publicPilotConfigReady())) return null;
  const envelope = parsePublicPilotEnvelope(process.env);
  if (!envelope) return null;

  const reservationId = randomUUID();
  const amount = maximumPublicTurnReservationMicroUsd();
  const expectedBudget = envelopeBudgetMicroUsd(envelope.budgetCents);
  try {
    return await db.transaction(async (tx) => {
      const gateResult = await tx.execute(sql`
        SELECT id, organization_id, agent_id, model, budget_micro_usd,
          spent_micro_usd, reserved_micro_usd, uncertain_micro_usd,
          enabled, starts_at, expires_at
        FROM public_turn_spend_gates
        WHERE id = ${GATE_ID}
        FOR UPDATE
      `);
      const [gate] = returnedRows<{
        id: string;
        organization_id: string;
        agent_id: string;
        model: string;
        budget_micro_usd: number | string;
        enabled: boolean;
        starts_at: Date | string;
        expires_at: Date | string;
      }>(gateResult);
      if (!gate) return null;

      const startsAt = dateMillis(gate.starts_at);
      const expiresAt = dateMillis(gate.expires_at);
      if (
        !gate.enabled ||
        gate.organization_id !== input.organizationId ||
        gate.model !== MODEL ||
        Number(gate.budget_micro_usd) !== Number(expectedBudget) ||
        startsAt !== envelope.startsAtMs ||
        expiresAt !== envelope.expiresAtMs ||
        Date.now() < envelope.startsAtMs ||
        Date.now() >= envelope.expiresAtMs
      ) return null;

      const conversationCountResult = await tx.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM public_turn_spend_reservations
        WHERE conversation_id = ${input.conversationId}::uuid
          AND gate_id = ${GATE_ID}
          AND state IN ('reserved', 'settled', 'uncertain')
      `);
      const [conversationCount] = returnedRows<{ count: number | string }>(conversationCountResult);
      if (!conversationCount || Number(conversationCount.count) >= MAX_PUBLIC_TURNS_PER_CONVERSATION) return null;

      const [updatedGate] = await tx
        .update(publicTurnSpendGates)
        .set({
          reservedMicroUsd: sql`${publicTurnSpendGates.reservedMicroUsd} + ${amount.toString()}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(publicTurnSpendGates.id, GATE_ID),
          sql`${publicTurnSpendGates.enabled} = true AND ${publicTurnSpendGates.startsAt} <= now() AND ${publicTurnSpendGates.expiresAt} > now()`,
          sql`${publicTurnSpendGates.spentMicroUsd} + ${publicTurnSpendGates.reservedMicroUsd} + ${publicTurnSpendGates.uncertainMicroUsd} + ${amount.toString()} <= ${publicTurnSpendGates.budgetMicroUsd}`,
        ))
        .returning({ id: publicTurnSpendGates.id });
      if (!updatedGate) tx.rollback();

      await tx.insert(publicTurnSpendReservations).values({
        id: reservationId,
        gateId: GATE_ID,
        organizationId: input.organizationId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        reservedMicroUsd: Number(amount),
        state: "reserved",
      });
      return { id: reservationId };
    }, { isolationLevel: "read committed" });
  } catch {
    return null;
  }
}

/** Read-only: true when a pilot gate row exists for this agent's WORKSPACE (whatever its enabled/expiry state; the gate meters
 * every agent of the pilot workspace). A missing table or a database error reads as "no gate": the turn itself needs the same
 * database, so it cannot proceed without it. */
export async function agentHasPilotGate(agentId: string): Promise<boolean> {
  if (process.env.DB_DRIVER?.trim().toLowerCase() !== "pg") return false;
  try {
    const result = await db.execute(sql`SELECT 1 AS present FROM public_turn_spend_gates g JOIN agents a ON a.org_id = g.organization_id WHERE a.id = ${agentId}::uuid LIMIT 1`);
    return returnedRows<{ present: number }>(result).length > 0;
  } catch {
    return false;
  }
}

/** Read-only: true when this conversation already used its per-conversation turn allowance. Used only to choose the customer message. */
export async function publicConversationAtLimit(conversationId: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM public_turn_spend_reservations
      WHERE conversation_id = ${conversationId}::uuid
        AND gate_id = ${GATE_ID}
        AND state IN ('reserved', 'settled', 'uncertain')
    `);
    const [row] = returnedRows<{ count: number | string }>(result);
    return Boolean(row) && Number(row.count) >= MAX_PUBLIC_TURNS_PER_CONVERSATION;
  } catch {
    return false;
  }
}

async function transitionReservation(input: {
  reservationId: string;
  state: "released" | "uncertain" | "settled";
  actualMicroUsd?: bigint;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [reservation] = await tx
        .update(publicTurnSpendReservations)
        .set({
          state: input.state,
          ...(input.actualMicroUsd !== undefined ? { actualMicroUsd: Number(input.actualMicroUsd) } : {}),
          ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
          ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
          settledAt: new Date(),
        })
        .where(and(
          eq(publicTurnSpendReservations.id, input.reservationId),
          eq(publicTurnSpendReservations.state, "reserved"),
        ))
        .returning({ gateId: publicTurnSpendReservations.gateId, reservedMicroUsd: publicTurnSpendReservations.reservedMicroUsd });
      if (!reservation) return false;

      const [gate] = await tx
        .update(publicTurnSpendGates)
        .set({
          reservedMicroUsd: sql`${publicTurnSpendGates.reservedMicroUsd} - ${reservation.reservedMicroUsd}`,
          ...(input.state === "settled" ? { spentMicroUsd: sql`${publicTurnSpendGates.spentMicroUsd} + ${input.actualMicroUsd!.toString()}` } : {}),
          ...(input.state === "uncertain" ? { uncertainMicroUsd: sql`${publicTurnSpendGates.uncertainMicroUsd} + ${reservation.reservedMicroUsd}` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(publicTurnSpendGates.id, reservation.gateId))
        .returning({ id: publicTurnSpendGates.id });
      if (!gate) tx.rollback();
      return true;
    }, { isolationLevel: "read committed" });
  } catch {
    return false;
  }
}

/** Release only when application flow proves inference was never attempted. */
export function releasePublicTurnSpend(reservationId: string): Promise<boolean> {
  return transitionReservation({ reservationId, state: "released" });
}

/** Keep the full reservation as uncertain when a provider may have processed a failed request. */
export function markPublicTurnSpendUncertain(reservationId: string): Promise<boolean> {
  return transitionReservation({ reservationId, state: "uncertain" });
}

/** Complete usage is required; missing/invalid usage leaves the full reservation held. */
export function settlePublicTurnSpend(input: {
  reservationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}): Promise<boolean> {
  if (!input.usageComplete) return Promise.resolve(false);
  const actual = actualPublicTurnCostMicroUsd(input);
  if (actual === null || actual > maximumPublicTurnReservationMicroUsd()) return Promise.resolve(false);
  return transitionReservation({
    reservationId: input.reservationId,
    state: "settled",
    actualMicroUsd: actual,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  });
}

export async function readPublicPilotUsage(organizationId: string) {
  if (process.env.DB_DRIVER?.trim().toLowerCase() !== "pg") return null;
  try {
    const [gate] = await db
      .select()
      .from(publicTurnSpendGates)
      .where(and(eq(publicTurnSpendGates.id, GATE_ID), eq(publicTurnSpendGates.organizationId, organizationId)))
      .limit(1);
    if (!gate) return { enabled: false, reason: "no_gate_row" } as const;
    const totalCommitted = gate.spentMicroUsd + gate.reservedMicroUsd + gate.uncertainMicroUsd;
    const ceilCents = (value: number) => Math.ceil(value / 10_000);
    return {
      enabled: await effectiveEnabled(gate),
      databaseEnabled: gate.enabled,
      configured: await publicPilotConfigReady(),
      budgetCents: Math.floor(gate.budgetMicroUsd / 10_000),
      budgetMicroUsd: String(gate.budgetMicroUsd),
      settledCents: ceilCents(gate.spentMicroUsd),
      settledMicroUsd: String(gate.spentMicroUsd),
      reservedCents: ceilCents(gate.reservedMicroUsd),
      reservedMicroUsd: String(gate.reservedMicroUsd),
      uncertainCents: ceilCents(gate.uncertainMicroUsd),
      uncertainMicroUsd: String(gate.uncertainMicroUsd),
      remainingCents: Math.floor(Math.max(0, gate.budgetMicroUsd - totalCommitted) / 10_000),
      remainingMicroUsd: String(Math.max(0, gate.budgetMicroUsd - totalCommitted)),
      startsAt: gate.startsAt.toISOString(),
      expiresAt: gate.expiresAt.toISOString(),
      lastUpdatedAt: gate.updatedAt.toISOString(),
    } as const;
  } catch {
    return null;
  }
}

/** One-way operator kill switch; this module exposes no public enable operation. */
export async function disablePublicPilot(organizationId: string): Promise<boolean> {
  if (process.env.DB_DRIVER?.trim().toLowerCase() !== "pg") return false;
  try {
    const [gate] = await db
      .update(publicTurnSpendGates)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(publicTurnSpendGates.id, GATE_ID), eq(publicTurnSpendGates.organizationId, organizationId)))
      .returning({ id: publicTurnSpendGates.id });
    return Boolean(gate);
  } catch {
    return false;
  }
}
