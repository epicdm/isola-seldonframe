// Chatwoot customer link: the stored, person-confirmed mapping.
//
// Stored as an `activities` row (type chatwoot_link_confirmed) on the Uplink contact: no schema change, an audit trail for free (who
// confirmed, when), and visible in the contact's Activity tab. NOT in contacts.custom_fields: public writers replace or merge that bag
// (the landing lead form sets custom_fields wholesale; public booking merges booker answers into it), so a link there could be erased or
// planted by a stranger.
//
// Activities are not exclusive to this feature either (the v1 activities API and the agent create_activity tool accept any type and
// metadata), so a row only counts when it carries a valid HMAC over (workspace, Uplink contact, Chatwoot account, Chatwoot contact,
// conversation, confirming user, time) under a key derived from AUTH_SECRET. Copying a row to another contact or workspace, or writing one
// by hand, does not verify. No key = no link is ever shown (fail closed; there is no development fallback key).
import { createHmac, timingSafeEqual } from "node:crypto";

import type { EnvLike } from "./config";

export const CHATWOOT_LINK_ACTIVITY_TYPE = "chatwoot_link_confirmed";
export const CHATWOOT_LINK_SCHEMA = "chatwoot-link/v1";
const KEY_LABEL = "uplink:chatwoot-link-record:v1";

export type ChatwootLinkRecord = {
  orgId: string;
  uplinkContactId: string;
  accountId: string;
  chatwootContactId: number;
  conversationId: number;
  confirmedByUserId: string;
  confirmedAt: string;
};

export function chatwootLinkKey(env: EnvLike): string | null {
  const secret = (env.AUTH_SECRET ?? "").trim() || (env.NEXTAUTH_SECRET ?? "").trim();
  if (secret.length < 16) return null;
  return createHmac("sha256", secret).update(KEY_LABEL).digest("hex");
}

function canonical(r: ChatwootLinkRecord): string {
  return JSON.stringify([
    CHATWOOT_LINK_SCHEMA,
    r.orgId.toLowerCase(),
    r.uplinkContactId.toLowerCase(),
    r.accountId,
    r.chatwootContactId,
    r.conversationId,
    r.confirmedByUserId,
    r.confirmedAt,
  ]);
}

const sign = (r: ChatwootLinkRecord, key: string) => createHmac("sha256", key).update(canonical(r)).digest("hex");

/** The metadata stored on the activity row. orgId and the Uplink contact id live in the row's own columns and are covered by the signature. */
export function chatwootLinkMetadata(r: ChatwootLinkRecord, key: string): Record<string, unknown> {
  return {
    schema: CHATWOOT_LINK_SCHEMA,
    accountId: r.accountId,
    chatwootContactId: r.chatwootContactId,
    conversationId: r.conversationId,
    confirmedByUserId: r.confirmedByUserId,
    confirmedAt: r.confirmedAt,
    sig: sign(r, key),
  };
}

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/**
 * A verified record for THIS workspace, THIS Uplink contact and THIS Chatwoot account, or null. `row` is the activity as read from the DB
 * (its own org/contact columns, not anything inside metadata).
 */
export function verifyChatwootLink(
  row: { orgId: string; contactId: string | null; metadata: unknown },
  expected: { orgId: string; contactId: string; accountId: string },
  key: string | null,
): ChatwootLinkRecord | null {
  if (!key || !row.contactId) return null;
  if (row.orgId.toLowerCase() !== expected.orgId.toLowerCase() || row.contactId.toLowerCase() !== expected.contactId.toLowerCase()) return null;
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  if (m.schema !== CHATWOOT_LINK_SCHEMA) return null;
  const accountId = str(m.accountId);
  const chatwootContactId = posInt(m.chatwootContactId);
  const conversationId = posInt(m.conversationId);
  const confirmedByUserId = str(m.confirmedByUserId);
  const confirmedAt = str(m.confirmedAt);
  const sig = typeof m.sig === "string" && /^[0-9a-f]{64}$/.test(m.sig) ? m.sig : null;
  if (!accountId || !chatwootContactId || !conversationId || !confirmedByUserId || !confirmedAt || !sig) return null;
  if (accountId !== expected.accountId) return null; // re-mapped workspace: an old account's link is not shown
  const record: ChatwootLinkRecord = {
    orgId: row.orgId,
    uplinkContactId: row.contactId,
    accountId,
    chatwootContactId,
    conversationId,
    confirmedByUserId,
    confirmedAt,
  };
  const want = Buffer.from(sign(record, key), "hex");
  const got = Buffer.from(sig, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return record;
}
