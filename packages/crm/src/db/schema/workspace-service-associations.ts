import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { externalIdentities } from "./external-identities";
import { integrationEventInbox } from "./integration-events";

/**
 * Trusted association between a workspace contact identity and an account in
 * an external service. Rows are written only from signed provider events; an
 * entered phone number or a matching DID is never sufficient ownership proof.
 */
export const workspaceServiceAssociations = pgTable(
  "workspace_service_associations",
  {
    id: uuid("id").default(sql`gen_random_uuid()`).primaryKey(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    tenantKey: text("tenant_key").notNull(),
    externalSubjectId: text("external_subject_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.provider, table.externalSubjectId],
      foreignColumns: [externalIdentities.orgId, externalIdentities.provider, externalIdentities.externalId],
      name: "workspace_service_associations_identity_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.provider, table.sourceEventId],
      foreignColumns: [integrationEventInbox.orgId, integrationEventInbox.provider, integrationEventInbox.eventId],
      name: "workspace_service_associations_event_fk",
    }).onDelete("cascade"),
    uniqueIndex("workspace_service_associations_provider_tenant_account_uidx")
      .on(table.provider, table.tenantKey, table.externalAccountId),
    uniqueIndex("workspace_service_associations_org_provider_subject_uidx")
      .on(table.orgId, table.provider, table.externalSubjectId),
    index("workspace_service_associations_org_provider_idx").on(table.orgId, table.provider),
  ],
);
