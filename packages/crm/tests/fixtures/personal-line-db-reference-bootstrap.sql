-- Drizzle Kit currently adds composite foreign keys before indexes on the referenced table
-- when pushing this complete schema into an empty database. Seed only the referenced
-- Personal Line identity columns and the exact unique indexes here so the disposable
-- CI schema can complete the normal push without weakening the production constraints.
CREATE TABLE external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  contact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX external_identities_org_provider_external_uniq
  ON external_identities (org_id, provider, external_id);
CREATE UNIQUE INDEX external_identities_org_provider_contact_uniq
  ON external_identities (org_id, provider, contact_id);
