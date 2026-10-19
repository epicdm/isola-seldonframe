// Owner-only workspace deletion, billing portal and subscription checkout (Port def-uplink-admin-member-can-delete-workspace-and-open-billing-portal-2026-10-19).
//
// Route/action level against a REAL Postgres through the production driver: the real DELETE /api/v1/workspaces/[id] handler, the real
// createBillingPortalSessionAction server action and the real POST /api/stripe/portal and POST /api/stripe/checkout handlers, with the real identity, org-resolution and
// membership SQL. Only the request context is faked: the NextAuth session (@/auth), the next/headers cookie store, Stripe (SDK + fetch)
// and next/navigation's redirect (which throws). Scratch database only.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND OWNER_GUARD_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.OWNER_GUARD_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const id = (n: number) => `0000${n}`.slice(-4);
const U = (n: number) => `a0000000-0000-4000-8000-00000000${id(n)}`;
const O = (n: number) => `b0000000-0000-4000-8000-00000000${id(n)}`;

const OWNER = U(1), ADMIN = U(2), MEMBER = U(3), OUTSIDER = U(4), AGENCY_OWNER = U(5);
const P_OWNER = O(1), P_ADMIN = O(2), P_MEMBER = O(3), P_OUTSIDER = O(4), P_AGENCY = O(5);
const T_DEL_OWNER = O(10), T_DEL_SHARED = O(11), T_DEL_AGENCY = O(12), T_BILL = O(20);
const AGENCY = "c0000000-0000-4000-8000-000000000001";
const ORG_CUSTOMER = "cus_fixture_org_0001";

const ctx: { userId: string | null; userOrgId: string | null; activeOrg: string | null } = { userId: null, userOrgId: null, activeOrg: null };
const stripeSdkCalls: Array<{ customer: string }> = [];
const stripeFetchCalls: string[] = [];
const stripeCheckoutCalls: Array<{ orgId: string; workspaceId: string }> = [];
const externalFetchCalls: string[] = [];

