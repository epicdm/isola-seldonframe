// Stripe Connect callback must not bind a Stripe account to a workspace named by an unsigned state
// (Port def-uplink-stripe-connect-callback-unsigned-state-workspace-hijack-2026-10-21).
//
// Route level against a REAL Postgres through the production driver: the real startStripeConnectAction server action
// (mints the state) and the real GET /api/stripe/connect/callback handler, with the real identity, org-resolution and
// membership SQL and the real stripe_connections insert. Only the request context is faked: the NextAuth session (@/auth),
// the next/headers cookie store (which also records what the action sets), next/navigation's redirect (which throws), and
// fetch to connect.stripe.com (the token exchange: recorded, never the network). Scratch database only.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND STRIPE_CONNECT_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, beforeEach, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.STRIPE_CONNECT_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const ATTACKER = "a0000000-0000-4000-8000-000000000a01";
const VICTIM = "a0000000-0000-4000-8000-000000000b01";
const MEMBER = "a0000000-0000-4000-8000-000000000c01"; // second member of the attacker's workspace
const ORG_ATTACKER = "b0000000-0000-4000-8000-000000000a01";
const ORG_VICTIM = "b0000000-0000-4000-8000-000000000b01";
const ORG_SECOND = "b0000000-0000-4000-8000-000000000a02"; // a second workspace the attacker legitimately belongs to
const COOKIE = "sf_stripe_connect";
const SECRET = ["fixture", "signing", "secret", "NOT", "REAL", "0001"].join("-");

const ctx: { userId: string | null; userOrgId: string | null; activeOrg: string | null; host: string | null } = { userId: null, userOrgId: null, activeOrg: null, host: null };
const setCookies: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
const exchangeCalls: string[] = [];
const externalFetchCalls: string[] = [];
let exchangeFails = false;

