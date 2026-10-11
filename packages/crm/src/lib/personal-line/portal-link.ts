// EPIC 2026-10-11 - R1 slice S-c: the WhatsApp portal link (the real customer's way into "Your Personal Line").
//
// WHY: contacts created by the signed event ingress have NO email, so a customer cannot use the emailed-code sign-in. The
// subscriber already proved the line is theirs by messaging EPIC on WhatsApp (plsvc has the Meta-verified sender). plsvc
// asks THIS endpoint for a sign-in link for exactly that subscriber and posts the URL back into that WhatsApp conversation.
//
//   POST /api/webhooks/personal-line/[orgId]/portal-link        (server-to-server; the URL is returned to plsvc, never a browser)
//     body {"request_id": "<uuid>", "pl_account_id": "<account>"}   exactly these keys
//     X-PL-SF-Kid / -Ts / -Sig  = HMAC-SHA256(workspace "personal-line-events" key, "pl-sf-portal-link-v1.<ts>.<raw body>"), +-300 s
//     503 not configured | 401 bad/old signature | 422 invalid body | 409 replayed request_id | 404 account not linked
//     409 portal_unavailable (plan gate) | 429 too many links for this contact | 200 {ok,url,expires_at}
//
//   GET  /customer/[orgSlug]/wa-link?token=...   interstitial page only (a link preview / prefetch must NOT consume the link)
//   POST /customer/[orgSlug]/wa-link             consumes the link ATOMICALLY (single use), sets the portal session cookie
//
// The token is 32 random bytes; only its SHA-256 is stored (portal_access_codes, the table the emailed-code flow already
// uses: hash + expiry + used_at + contact binding; the row's email is the marker below, which no typed email can equal).
// A link is bound to ONE contact, lives 10 minutes, and is used once. Minting enables portal access for THAT contact only.
// No new table, no migration. Magic-link machinery reused: the same signed portal session cookie as the emailed code.
import { createHash, randomBytes } from "node:crypto";
import { PL_PROVIDER } from "./link";
import { verifyPortalLinkRequest, type PlKey } from "./signing";

export const WA_LINK_MARKER = "wa-link";
export const WA_LINK_TTL_MS = 10 * 60_000;
export const WA_LINK_RATE_WINDOW_MS = 10 * 60_000;
export const WA_LINK_RATE_MAX = 3;
export const WA_LINK_PROVIDER = "personal_line_portal_link";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ORG_UUID = UUID;

export const hashLinkToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const newLinkToken = () => randomBytes(32).toString("base64url");

export function parsePortalLinkRequest(raw: string): { requestId: string; plAccountId: string } | null {
  if (Buffer.byteLength(raw, "utf8") > 512) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "request_id" && k !== "pl_account_id")) return null;
  if (typeof o.request_id !== "string" || !UUID.test(o.request_id)) return null;
  if (typeof o.pl_account_id !== "string" || !ACCOUNT_RE.test(o.pl_account_id)) return null;
  return { requestId: o.request_id.toLowerCase(), plAccountId: o.pl_account_id };
}

export interface PortalLinkStore {
  /** true = this request_id is new and now claimed; false = replay. */
  claimRequest(orgId: string, requestId: string, accountId: string): Promise<boolean>;
  finishRequest(orgId: string, requestId: string, outcome: string): Promise<void>;
  /** The contact linked to this plsvc account in THIS workspace (external_identities), or null. */
  findLinkedContact(orgId: string, accountId: string): Promise<string | null>;
  orgSlug(orgId: string): Promise<string | null>;
  portalAllowed(orgId: string): Promise<boolean>;
  recentMintCount(orgId: string, contactId: string, since: Date): Promise<number>;
  /** Enable portal access for this contact, retire its older unused links, store the new hash. */
  mint(orgId: string, contactId: string, tokenHash: string, expiresAt: Date): Promise<void>;
}

export type PortalLinkDeps = {
  resolveEventsKey(orgId: string): Promise<PlKey | null>;
  store(): Promise<PortalLinkStore>;
  appOrigin(): string;
  nowS?: () => number;
  newToken?: () => string;
};

