-- EPIC 2026-10-11 — Personal Line journey events (subscriber account slice 2a, design §2): durable, idempotent ingress.
-- HAND-WRITTEN (house rule: never drizzle-kit generate in this repo). Additive only + idempotent (IF NOT EXISTS).
-- Matches src/db/schema/pl-events.ts exactly. No rows are seeded.
--   pl_event_inbox    one row per received event_id (duplicate event_id = no-op); outcome records what was applied.
--   pl_account_facts  the newest projected facts per Personal Line account; an event with a version <= last_version
--                     never overwrites them (stale), so out-of-order delivery cannot regress current state.
CREATE TABLE IF NOT EXISTS pl_event_inbox (
  event_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pl_account_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  received_at timestamptz NOT NULL DEFAULT now(),
  applied boolean NOT NULL DEFAULT false,
  outcome text
);

CREATE INDEX IF NOT EXISTS pl_event_inbox_org_account_idx
  ON pl_event_inbox(org_id, pl_account_id, occurred_at);

CREATE TABLE IF NOT EXISTS pl_account_facts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pl_account_id text NOT NULL,
  last_version bigint NOT NULL CHECK (last_version >= 1),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, pl_account_id)
);
