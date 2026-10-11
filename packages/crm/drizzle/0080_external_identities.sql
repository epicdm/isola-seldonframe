-- EPIC 2026-10-11 — Personal Line subscriber account slice (2a): trusted external subject -> contact link.
-- HAND-WRITTEN (house rule: never drizzle-kit generate in this repo). Additive only + idempotent (IF NOT EXISTS),
-- so a re-run after an out-of-band apply is a no-op. Matches src/db/schema/external-identities.ts exactly.
-- Written ONLY by the signed plsvc -> SeldonFrame ingress (POST /api/v1/integrations/personal-line/link).
-- No rows are seeded.
CREATE TABLE IF NOT EXISTS external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS external_identities_org_provider_external_uniq
  ON external_identities(org_id, provider, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS external_identities_org_provider_contact_uniq
  ON external_identities(org_id, provider, contact_id);
CREATE INDEX IF NOT EXISTS external_identities_contact_idx
  ON external_identities(contact_id);
