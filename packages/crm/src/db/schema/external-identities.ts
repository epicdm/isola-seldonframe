// EPIC 2026-10-11 — Personal Line subscriber account slice (2a).
//
// A TRUSTED link from an external engine's subject to a workspace contact. For provider "personal_line" the
// external_id is the Personal Line service's liteAccount id and the link is written ONLY by the signed
// plsvc -> SeldonFrame ingress (src/lib/personal-line/link.ts). Intake forms, chat, email and phone fields can
// never create or change it — a self-entered phone number or email is not proof of subscriber ownership.
//
// One external subject maps to at most one contact per workspace, and one contact holds at most one subject per
// provider per workspace (the two unique indexes). DDL: drizzle/0080_external_identities.sql (hand-written).
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./contacts";
import { organizations } from "./organizations";

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_identities_org_provider_external_uniq").on(table.orgId, table.provider, table.externalId),
    uniqueIndex("external_identities_org_provider_contact_uniq").on(table.orgId, table.provider, table.contactId),
    index("external_identities_contact_idx").on(table.contactId),
  ],
);
