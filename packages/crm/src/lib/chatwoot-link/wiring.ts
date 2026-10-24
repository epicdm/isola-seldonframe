// Chatwoot customer link: production wiring (DB store, env, token file). Server-only.
import { readFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { activities, contacts } from "@/db/schema";

import { loadChatwootLinkTarget, loadChatwootLookupConfig, type EnvLike } from "./config";
import { makeChatwootReader, type Fetch } from "./reader";
import { chatwootLinkKey, CHATWOOT_LINK_ACTIVITY_TYPE } from "./record";
import type { ChatwootLinkDeps, ChatwootLinkStore } from "./service";

/** Any drizzle Postgres database over this schema (the app's neon-http client, or node-postgres in tests). */
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Every query carries the workspace id in its WHERE clause. */
export function makeChatwootLinkStore(database: Db = db): ChatwootLinkStore {
  return {
    async getContact(orgId, contactId) {
      const [row] = await database
        .select({ id: contacts.id, orgId: contacts.orgId, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
        .limit(1);
      return row ?? null;
    },
    async linkActivities(orgId, contactId, limit, offset) {
      return database
        .select({ id: activities.id, orgId: activities.orgId, contactId: activities.contactId, metadata: activities.metadata })
        .from(activities)
        .where(and(eq(activities.orgId, orgId), eq(activities.contactId, contactId), eq(activities.type, CHATWOOT_LINK_ACTIVITY_TYPE)))
        .orderBy(desc(activities.createdAt), desc(activities.id))
        .limit(limit)
        .offset(offset);
    },
    async insertLinkActivity(a) {
      const now = new Date();
      await database.insert(activities).values({
        id: a.id,
        orgId: a.orgId,
        contactId: a.contactId,
        userId: a.userId,
        type: CHATWOOT_LINK_ACTIVITY_TYPE,
        subject: a.subject,
        body: null,
        metadata: a.metadata,
        completedAt: now,
      });
    },
  };
}

const readSecretFile = (p: string) => readFileSync(p, "utf8");

export function makeChatwootLinkDeps(
  orgId: string | null,
  o: { env?: EnvLike; database?: Db; fetch?: Fetch; readSecretFile?: (p: string) => string; now?: () => Date } = {},
): ChatwootLinkDeps {
  const env = o.env ?? process.env;
  const target = loadChatwootLinkTarget(orgId, env);
  const lookup = target ? loadChatwootLookupConfig(orgId, env, o.readSecretFile ?? readSecretFile) : null;
  return {
    store: makeChatwootLinkStore(o.database ?? db),
    target,
    lookup,
    reader: lookup ? makeChatwootReader({ apiBase: lookup.apiBase, accountId: lookup.accountId, apiToken: lookup.apiToken, fetch: o.fetch }) : null,
    key: chatwootLinkKey(env),
    now: o.now ?? (() => new Date()),
  };
}
