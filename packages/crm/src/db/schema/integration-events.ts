import { sql } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Durable, workspace-bound Personal Line lifecycle ingress. */
export const integrationEventInbox = pgTable(
  "integration_event_inbox",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    applied: boolean("applied").notNull().default(false),
    outcome: text("outcome"),
    activityLogged: boolean("activity_logged").notNull().default(false),
    eventLogged: boolean("event_logged").notNull().default(false),
    eventDispatched: boolean("event_dispatched").notNull().default(false),
    stageDispatched: boolean("stage_dispatched").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.provider, table.eventId] }),
    index("integration_event_inbox_subject_idx").on(table.orgId, table.provider, table.externalId, table.receivedAt),
  ],
);

/** Authoritative tenant-to-service association facts from the signed ingress. */
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
