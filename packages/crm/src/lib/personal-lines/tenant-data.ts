import { and, eq, sql } from "drizzle-orm";
import { readPersonalLineServiceEvidence, type PersonalLineServiceEvidence } from "./bff-reader";

const STAGES = ["Signup started", "Line created", "App activated", "First call"] as const;
const PUBLIC_FACT_KEYS = new Set([
  "door", "did_masked", "registered_at", "registration_observed_at",
  "credential_fetched_at", "first_call_at", "first_call_detected_at",
]);

export type PersonalLineRecord = {
  /** Opaque workspace-local contact reference; upstream service IDs stay server-side. */
  referenceId: string;
  accountAssigned: boolean;
  serviceAssociationStatus: "verified" | "pending" | "unverified";
  customerId: string;
  customerName: string;
  stage: string;
  facts: Record<string, string>;
  /** Verified live service evidence is fetched only for a tenant-scoped detail read. */
  serviceEvidence: PersonalLineServiceEvidence;
  updatedAt: string;
};

export type SubjectFactsRow = {
  orgId: string;
  provider: string;
  externalId: string;
  lastVersion: number;
  facts: Record<string, unknown> | null;
  projectedDealId: string | null;
  projectedDealCreatedAt: Date | null;
  updatedAt: Date;
  customerId: string;
  customerName: string;
  /** Internal only: present after the signed event created the service-account association. */
  serviceAccountId: string | null;
  serviceTenantKey: string | null;
};
export type TenantFactsReader = (orgId: string, contactId?: string) => Promise<SubjectFactsRow[]>;

function projectRecord(row: SubjectFactsRow, serviceEvidence: PersonalLineServiceEvidence = { status: "unavailable" }): PersonalLineRecord {
  const raw = row.facts ?? {};
  const facts: Record<string, string> = {};
  for (const key of PUBLIC_FACT_KEYS) {
    const value = raw[key];
    if (typeof value === "string") facts[key] = value;
  }
  const stageIndex = Math.max(0, Math.min(STAGES.length - 1, Number(row.lastVersion) - 1));
  return {
    referenceId: row.customerId,
    accountAssigned: Boolean(row.serviceAccountId),
    serviceAssociationStatus: row.serviceAccountId ? "verified" : typeof raw.pl_account_id === "string" && raw.pl_account_id ? "unverified" : "pending",
    customerId: row.customerId,
    customerName: row.customerName,
    stage: STAGES[stageIndex],
    facts,
    serviceEvidence,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All reads require the caller's server-resolved org id and query by that tenant first. */
export function createTenantPersonalLineReader(
  readRows: TenantFactsReader,
  readService: (orgId: string, tenantKey: string, accountId: string) => Promise<PersonalLineServiceEvidence> = readPersonalLineServiceEvidence,
) {
  return {
    async list(orgId: string, search = ""): Promise<PersonalLineRecord[]> {
      const rows = await readRows(orgId);
      const needle = search.trim().toLowerCase();
      return rows
        .map((row) => projectRecord(row))
        // A signed signup_started event is already a real, tenant-bound
        // onboarding record even though plsvc has not assigned an account ID
        // yet. Keep it visible so the workspace can observe the first stage.
        .filter((record) => !needle || [record.facts.did_masked, record.customerName].some((value) => value?.toLowerCase().includes(needle)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  async get(orgId: string, contactId: string): Promise<PersonalLineRecord | null> {
      const [row] = await readRows(orgId, contactId);
      if (!row) return null;
      const accountId = row.serviceAccountId;
      const serviceEvidence = accountId && row.serviceTenantKey
        ? await readService(orgId, row.serviceTenantKey, accountId).catch(() => ({ status: "unavailable" as const }))
        : { status: "not_linked" as const };
      return projectRecord(row, serviceEvidence);
    },
  };
}

const tenantReader = createTenantPersonalLineReader(async (orgId, contactId) => {
  const [{ db }, { contacts, externalIdentities, integrationSubjectFacts, workspaceServiceAssociations }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
  ]);
  const query = db
    .select({
      orgId: integrationSubjectFacts.orgId,
      provider: integrationSubjectFacts.provider,
      externalId: integrationSubjectFacts.externalId,
      lastVersion: integrationSubjectFacts.lastVersion,
      facts: integrationSubjectFacts.facts,
      projectedDealId: integrationSubjectFacts.projectedDealId,
      projectedDealCreatedAt: integrationSubjectFacts.projectedDealCreatedAt,
      updatedAt: integrationSubjectFacts.updatedAt,
      customerId: contacts.id,
      customerName: sql<string>`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`,
      serviceAccountId: workspaceServiceAssociations.externalAccountId,
      serviceTenantKey: workspaceServiceAssociations.tenantKey,
    })
    .from(integrationSubjectFacts)
    .innerJoin(externalIdentities, and(
      eq(externalIdentities.orgId, integrationSubjectFacts.orgId),
      eq(externalIdentities.provider, integrationSubjectFacts.provider),
      eq(externalIdentities.externalId, integrationSubjectFacts.externalId),
    ))
    .innerJoin(contacts, and(
      eq(contacts.orgId, integrationSubjectFacts.orgId),
      eq(contacts.id, externalIdentities.contactId),
    ))
    .leftJoin(workspaceServiceAssociations, and(
      eq(workspaceServiceAssociations.orgId, integrationSubjectFacts.orgId),
      eq(workspaceServiceAssociations.provider, integrationSubjectFacts.provider),
      eq(workspaceServiceAssociations.externalSubjectId, integrationSubjectFacts.externalId),
      sql`${workspaceServiceAssociations.externalAccountId} = ${integrationSubjectFacts.facts}->>'pl_account_id'`,
    ))
    .where(and(
      eq(integrationSubjectFacts.orgId, orgId),
      eq(integrationSubjectFacts.provider, "personal_line"),
      ...(contactId ? [eq(contacts.id, contactId)] : []),
    ));
  // Account ownership is bounded by the service, not by an arbitrary UI
  // cap. A tenant with more than 500 lines must still be able to search or
  // inspect every association. Detail reads remain one-row lookups.
  return contactId ? query.limit(1) : query;
});

export const listTenantPersonalLines = tenantReader.list;
export const getTenantPersonalLine = tenantReader.get;
