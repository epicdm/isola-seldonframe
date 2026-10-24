-- EPIC 2026-10-20 — tenant ownership transfer support (Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20).
-- Additive and idempotent. No data is changed: the new column is NULL (no cut-off) and the new table is empty.
--   1. organizations.operator_sessions_valid_after: per-workspace operator-portal session cut-off (NULL = none).
--   2. agency_support_sessions.agency_id becomes nullable: NULL = a platform-admin support session on a workspace outside any agency.
--   3. workspace_admin_actions: same-transaction audit record for ownership transfer, its rollback and the internal entitlement.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS operator_sessions_valid_after timestamptz;

ALTER TABLE agency_support_sessions ALTER COLUMN agency_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  reason text,
  actor_user_id uuid NOT NULL,
  actor_email text NOT NULL,
  before jsonb,
  after jsonb,
  reverts_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_admin_actions_org_created_idx ON workspace_admin_actions (org_id, created_at);