describe("Owner-only workspace deletion and billing portal", { skip: !enabled && "set OWNER_GUARD_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let DELETE: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
  let portalPOST: () => Promise<Response>;
  let createBillingPortalSessionAction: () => Promise<void>;
  let checkoutPOST: (req: import("next/server").NextRequest) => Promise<Response>;
  let NextRequestCtor: typeof import("next/server").NextRequest;

  const exec = async (q: ReturnType<typeof sql>) => db.execute(q);
  const exists = async (orgId: string) => {
    const r = await exec(sql`select 1 from organizations where id = ${orgId}::uuid`);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []).length === 1;
  };
  const as = (userId: string | null, userOrgId: string | null, activeOrg: string | null) => Object.assign(ctx, { userId, userOrgId, activeOrg });
  const del = (key: string, orgId: string) =>
    DELETE(new Request(`http://local/api/v1/workspaces/${orgId}`, { method: "DELETE", headers: { "x-seldon-api-key": key } }), { params: Promise.resolve({ id: orgId }) });
  const redirectTarget = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      const digest = String((e as { digest?: string }).digest ?? "");
      if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
      throw e;
    }
    return null;
  };

  before(async () => {
    process.env.SELDON_BUILDER_API_KEYS = [`k-owner:${OWNER}`, `k-admin:${ADMIN}`, `k-member:${MEMBER}`, `k-outsider:${OUTSIDER}`, `k-agency:${AGENCY_OWNER}`].join(",");
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "fixture", "0001"].join("_");
    // A real-looking (non-placeholder) price for one sellable tier, so the checkout reaches the guard and, for the owner, the (fake) Stripe call.
    process.env.STRIPE_MANAGED_PRICE_ID = "price_fixture_managed_0001";

    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: {
        auth: async () => (ctx.userId ? { user: { id: ctx.userId, orgId: ctx.userOrgId, email: `${ctx.userId}@fixture.test` } } : null),
        signIn: async () => undefined, signOut: async () => undefined, handlers: {},
      },
    });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: (n: string) => (n === "sf_active_org_id" && ctx.activeOrg ? { name: n, value: ctx.activeOrg } : undefined), getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
        headers: async () => new Headers(),
      },
    });
    class FakeStripe {
      billingPortal = { sessions: { create: async (a: { customer: string }) => { stripeSdkCalls.push({ customer: a.customer }); return { url: "https://billing.fixture.test/session" }; } } };
      checkout = { sessions: { create: async (a: { metadata?: Record<string, string> }) => { stripeCheckoutCalls.push({ orgId: a.metadata?.orgId ?? "", workspaceId: a.metadata?.workspaceId ?? "" }); return { url: "https://checkout.fixture.test/session" }; } } };
    }
    // tsx may load the route through either module system, so mock both resolutions of "stripe" (never reach the network).
    const require = createRequire(path.join(crm, "src/app/api/stripe/portal/route.ts"));
    mock.module("stripe", { defaultExport: FakeStripe });
    mock.module(pathToFileURL(require.resolve("stripe")).href, { defaultExport: FakeStripe });
    // The checkout route gets its client from @seldonframe/payments, which resolves "stripe" from its own package.
    const paymentsStripe = pathToFileURL(createRequire(path.resolve(crm, "../payments/src/stripe-client.ts")).resolve("stripe")).href;
    if (paymentsStripe !== pathToFileURL(require.resolve("stripe")).href) mock.module(paymentsStripe, { defaultExport: FakeStripe });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.stripe.com/")) {
        stripeFetchCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ url: "https://billing.fixture.test/portal" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Only the local database proxy may be reached; any other external call is recorded and refused (never the network).
      const host = new URL(url).hostname;
      if (host === process.env.NEON_LOCAL_HOST || host === "localhost" || host === "127.0.0.1") return realFetch(input as RequestInfo, init);
      externalFetchCalls.push(host);
      return new Response("blocked by test", { status: 503 });
    }) as typeof fetch;

    ({ db } = await import("@/db"));
    ({ DELETE } = await import("@/app/api/v1/workspaces/[id]/route"));
    ({ POST: portalPOST } = await import("@/app/api/stripe/portal/route"));
    ({ createBillingPortalSessionAction } = await import("@/lib/billing/actions"));
    ({ POST: checkoutPOST } = await import("@/app/api/stripe/checkout/route"));
    ({ NextRequest: NextRequestCtor } = await import("next/server"));

    // Fixture rows (scratch database built from the drizzle schema export).
    for (const [u, p] of [[OWNER, P_OWNER], [ADMIN, P_ADMIN], [MEMBER, P_MEMBER], [OUTSIDER, P_OUTSIDER], [AGENCY_OWNER, P_AGENCY]]) {
      await exec(sql`insert into organizations (id, name, slug) values (${p}::uuid, ${"primary " + p.slice(-4)}, ${"primary-" + p.slice(-4)}) on conflict do nothing`);
      await exec(sql`insert into users (id, org_id, name, email, role) values (${u}::uuid, ${p}::uuid, ${"user " + u.slice(-4)}, ${u.slice(-4) + "@fixture.test"}, ${"owner"}) on conflict do nothing`);
    }
    await exec(sql`insert into partner_agencies (id, name, slug, owner_user_id) values (${AGENCY}::uuid, 'Fixture agency', 'fixture-agency', ${AGENCY_OWNER}::uuid) on conflict do nothing`);
    for (const t of [T_DEL_OWNER, T_DEL_SHARED, T_BILL]) {
      await exec(sql`insert into organizations (id, name, slug, owner_id) values (${t}::uuid, ${"ws " + t.slice(-4)}, ${"ws-" + t.slice(-4)}, ${OWNER}::uuid) on conflict do nothing`);
      await exec(sql`insert into org_members (org_id, user_id, role) values (${t}::uuid, ${ADMIN}::uuid, 'admin'), (${t}::uuid, ${MEMBER}::uuid, 'member') on conflict do nothing`);
    }
    await exec(sql`insert into organizations (id, name, slug, parent_agency_id) values (${T_DEL_AGENCY}::uuid, 'ws agency', 'ws-agency', ${AGENCY}::uuid) on conflict do nothing`);
    await exec(sql`insert into org_members (org_id, user_id, role) values (${T_DEL_AGENCY}::uuid, ${ADMIN}::uuid, 'admin') on conflict do nothing`);
    await exec(sql`update organizations set subscription = ${JSON.stringify({ stripeCustomerId: ORG_CUSTOMER })}::jsonb where id = ${T_BILL}::uuid`);
  });

  // ── DELETE /api/v1/workspaces/[id] ──────────────────────────────────────────
  test("delete: an invited ADMIN is refused (403) and the workspace row still exists", async () => {
    const r = await del("k-admin", T_DEL_SHARED);
    assert.equal(r.status, 403);
    assert.match(String((await r.json()).error), /owner/i);
    assert.equal(await exists(T_DEL_SHARED), true);
  });

  test("delete: a MEMBER is refused (403) and the workspace row still exists", async () => {
    const r = await del("k-member", T_DEL_SHARED);
    assert.equal(r.status, 403);
    assert.equal(await exists(T_DEL_SHARED), true);
  });

  test("delete: a NON-MEMBER is refused (404, unchanged behaviour) and the workspace row still exists", async () => {
    const r = await del("k-outsider", T_DEL_SHARED);
    assert.equal(r.status, 404);
    assert.equal(await exists(T_DEL_SHARED), true);
  });

  test("delete: an admin of an AGENCY-attached workspace is refused; the agency owner is allowed (positive control)", async () => {
    const refused = await del("k-admin", T_DEL_AGENCY);
    assert.equal(refused.status, 403);
    assert.equal(await exists(T_DEL_AGENCY), true);
    const ok = await del("k-agency", T_DEL_AGENCY);
    assert.equal(ok.status, 200);
    assert.equal(await exists(T_DEL_AGENCY), false);
  });

  test("delete: the OWNER is allowed (positive control) and the row is gone", async () => {
    const r = await del("k-owner", T_DEL_OWNER);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "deleted");
    assert.equal(await exists(T_DEL_OWNER), false);
  });

  // ── createBillingPortalSessionAction (Settings > Billing "Manage subscription") ──
  test("billing action: the OWNER gets the workspace's Stripe portal (positive control)", async () => {
    stripeFetchCalls.length = 0;
    as(OWNER, P_OWNER, T_BILL);
    const to = await redirectTarget(() => createBillingPortalSessionAction());
    assert.equal(to, "https://billing.fixture.test/portal");
    assert.equal(stripeFetchCalls.length, 1);
    assert.match(stripeFetchCalls[0], new RegExp(`customer=${ORG_CUSTOMER}`));
  });

  for (const [label, u, p] of [["ADMIN", ADMIN, P_ADMIN], ["MEMBER", MEMBER, P_MEMBER], ["NON-MEMBER", OUTSIDER, P_OUTSIDER]] as const) {
    test(`billing action: ${label} never reaches the workspace's Stripe customer`, async () => {
      stripeFetchCalls.length = 0;
      as(u, p, T_BILL);
      const to = await redirectTarget(() => createBillingPortalSessionAction());
      assert.equal(to, "/settings/billing?upgrade=needed");
      assert.equal(stripeFetchCalls.filter((b) => b.includes(ORG_CUSTOMER)).length, 0);
    });
  }

  // ── POST /api/stripe/portal ─────────────────────────────────────────────────
  test("portal route: the OWNER gets a portal session for the workspace customer (positive control)", async () => {
    stripeSdkCalls.length = 0;
    as(OWNER, P_OWNER, T_BILL);
    const r = await portalPOST();
    assert.equal(r.status, 200);
    assert.deepEqual(stripeSdkCalls, [{ customer: ORG_CUSTOMER }]);
  });

  for (const [label, u, p] of [["ADMIN", ADMIN, P_ADMIN], ["MEMBER", MEMBER, P_MEMBER]] as const) {
    test(`portal route: an invited ${label} is refused (403) and Stripe is never called`, async () => {
      stripeSdkCalls.length = 0;
      as(u, p, T_BILL);
      const r = await portalPOST();
      assert.equal(r.status, 403);
      assert.equal(stripeSdkCalls.length, 0);
    });
  }

  test("portal route: a NON-MEMBER never reaches the workspace customer", async () => {
    stripeSdkCalls.length = 0;
    as(OUTSIDER, P_OUTSIDER, T_BILL);
    const r = await portalPOST();
    assert.notEqual(r.status, 200);
    assert.equal(stripeSdkCalls.filter((c) => c.customer === ORG_CUSTOMER).length, 0);
  });
  // ── POST /api/stripe/checkout (subscribe the workspace) ─────────────────────
  const checkout = (body: Record<string, unknown>) =>
    checkoutPOST(new NextRequestCtor("http://local/api/stripe/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("checkout route: the OWNER gets a checkout session stamped with the workspace (positive control)", async () => {
    stripeCheckoutCalls.length = 0;
    as(OWNER, P_OWNER, T_BILL);
    const r = await checkout({ tier: "managed" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).url, "https://checkout.fixture.test/session");
    assert.deepEqual(stripeCheckoutCalls, [{ orgId: T_BILL, workspaceId: T_BILL }]);
  });

  for (const [label, u, p] of [["ADMIN", ADMIN, P_ADMIN], ["MEMBER", MEMBER, P_MEMBER]] as const) {
    test(`checkout route: an invited ${label} is refused (403) and Stripe is never called`, async () => {
      stripeCheckoutCalls.length = 0;
      as(u, p, T_BILL);
      const r = await checkout({ tier: "managed" });
      assert.equal(r.status, 403);
      assert.match(String((await r.json()).error), /owner/i);
      assert.equal(stripeCheckoutCalls.length, 0);
    });
  }

  test("checkout route: naming another workspace in the body is refused (403) even from the caller's own workspace", async () => {
    stripeCheckoutCalls.length = 0;
    as(ADMIN, P_ADMIN, P_ADMIN);
    const r = await checkout({ tier: "managed", workspaceId: T_BILL });
    assert.equal(r.status, 403);
    assert.equal(stripeCheckoutCalls.length, 0);
  });

  test("checkout route: the same user is allowed for a workspace they own (control: the refusal is keyed to the billed workspace)", async () => {
    stripeCheckoutCalls.length = 0;
    as(ADMIN, P_ADMIN, P_ADMIN);
    const r = await checkout({ tier: "managed" });
    assert.equal(r.status, 200);
    assert.deepEqual(stripeCheckoutCalls, [{ orgId: P_ADMIN, workspaceId: P_ADMIN }]);
  });

  test("no call reached api.stripe.com or any other external host", () => {
    assert.equal(stripeFetchCalls.filter((b) => b.includes("checkout")).length, 0);
    assert.deepEqual(externalFetchCalls, []);
  });
});