describe("Stripe Connect callback: signed state, bound to the session that started it", { skip: !enabled && "set STRIPE_CONNECT_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let GET: (req: import("next/server").NextRequest) => Promise<Response>;
  let startStripeConnectAction: () => Promise<void>;
  let NextRequestCtor: typeof import("next/server").NextRequest;

  const exec = async (q: ReturnType<typeof sql>) => db.execute(q);
  const rowsOf = (r: unknown) => ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as Array<Record<string, unknown>>;
  const connections = async (orgId: string) =>
    rowsOf(await exec(sql`select org_id, stripe_account_id from stripe_connections where org_id = ${orgId}::uuid`));
  const totalConnections = async () =>
    Number(rowsOf(await exec(sql`select count(*)::int as n from stripe_connections where org_id in (${ORG_ATTACKER}::uuid, ${ORG_VICTIM}::uuid, ${ORG_SECOND}::uuid)`))[0].n);
  const as = (userId: string | null, userOrgId: string | null, activeOrg: string | null) => Object.assign(ctx, { userId, userOrgId, activeOrg });

  const callback = (query: Record<string, string>, cookie?: string) => {
    const u = new URL("http://local/api/stripe/connect/callback");
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return GET(new NextRequestCtor(u, { headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {} }));
  };
  const outcome = (r: Response) => new URL(r.headers.get("location") ?? "").search;
  const clearsCookie = (r: Response) => /sf_stripe_connect=;/.test(r.headers.get("set-cookie") ?? "") && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(r.headers.get("set-cookie") ?? "");

  /** Drive the real start action as the current session; returns the state Stripe would echo back and the cookie the browser holds. */
  const start = async (): Promise<{ state: string; cookie: string | undefined }> => {
    setCookies.length = 0;
    let target: string | null = null;
    try { await startStripeConnectAction(); } catch (e) {
      const digest = String((e as { digest?: string }).digest ?? "");
      if (!digest.startsWith("NEXT_REDIRECT")) throw e;
      target = digest.split(";")[2];
    }
    assert.ok(target, "start action redirects to Stripe");
    const authorize = new URL(target!);
    assert.equal(authorize.hostname, "connect.stripe.com");
    const state = authorize.searchParams.get("state");
    assert.ok(state, "authorize URL carries a state");
    return { state: state!, cookie: setCookies.find((c) => c.name === COOKIE)?.value };
  };

  /** A signed cookie made with the server's own construction — models a cookie the server minted earlier. */
  const signedCookie = async (p: { nonce: string; orgId: string; userId: string; exp: number }, secret = SECRET) => {
    const { signStripeConnectState } = await import("@/lib/payments/stripe-connect-state");
    return signStripeConnectState({ v: 1, ...p }, secret);
  };

  before(async () => {
    process.env.AUTH_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "fixture", "0001"].join("_");
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_fixture_0001";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.fixture.test";

    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: {
        auth: async () => (ctx.userId ? { user: { id: ctx.userId, orgId: ctx.userOrgId, email: `${ctx.userId.slice(-4)}@fixture.test` } } : null),
        signIn: async () => undefined, signOut: async () => undefined, handlers: {},
      },
    });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({
          get: (n: string) => (n === "sf_active_org_id" && ctx.activeOrg ? { name: n, value: ctx.activeOrg } : undefined),
          getAll: () => [], has: () => false,
          set: (name: string, value: string, opts: Record<string, unknown> = {}) => { setCookies.push({ name, value, opts }); },
          delete: () => undefined,
        }),
        headers: async () => new Headers(ctx.host ? { host: ctx.host } : {}),
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://connect.stripe.com/oauth/token") {
        const code = new URLSearchParams(String(init?.body ?? "")).get("code") ?? "";
        exchangeCalls.push(code);
        if (exchangeFails) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ stripe_user_id: `acct_fixture_${code}`, access_token: "fixture-access-NOT-REAL", stripe_publishable_key: "pk_test_fixture" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const host = new URL(url).hostname;
      if (host === process.env.NEON_LOCAL_HOST || host === "localhost" || host === "127.0.0.1") return realFetch(input as RequestInfo, init);
      externalFetchCalls.push(host);
      return new Response("blocked by test", { status: 503 });
    }) as typeof fetch;

    ({ db } = await import("@/db"));
    ({ GET } = await import("@/app/api/stripe/connect/callback/route"));
    ({ startStripeConnectAction } = await import("@/lib/payments/actions"));
    ({ NextRequest: NextRequestCtor } = await import("next/server"));

    for (const [u, o] of [[ATTACKER, ORG_ATTACKER], [VICTIM, ORG_VICTIM], [MEMBER, ORG_ATTACKER]]) {
      if (u !== MEMBER) await exec(sql`insert into organizations (id, name, slug) values (${o}::uuid, ${"ws " + o.slice(-4)}, ${"ws-" + o.slice(-4)}) on conflict do nothing`);
      await exec(sql`insert into users (id, org_id, name, email, role) values (${u}::uuid, ${o}::uuid, ${"user " + u.slice(-4)}, ${u.slice(-4) + "@fixture.test"}, 'owner') on conflict do nothing`);
    }
    await exec(sql`insert into organizations (id, name, slug, owner_id) values (${ORG_SECOND}::uuid, 'ws second', 'ws-second', ${ATTACKER}::uuid) on conflict do nothing`);
    await exec(sql`insert into org_members (org_id, user_id, role) values (${ORG_ATTACKER}::uuid, ${MEMBER}::uuid, 'admin') on conflict do nothing`);
  });

  beforeEach(async () => {
    // Scratch database; only the fixture workspaces' rows are cleared between cases.
    await exec(sql`delete from stripe_connections where org_id in (${ORG_ATTACKER}::uuid, ${ORG_VICTIM}::uuid, ${ORG_SECOND}::uuid)`);
    exchangeCalls.length = 0;
    exchangeFails = false;
    as(null, null, null);
    ctx.host = null;
  });

  test("control: the fixture ids under test are genuinely distinct (user vs org, attacker vs victim)", () => {
    assert.equal(new Set([ATTACKER, VICTIM, MEMBER, ORG_ATTACKER, ORG_VICTIM, ORG_SECOND]).size, 6);
  });

  test("POSITIVE CONTROL: a legitimate start → callback in the same session writes exactly one row for that workspace", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    const r = await callback({ code: "legit1", state }, cookie);
    assert.equal(outcome(r), "?connected=1");
    assert.deepEqual(exchangeCalls, ["legit1"]);
    assert.deepEqual(await connections(ORG_ATTACKER), [{ org_id: ORG_ATTACKER, stripe_account_id: "acct_fixture_legit1" }]);
    assert.equal(await totalConnections(), 1);
    assert.equal(clearsCookie(r), true, "the state cookie is consumed");
  });

  test("the state sent to Stripe names no workspace, and the minted cookie is httpOnly + secure + lax with a 10-minute life", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state } = await start();
    assert.ok(!state.includes(ORG_ATTACKER) && !state.includes(":"), `state is an opaque nonce: ${state}`);
    const c = setCookies.find((x) => x.name === COOKIE);
    assert.ok(c, "state cookie set");
    assert.equal(c!.opts.httpOnly, true);
    assert.equal(c!.opts.secure, true);
    assert.equal(c!.opts.sameSite, "lax");
    assert.equal(c!.opts.maxAge, 600);
  });

  test("FORGED unsigned state naming the victim's workspace is refused: no exchange, no stripe_connections row", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const r = await callback({ code: "attack1", state: `${ORG_VICTIM}:${Date.now()}` });
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("FORGED: the attacker's own valid cookie with its payload re-pointed at the victim's workspace is refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    const [p, sig] = cookie!.split(".");
    const json = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const swapped = Buffer.from(JSON.stringify({ ...json, orgId: ORG_VICTIM })).toString("base64url");
    const r = await callback({ code: "attack2", state }, `${swapped}.${sig}`);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("FORGED: a cookie signed with any other secret is refused", async () => {
    as(ATTACKER, ORG_VICTIM, null);
    const nonce = "n".repeat(43);
    const r = await callback({ code: "attack3", state: nonce }, await signedCookie({ nonce, orgId: ORG_VICTIM, userId: ATTACKER, exp: Date.now() + 60_000 }, "some-other-secret"));
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("a valid cookie whose nonce differs from the callback's state is refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { cookie } = await start();
    const r = await callback({ code: "x1", state: "m".repeat(43) }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("an EXPIRED state is refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const nonce = "e".repeat(43);
    const r = await callback({ code: "exp1", state: nonce }, await signedCookie({ nonce, orgId: ORG_ATTACKER, userId: ATTACKER, exp: Date.now() - 1 }));
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
    // control: the same construction, unexpired, is accepted — the refusal above was the expiry, not the construction
    const ok = await callback({ code: "exp2", state: nonce }, await signedCookie({ nonce, orgId: ORG_ATTACKER, userId: ATTACKER, exp: Date.now() + 60_000 }));
    assert.equal(outcome(ok), "?connected=1");
    assert.equal(await totalConnections(), 1);
  });

  test("a REUSED state is refused: the first callback consumes the cookie, a replay of the same callback URL writes nothing", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    const first = await callback({ code: "once1", state }, cookie);
    assert.equal(outcome(first), "?connected=1");
    assert.equal(clearsCookie(first), true);
    // The browser applied the deletion, so the replay arrives with no state cookie.
    const replay = await callback({ code: "once2", state });
    assert.equal(outcome(replay), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, ["once1"]);
    assert.equal(await totalConnections(), 1);
  });

  test("a refused callback also consumes the cookie", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { cookie } = await start();
    const r = await callback({ code: "y1", state: "m".repeat(43) }, cookie);
    assert.equal(clearsCookie(r), true);
  });

  test("SESSION ORG MISMATCH: started in workspace A, callback arrives while the same user is active in workspace B → refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    as(ATTACKER, ORG_ATTACKER, ORG_SECOND); // same user, switched active workspace (a real membership)
    const r = await callback({ code: "org1", state }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("SESSION USER MISMATCH: same workspace, different signed-in user (the other member) → refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    as(MEMBER, ORG_ATTACKER, null); // org matches, user does not
    const r = await callback({ code: "usr1", state }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("the attacker's whole callback (code + state + cookie) replayed in the VICTIM's session is refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    as(VICTIM, ORG_VICTIM, null);
    const r = await callback({ code: "csrf1", state }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("NO SESSION: a valid state and cookie with nobody signed in → refused", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    as(null, null, null);
    const r = await callback({ code: "anon1", state }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, []);
    assert.equal(await totalConnections(), 0);
  });

  test("START ON ANOTHER HOST: the user is sent to /settings/payments on the callback host and no state is minted", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    ctx.host = "other-app-host.fixture.test";
    setCookies.length = 0;
    let target: string | null = null;
    try { await startStripeConnectAction(); } catch (e) {
      const digest = String((e as { digest?: string }).digest ?? "");
      if (!digest.startsWith("NEXT_REDIRECT")) throw e;
      target = digest.split(";")[2];
    }
    assert.equal(target, "https://app.fixture.test/settings/payments");
    assert.equal(setCookies.filter((c) => c.name === COOKIE).length, 0);
    // control: the same start on the callback host proceeds to Stripe and mints the cookie
    ctx.host = "app.fixture.test";
    const { cookie } = await start();
    assert.ok(cookie, "state cookie minted on the callback host");
  });

  test("EMPTY SECRET: with no AUTH_SECRET/NEXTAUTH_SECRET the callback refuses even a cookie signed earlier, and start refuses to mint", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const nonce = "s".repeat(43);
    const cookie = await signedCookie({ nonce, orgId: ORG_ATTACKER, userId: ATTACKER, exp: Date.now() + 60_000 });
    const saved = { a: process.env.AUTH_SECRET, n: process.env.NEXTAUTH_SECRET };
    delete process.env.AUTH_SECRET; delete process.env.NEXTAUTH_SECRET;
    try {
      const r = await callback({ code: "nosec1", state: nonce }, cookie);
      assert.equal(outcome(r), "?error=connect_failed");
      assert.deepEqual(exchangeCalls, []);
      await assert.rejects(() => startStripeConnectAction(), /secret is not configured/);
    } finally {
      process.env.AUTH_SECRET = saved.a; if (saved.n !== undefined) process.env.NEXTAUTH_SECRET = saved.n;
    }
    assert.equal(await totalConnections(), 0);
  });

  test("EXCHANGE FAILURE: Stripe rejects the code → connect_failed and no row", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const { state, cookie } = await start();
    exchangeFails = true;
    const r = await callback({ code: "bad1", state }, cookie);
    assert.equal(outcome(r), "?error=connect_failed");
    assert.deepEqual(exchangeCalls, ["bad1"]);
    assert.equal(await totalConnections(), 0);
  });

  test("missing code or state keeps its existing redirect and calls nothing", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const r = await callback({ state: "abc" });
    assert.equal(outcome(r), "?error=connect_callback");
    assert.deepEqual(exchangeCalls, []);
  });

  // ── /settings/payments (Law 26): never offer a Connect button that can only fail ──
  const renderPaymentsPage = async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Page } = await import("@/app/(dashboard)/settings/payments/page");
    return renderToStaticMarkup(await Page());
  };
  const NOT_AVAILABLE = "Stripe connection is temporarily unavailable while we complete a security update. Existing payment methods are not affected.";

  test("LAW 26: with no STRIPE_CONNECT_CLIENT_ID, /settings/payments says the Stripe connection is temporarily unavailable and shows no Connect button", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    const saved = process.env.STRIPE_CONNECT_CLIENT_ID;
    delete process.env.STRIPE_CONNECT_CLIENT_ID;
    try {
      const html = await renderPaymentsPage();
      assert.ok(html.includes(NOT_AVAILABLE), "temporary-unavailability notice rendered");
      assert.ok(!/not available for this workspace/i.test(html), "never reads as permanently unsupported");
      assert.ok(!html.includes("Connect Stripe"), "no Connect Stripe button");
      assert.ok(!/<form/i.test(html), "no form that would call the start action");
    } finally {
      process.env.STRIPE_CONNECT_CLIENT_ID = saved;
    }
  });

  test("LAW 26 control: with STRIPE_CONNECT_CLIENT_ID set, the page shows the Connect button and no not-available notice", async () => {
    as(ATTACKER, ORG_ATTACKER, null);
    assert.ok(process.env.STRIPE_CONNECT_CLIENT_ID, "control precondition: client id set");
    const html = await renderPaymentsPage();
    assert.ok(html.includes("Connect Stripe"), "Connect Stripe button rendered");
    assert.ok(!html.includes(NOT_AVAILABLE));
  });

  test("no external host other than the stubbed Stripe token endpoint was contacted", () => {
    assert.deepEqual(externalFetchCalls, []);
  });
});
