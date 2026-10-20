// EPIC 2026-10-20 (migration 0080) — audit record for platform-admin actions on a tenant workspace: ownership transfer, its
// rollback, and the internal (payment-off) entitlement. Written in the SAME transaction as the change it records (a refusal is
// written on its own), so the record and the state can never disagree. workflow_event_log is not used for this: its writes are
// best-effort and outside the caller's transaction. Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20.

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const WORKSPACE_ADMIN_ACTIONS = ["ownership_transfer", "ownership_transfer_rollback", "internal_entitlement"] as const;
export type WorkspaceAdminAction = (typeof WORKSPACE_ADMIN_ACTIONS)[number];
export const WORKSPACE_ADMIN_OUTCOMES = ["applied", "already_applied", "refused", "failed"] as const;
export type WorkspaceAdminOutcome = (typeof WORKSPACE_ADMIN_OUTCOMES)[number];

export const workspaceAdminActions = pgTable(
  "workspace_admin_actions",
  {
    id: uuid("id").default(sql`gen_random_uuid()`).primaryKey(),
    // Not a foreign key: the record must survive anything that later happens to the workspace.
    orgId: uuid("org_id").notNull(),
    action: text("action").$type<WorkspaceAdminAction>().notNull(),
    outcome: text("outcome").$type<WorkspaceAdminOutcome>().notNull(),
    reason: text("reason"),
    actorUserId: uuid("actor_user_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    // For a rollback: the id of the transfer row it reverses.
    revertsActionId: uuid("reverts_action_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workspace_admin_actions_org_created_idx").on(table.orgId, table.createdAt)],
);

export type WorkspaceAdminActionRow = typeof workspaceAdminActions.$inferSelect;
