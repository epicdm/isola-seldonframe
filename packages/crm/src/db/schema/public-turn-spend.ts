import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { organizations } from "./organizations";

export const publicTurnSpendGates = pgTable("public_turn_spend_gates", {
  id: text("id").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }).notNull(),
  spentMicroUsd: bigint("spent_micro_usd", { mode: "number" }).notNull().default(0),
  reservedMicroUsd: bigint("reserved_micro_usd", { mode: "number" }).notNull().default(0),
  uncertainMicroUsd: bigint("uncertain_micro_usd", { mode: "number" }).notNull().default(0),
  enabled: boolean("enabled").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("public_turn_spend_gates_amounts_nonnegative", sql`${table.budgetMicroUsd} > 0 AND ${table.spentMicroUsd} >= 0 AND ${table.reservedMicroUsd} >= 0 AND ${table.uncertainMicroUsd} >= 0`),
  check("public_turn_spend_gates_expiry_after_start", sql`${table.expiresAt} > ${table.startsAt}`),
]);

export const publicTurnSpendReservations = pgTable("public_turn_spend_reservations", {
  id: uuid("id").primaryKey(),
  gateId: text("gate_id").notNull().references(() => publicTurnSpendGates.id, { onDelete: "restrict" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id"),
  reservedMicroUsd: bigint("reserved_micro_usd", { mode: "number" }).notNull(),
  actualMicroUsd: bigint("actual_micro_usd", { mode: "number" }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  check("public_turn_spend_reservations_amount_positive", sql`${table.reservedMicroUsd} > 0`),
  check("public_turn_spend_reservations_usage_nonnegative", sql`(${table.actualMicroUsd} IS NULL OR ${table.actualMicroUsd} >= 0) AND (${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0)`),
  check("public_turn_spend_reservations_state_valid", sql`${table.state} IN ('reserved', 'settled', 'uncertain', 'released')`),
  index("public_turn_spend_reservations_gate_created_idx").on(table.gateId, table.createdAt),
  index("public_turn_spend_reservations_conversation_idx").on(table.gateId, table.conversationId, table.state),
]);
