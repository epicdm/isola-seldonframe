-- EPIC 2026-10-21 — Personal Line lifecycle: trusted external subject -> contact link.
-- Ported unchanged in shape from the 2026-10-11 account slice (isola-seldonframe#12, its 0080, never deployed),
-- renumbered because 0080 is now workspace_admin_actions. HAND-WRITTEN. Additive only + idempotent (IF NOT EXISTS).
-- Matches src/db/schema/external-identities.ts. Written ONLY by the signed Personal Line ingress
-- (POST /api/webhooks/personal-line/[orgId], src/lib/personal-line/link.ts). No rows are seeded.
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
