// EPIC 2026-10-11 — signed integration events (first provider: Personal Line). DDL: drizzle/0081_integration_event_inbox.sql.
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
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    applied: boolean("applied").notNull().default(false),
    outcome: text("outcome"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.provider, table.eventId] }),
    index("integration_event_inbox_subject_idx").on(table.orgId, table.provider, table.externalId, table.occurredAt),
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.provider, table.externalId] })],
);