// Pure rule, no database (always runs, including in the unit suite's environment).
describe("canActAsWorkspaceOwner", () => {
  test("owner-like holders are allowed; admin/member/none are not", async () => {
    const { canActAsWorkspaceOwner } = await import("@/lib/workspace/workspace-owner");
    const base = { userId: "u", ownerId: "x", parentUserId: "y", membershipRole: null as string | null, agencyAttachedToUser: false, primaryWorkspaceOwnerRole: false };
    assert.equal(canActAsWorkspaceOwner({ ...base, ownerId: "u" }), true);
    assert.equal(canActAsWorkspaceOwner({ ...base, parentUserId: "u" }), true);
    assert.equal(canActAsWorkspaceOwner({ ...base, membershipRole: "owner" }), true);
    assert.equal(canActAsWorkspaceOwner({ ...base, agencyAttachedToUser: true }), true);
    assert.equal(canActAsWorkspaceOwner({ ...base, primaryWorkspaceOwnerRole: true }), true);
    assert.equal(canActAsWorkspaceOwner({ ...base, membershipRole: "admin" }), false);
    assert.equal(canActAsWorkspaceOwner({ ...base, membershipRole: "member" }), false);
    assert.equal(canActAsWorkspaceOwner(base), false);
    assert.equal(canActAsWorkspaceOwner({ ...base, userId: null, ownerId: null }), false);
  });
});
