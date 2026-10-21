-- EPIC 2026-10-21 — signed integration events (first provider: Personal Line): durable, idempotent ingress.
-- Ported from the 2026-10-11 account slice (its 0081, never deployed), renumbered, plus the deal-projection columns.
-- HAND-WRITTEN. Additive only + idempotent (IF NOT EXISTS). Matches src/db/schema/integration-events.ts. No rows seeded.
--   integration_event_inbox     one row per (org, provider, event_id); a redelivery is a no-op; outcome = what happened
--   integration_subject_facts   merged facts per external subject, and the ONE deal that projects it:
--                               projected_deal_id is claimed (compare-and-set on NULL) BEFORE the deal is inserted with
--                               that id, so two concurrent events can never create two deals for one subject;
--                               projected_deal_created_at records that the insert happened (a deal missing after that was
--                               deleted by an operator and is never re-created).
CREATE TABLE IF NOT EXISTS integration_event_inbox (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  event_id text NOT NULL,
  external_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz,
  detected_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  received_at timestamptz NOT NULL DEFAULT now(),
  applied boolean NOT NULL DEFAULT false,
  outcome text,
  PRIMARY KEY (org_id, provider, event_id)
);

CREATE INDEX IF NOT EXISTS integration_event_inbox_subject_idx
  ON integration_event_inbox(org_id, provider, external_id, received_at);

CREATE TABLE IF NOT EXISTS integration_subject_facts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  last_version bigint NOT NULL CHECK (last_version >= 0),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  projected_deal_id uuid,
  projected_deal_created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, external_id)
);