export async function handlePortalLinkRequest(request: Request, orgId: string, deps: PortalLinkDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return { status: 400, body: { ok: false, error: "unreadable_body" } };
  const key = ORG_UUID.test(orgId) ? await deps.resolveEventsKey(orgId).catch(() => null) : null;
  if (!key) return { status: 503, body: { ok: false, error: "personal_line_not_configured" } };
  const nowS = (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  const check = verifyPortalLinkRequest(request.headers, raw, key, nowS);
  if (!check.ok) {
    console.warn(`[pl-portal-link] refused: ${check.why}`);
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }
  const req = parsePortalLinkRequest(raw);
  if (!req) return { status: 422, body: { ok: false, error: "invalid_request" } };
  const store = await deps.store();
  if (!(await store.claimRequest(orgId, req.requestId, req.plAccountId))) {
    return { status: 409, body: { ok: false, error: "replayed_request" } };
  }
  const done = async (status: number, error: string, outcome: string) => {
    await store.finishRequest(orgId, req.requestId, outcome);
    return { status, body: { ok: false, error } };
  };
  // ONLY an account already linked by the signed event ingress gets a link; nothing is created or adopted here.
  const contactId = await store.findLinkedContact(orgId, req.plAccountId);
  if (!contactId) return done(404, "account_not_linked", "not_linked");
  const slug = await store.orgSlug(orgId);
  if (!slug) return done(404, "account_not_linked", "no_workspace");
  if (!(await store.portalAllowed(orgId))) return done(409, "portal_unavailable", "plan_gate");
  const now = new Date(nowS * 1000);
  if ((await store.recentMintCount(orgId, contactId, new Date(now.getTime() - WA_LINK_RATE_WINDOW_MS))) >= WA_LINK_RATE_MAX) {
    return done(429, "rate_limited", "rate_limited");
  }
  const token = (deps.newToken ?? newLinkToken)();
  const expiresAt = new Date(now.getTime() + WA_LINK_TTL_MS);
  await store.mint(orgId, contactId, hashLinkToken(token), expiresAt);
  await store.finishRequest(orgId, req.requestId, "minted");
  const url = new URL(`/customer/${slug}/wa-link`, deps.appOrigin());
  url.searchParams.set("token", token);
  console.info(`[pl-portal-link] minted org=${orgId} request=${req.requestId}`);
  return { status: 200, body: { ok: true, url: url.toString(), expires_at: expiresAt.toISOString() } };
}

// ── redemption ───────────────────────────────────────────────────────────────
export interface RedeemStore {
  orgIdForSlug(slug: string): Promise<string | null>;
  /** ATOMIC single use: marks the row used iff unused, unexpired, marker row of this org; returns its contact. */
  consume(orgId: string, tokenHash: string, now: Date): Promise<{ contactId: string } | null>;
  /** Still the contact linked to a plsvc account in this workspace (a link survives only while the identity does). */
  isLinkedContact(orgId: string, contactId: string): Promise<boolean>;
  contactEmail(orgId: string, contactId: string): Promise<string | null>;
}

export type Redeemed = { orgId: string; contactId: string; email: string };

export async function redeemWaLink(orgSlug: string, token: string, store: RedeemStore, now: Date = new Date()): Promise<Redeemed | null> {
  if (!TOKEN_RE.test(token)) return null;
  const orgId = await store.orgIdForSlug(orgSlug);
  if (!orgId) return null;
  const hit = await store.consume(orgId, hashLinkToken(token), now);
  if (!hit) return null;
  if (!(await store.isLinkedContact(orgId, hit.contactId))) return null;
  // The signed portal session needs a non-empty email; an email-less subscriber gets a fixed marker (never shown).
  const email = (await store.contactEmail(orgId, hit.contactId)) || WA_LINK_MARKER;
  return { orgId, contactId: hit.contactId, email };
}

export function waLinkInterstitial(orgSlug: string, token: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Open your Personal Line</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
    `<h1 style="font-size:1.25rem">Open your Personal Line account</h1>` +
    `<p>This sign-in link works once and expires soon.</p>` +
    `<form method="post" action="/customer/${esc(encodeURIComponent(orgSlug))}/wa-link"><input type="hidden" name="token" value="${esc(token)}">` +
    `<button type="submit" style="font-size:1rem;padding:.75rem 1.5rem">Continue</button></form></body></html>`;
}

export function appOriginFromEnv(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim() || process.env.APP_URL?.trim() || "http://localhost:3000");
}

