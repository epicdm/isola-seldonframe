// EPIC 2026-10-11 — Personal Line journey events (design §2). DDL: drizzle/0081_pl_event_inbox.sql (hand-written).
import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const plEventInbox = pgTable(
  "pl_event_inbox",
  {
    eventId: uuid("event_id").primaryKey(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    plAccountId: text("pl_account_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    applied: boolean("applied").notNull().default(false),
    outcome: text("outcome"),
  },
  (table) => [index("pl_event_inbox_org_account_idx").on(table.orgId, table.plAccountId, table.occurredAt)],
);

export const plAccountFacts = pgTable(
  "pl_account_facts",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    plAccountId: text("pl_account_id").notNull(),
    lastVersion: bigint("last_version", { mode: "number" }).notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.plAccountId] })],
);
