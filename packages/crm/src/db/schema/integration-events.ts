// EPIC 2026-10-21 — signed integration events (first provider: Personal Line). DDL: drizzle/0082_integration_event_inbox.sql.
// Ported from the 2026-10-11 account slice; adds detected_at (event time and detection time are different facts)
// and the deal-projection columns (one deal per subject per workspace, claimed before insert).
import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const integrationEventInbox = pgTable(
  "integration_event_inbox",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    /** When it happened, if the sender knows. NULL = unknown — never filled with a detection time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** When the sender observed / recorded it. */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    applied: boolean("applied").notNull().default(false),
    outcome: text("outcome"),
    /** exactly-once markers, each set in the SAME statement that writes its effect */
    activityLogged: boolean("activity_logged").notNull().default(false),
    eventLogged: boolean("event_logged").notNull().default(false),
    /** in-process dispatch of the logged rows done (at-least-once; see lib/personal-line/lifecycle.ts) */
    eventDispatched: boolean("event_dispatched").notNull().default(false),
    stageDispatched: boolean("stage_dispatched").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.provider, table.eventId] }),
    index("integration_event_inbox_subject_idx").on(table.orgId, table.provider, table.externalId, table.receivedAt),
  ],
);

export const integrationSubjectFacts = pgTable(
  "integration_subject_facts",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    lastVersion: bigint("last_version", { mode: "number" }).notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    projectedDealId: uuid("projected_deal_id"),
    projectedDealCreatedAt: timestamp("projected_deal_created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.provider, table.externalId] })],
);
