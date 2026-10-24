-- Trusted workspace -> external service-account ownership links.
-- Written only by the signed provider lifecycle ingress. Never infer ownership
-- from a caller-entered phone number, email address, or a matching DID.
CREATE TABLE IF NOT EXISTS workspace_service_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  tenant_key text NOT NULL,
  external_subject_id text NOT NULL,
  external_account_id text NOT NULL,
  source_event_id text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_service_associations_identity_fk
    FOREIGN KEY (org_id, provider, external_subject_id)
    REFERENCES external_identities(org_id, provider, external_id) ON DELETE CASCADE,
  CONSTRAINT workspace_service_associations_event_fk
    FOREIGN KEY (org_id, provider, source_event_id)
    REFERENCES integration_event_inbox(org_id, provider, event_id) ON DELETE CASCADE
);

-- An upstream account belongs to exactly one Uplink workspace for a provider
-- tenant, even if two workspaces receive the same signed subject event.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_service_associations_provider_tenant_account_uidx
  ON workspace_service_associations(provider, tenant_key, external_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_service_associations_org_provider_subject_uidx
  ON workspace_service_associations(org_id, provider, external_subject_id);
CREATE INDEX IF NOT EXISTS workspace_service_associations_org_provider_idx
  ON workspace_service_associations(org_id, provider);
