// EPIC 2026-10-11 — Personal Line as a WORKSPACE integration (native pattern; see
// ev-lane-a-integration-conformance-audit-2026-10-11):
//   non-secret config  -> organizations.integrations.personalLine  (typed, db/schema/organizations.ts)
//   the two HMAC keys  -> workspace_secrets via storeSecret / getSecretValue / rotateSecret (lib/secrets.ts)
//   UI                 -> the "Personal Line" card on settings/integrations + a test-connection action (actions.ts here)
// No env var and no deployment-level workspace pin: every read is scoped by the orgId the caller already proved
// (portal session org, or the [orgId] of the signed webhook whose MAC verified with THAT org's key).
import type { PlKey } from "./signing";

export const PL_SECRET_EVENTS = "personal-line-events";
export const PL_SECRET_SUMMARY = "personal-line-summary";
export const PL_PROVIDER_NAME = "personal_line";

const KEY_ID = /^[a-z0-9]{1,16}$/;

export type PersonalLineConfig = { baseUrl: string; events: PlKey | null; summary: PlKey | null };

export type PersonalLineIntegrationRecord = {
  connected: boolean;
  baseUrl: string;
  eventsKeyId: string;
  summaryKeyId: string;
  lastCheckedAt?: string;
  lastCheckOk?: boolean;
  lastCheckDetail?: string;
};

/** Validation shared by the settings action and the tests. Returns the error code, or null when valid. */
export function validatePersonalLineSettings(input: { baseUrl: string; eventsKeyId: string; summaryKeyId: string }): string | null {
  let u: URL;
  try { u = new URL(input.baseUrl); } catch { return "invalid_base_url"; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return "invalid_base_url";
  if (!KEY_ID.test(input.eventsKeyId) || !KEY_ID.test(input.summaryKeyId)) return "invalid_key_id";
  return null;
}

/** A signing key must be >= 32 bytes and contain no whitespace (same rule as lib/agents/mcp/relay-context.ts). */
export function validSigningKey(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 32 && !/\s/.test(value);
}

export interface ConfigDeps {
  readRecord(orgId: string): Promise<PersonalLineIntegrationRecord | null>;
  readSecret(orgId: string, serviceName: string): Promise<string | null>;
}

/** The workspace's Personal Line config, or null when the integration is not connected (=> no card, ingress 503). */
export async function resolvePersonalLine(orgId: string, deps: ConfigDeps): Promise<PersonalLineConfig | null> {
  const rec = await deps.readRecord(orgId);
  if (!rec?.connected || validatePersonalLineSettings(rec) !== null) return null;
  const [ev, sum] = await Promise.all([deps.readSecret(orgId, PL_SECRET_EVENTS), deps.readSecret(orgId, PL_SECRET_SUMMARY)]);
  return {
    baseUrl: rec.baseUrl,
    events: ev && validSigningKey(ev) ? { kid: rec.eventsKeyId, key: ev } : null,
    summary: sum && validSigningKey(sum) ? { kid: rec.summaryKeyId, key: sum } : null,
  };
}

/** Production deps over the app's own stores (lazy imports keep unit tests DB-free). Server-side callers only. */
export async function productionConfigDeps(): Promise<ConfigDeps> {
  const { db } = await import("@/db");
  const { organizations } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getSecretValue } = await import("@/lib/secrets");
  return {
    async readRecord(orgId) {
      const [org] = await db.select({ integrations: organizations.integrations }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return (org?.integrations?.personalLine as PersonalLineIntegrationRecord | undefined) ?? null;
    },
    async readSecret(orgId, serviceName) {
      // skipAccessCheck: a server-to-server read for a workspace the caller already scoped (no operator session here).
      return getSecretValue({ workspaceId: orgId, serviceName, skipAccessCheck: true });
    },
  };
}

/** Write the non-secret record (merging, never dropping other providers' entries). Used by the settings action. */
export async function writePersonalLineRecord(orgId: string, patch: Partial<PersonalLineIntegrationRecord>): Promise<void> {
  const { db } = await import("@/db");
  const { organizations } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [org] = await db.select({ integrations: organizations.integrations }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new Error("Organization not found");
  const integrations = { ...(org.integrations ?? {}) };
  const current = integrations.personalLine ?? { connected: false, baseUrl: "", eventsKeyId: "", summaryKeyId: "" };
  integrations.personalLine = { ...current, ...patch };
  await db.update(organizations).set({ integrations, updatedAt: new Date() }).where(eq(organizations.id, orgId));
}
