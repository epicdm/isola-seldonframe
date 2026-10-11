-- EPIC 2026-10-11 — signed integration events (first provider: Personal Line, design §2): durable, idempotent ingress.
-- HAND-WRITTEN (house rule: never drizzle-kit generate in this repo). Additive only + idempotent (IF NOT EXISTS).
-- Matches src/db/schema/integration-events.ts exactly. No rows are seeded. Generic on purpose: workflow_event_log has
-- no unique external event id, so any signed provider ingress dedupes here.
--   integration_event_inbox     one row per (org, provider, event_id); a duplicate is a no-op; outcome = what was applied
--   integration_subject_facts   newest projected facts per external subject; an event whose version is <= last_version
--                               never overwrites them, so out-of-order delivery cannot regress current state
CREATE TABLE IF NOT EXISTS integration_event_inbox (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  event_id text NOT NULL,
  external_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  received_at timestamptz NOT NULL DEFAULT now(),
  applied boolean NOT NULL DEFAULT false,
  outcome text,
  PRIMARY KEY (org_id, provider, event_id)
);

CREATE INDEX IF NOT EXISTS integration_event_inbox_subject_idx
  ON integration_event_inbox(org_id, provider, external_id, occurred_at);

CREATE TABLE IF NOT EXISTS integration_subject_facts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  last_version bigint NOT NULL CHECK (last_version >= 1),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, external_id)
);