// ── production stores over drizzle (lazy imports keep unit tests DB-free) ────
export async function drizzlePortalLinkStore(opts: { db?: any; portalAllowed?: (orgId: string) => Promise<boolean> } = {}): Promise<PortalLinkStore & RedeemStore> {
  // `opts` exists so the real-Postgres harness can run THESE queries over a node-postgres drizzle client.
  const db = opts.db ?? (await import("@/db")).db;
  const { contacts, externalIdentities, integrationEventInbox: inbox, organizations, portalAccessCodes: codes } = await import("@/db/schema");
  const { and, eq, gt, isNull, sql } = await import("drizzle-orm");
  return {
    async claimRequest(orgId, requestId, accountId) {
      const rows = await db.insert(inbox)
        .values({ orgId, provider: WA_LINK_PROVIDER, eventId: requestId, externalId: accountId, type: "portal_link_request", occurredAt: new Date(), version: 1 })
        .onConflictDoNothing()
        .returning({ id: inbox.eventId });
      return rows.length === 1;
    },
    async finishRequest(orgId, requestId, outcome) {
      await db.update(inbox).set({ applied: outcome === "minted", outcome })
        .where(and(eq(inbox.orgId, orgId), eq(inbox.provider, WA_LINK_PROVIDER), eq(inbox.eventId, requestId)));
    },
    async findLinkedContact(orgId, accountId) {
      const [row] = await db.select({ contactId: externalIdentities.contactId }).from(externalIdentities)
        .innerJoin(contacts, and(eq(contacts.id, externalIdentities.contactId), eq(contacts.orgId, externalIdentities.orgId)))
        .where(and(eq(externalIdentities.orgId, orgId), eq(externalIdentities.provider, PL_PROVIDER), eq(externalIdentities.externalId, accountId)))
        .limit(1);
      return row?.contactId ?? null;
    },
    async orgSlug(orgId) {
      const [o] = await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return o?.slug ?? null;
    },
    async portalAllowed(orgId) {
      if (opts.portalAllowed) return opts.portalAllowed(orgId);
      const { checkPortalPlanGate } = await import("@/lib/portal/plan-gate");
      return (await checkPortalPlanGate(orgId)).allowed;
    },
    async recentMintCount(orgId, contactId, since) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(codes)
        .where(and(eq(codes.orgId, orgId), eq(codes.contactId, contactId), eq(codes.email, WA_LINK_MARKER), sql`${codes.createdAt} > ${since}`));
      return Number(r?.n ?? 0);
    },
    async mint(orgId, contactId, tokenHash, expiresAt) {
      const now = new Date();
      // enable portal access for THIS contact only (the same column the operator toggle writes)
      await db.update(contacts).set({ portalAccessEnabled: true, updatedAt: now }).where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)));
      // only the newest link stays valid
      await db.update(codes).set({ usedAt: now })
        .where(and(eq(codes.orgId, orgId), eq(codes.contactId, contactId), eq(codes.email, WA_LINK_MARKER), isNull(codes.usedAt)));
      await db.insert(codes).values({ orgId, contactId, email: WA_LINK_MARKER, codeHash: tokenHash, expiresAt });
    },
    async orgIdForSlug(slug) {
      const [o] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
      return o?.id ?? null;
    },
    async consume(orgId, tokenHash, now) {
      const rows = await db.update(codes).set({ usedAt: now })
        .where(and(eq(codes.orgId, orgId), eq(codes.codeHash, tokenHash), eq(codes.email, WA_LINK_MARKER), isNull(codes.usedAt), gt(codes.expiresAt, now)))
        .returning({ contactId: codes.contactId });
      return rows.length === 1 ? { contactId: rows[0].contactId } : null;
    },
    async isLinkedContact(orgId, contactId) {
      const [r] = await db.select({ id: externalIdentities.id }).from(externalIdentities)
        .where(and(eq(externalIdentities.orgId, orgId), eq(externalIdentities.provider, PL_PROVIDER), eq(externalIdentities.contactId, contactId))).limit(1);
      return Boolean(r);
    },
    async contactEmail(orgId, contactId) {
      const [c] = await db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId))).limit(1);
      return c?.email ?? null;
    },
  };
}
