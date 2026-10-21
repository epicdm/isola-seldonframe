// Staff access correction (Port def-uplink-staff-access-admin-only-invite-and-no-session-revocation-2026-10-21; plan v1.47),
// against a REAL Postgres through the production driver (DB_DRIVER=pg). The PATH, not the pieces: the real server actions,
// the real route handlers, the real session resolution (operator-portal magic-link cookie AND NextAuth) and the real
// membership SQL. Only the request context is faked: the NextAuth session (@/auth), the next/headers cookie store,
// next/cache, and fetch (no external host is ever reached; the MCP bridge call is captured in-process).
//
// What it proves:
//   1. COMPLETENESS — every export of every module-level "use server" file and every session-authenticated route file is
//      classified in lib/auth/staff-access-policy.ts (enumerated from SOURCE; a new unclassified action fails here).
//   2. Every "admin" action and route is REFUSED to a staff member (both realms) with the role guard's own refusal, and is
//      NOT refused by it for the owner or an admin (positive controls in the same run).
//   3. Every "staff" action runs for a staff member (not refused by the guard).
//   4. Removal ends an existing session on the NEXT request (magic-link cookie and NextAuth); a role downgrade applies at
//      once; re-upgrade restores (control).
//   5. Law 20 multi-gate: magic-link consumption and the per-request session gate admit exactly the same role set, keyed on
//      the same field (org_members.role), with a control proving users.role and org_members.role really differ.
//   6. Invite grants staff by default; the Team list is complete; only the owner manages members.
//   7. ask_employee: X-Staff-Id comes only from the session, only to the bridge connector, refused without a staff session,
//      after removal, or with the permission off; tool-argument spoofing has no effect.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND STAFF_ACCESS_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.STAFF_ACCESS_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const pad = (n: number) => `0000${n}`.slice(-4);
const U = (n: number) => `a2000000-0000-4000-8000-00000000${pad(n)}`;
const O = (n: number) => `b2000000-0000-4000-8000-00000000${pad(n)}`;

const OWNER = U(1), ADMIN = U(2), STAFF = U(3), STAFF2 = U(4), REMOVABLE = U(5), DOWNGRADE = U(6), OUTSIDER = U(7), ROLEPROBE = U(8);
const DUAL = U(9), PARENT = U(10), HOMEOWNER = U(11);
const W = O(1), OWNER_HOME = O(2), OUT_HOME = O(3), DUAL_A = O(4), PARENT_HOME = O(5);
const OAUTH_CLIENT = "staff-access-fixture-client", OAUTH_REDIRECT = "https://client.fixture.test/cb";
const SLUG = "staff-access-fixture";
const email = (u: string) => `u${u.slice(-4)}@staff.fixture.test`;
const ASK_SERVICE = "ask-employee-fixture";

type Session = { user: { id: string; email: string; orgId: string | null } } | null;
const ctx: { session: Session; cookies: Map<string, string>; noRequest?: boolean } = { session: null, cookies: new Map() };
const externalFetchCalls: string[] = [];

const ROLE_REFUSAL = "workspace_role_forbidden";
const isRoleRefusal = (e: unknown) => (e as { code?: unknown } | null)?.code === ROLE_REFUSAL;

describe("Staff access (scratch Postgres, production driver)", { skip: !enabled && "set STAFF_ACCESS_DB_TEST=scratch with a scratch database" }, () => {
  const crm = path.resolve(".");
  let db: typeof import("@/db").db;
  let policy: typeof import("@/lib/auth/staff-access-policy");
  let S: typeof import("@/lib/operator-portal/session");
  let OP: typeof import("@/lib/operator-portal/auth");
  let helpers: typeof import("@/lib/auth/helpers");
  let RW: typeof import("@/lib/auth/require-workspace-role");
  let opCtx: typeof import("@/lib/auth/operator-portal-context");
  let V1: typeof import("@/lib/auth/v1-identity");
  let NextRequestCtor: typeof import("next/server").NextRequest;

  const rows = async <R>(q: ReturnType<typeof sql>): Promise<R[]> => {
    const r = await db.execute(q);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as R[];
  };
  const memberRole = async (u: string) => (await rows<{ role: string }>(sql`select role from org_members where org_id = ${W}::uuid and user_id = ${u}::uuid`))[0]?.role ?? null;

  // ── request contexts ──────────────────────────────────────────────────────
  const asNextAuth = (u: string | null, home: string | null = W, active: string | null = null) => {
    ctx.cookies.clear();
    ctx.session = u ? { user: { id: u, email: email(u), orgId: home } } : null;
    if (active) ctx.cookies.set("sf_active_org_id", active);
  };
  const operatorToken = (u: string, orgId = W) => {
    const iat = Date.now() - 1000;
    return S.signOperatorToken({ orgId, email: email(u), kind: "session", iat, exp: iat + 7 * 24 * 3600 * 1000 });
  };
  const asOperator = (u: string) => {
    ctx.session = null;
    ctx.cookies.clear();
    ctx.cookies.set("sf_operator_session", operatorToken(u));
  };
  const asOperatorToken = (token: string) => {
    ctx.session = null;
    ctx.cookies.clear();
    ctx.cookies.set("sf_operator_session", token);
  };

  /** Runs fn; "refused" when it rejected with the role guard's refusal, else "ran" (resolved, other error, or still busy after 8 s). */
  const outcome = async (fn: () => Promise<unknown>): Promise<"refused" | "ran"> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([fn(), new Promise((resolve) => { timer = setTimeout(resolve, 8000); })]);
      return "ran";
    } catch (e) {
      return isRoleRefusal(e) ? "refused" : "ran";
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const loadExport = async (key: string) => {
    const [file, name] = key.split("#");
    const mod = (await import(pathToFileURL(path.join(crm, "src", file)).href)) as Record<string, unknown>;
    const fn = mod[name];
    assert.equal(typeof fn, "function", `${key} is not an exported function`);
    return fn as (...args: unknown[]) => Promise<unknown>;
  };
  const callAction = (fn: (...args: unknown[]) => Promise<unknown>) => () => fn({}, new FormData());

  before(async () => {
    process.env.AUTH_SECRET = ["fixture", "staff", "access", "secret"].join("-");
    process.env.NEXT_PUBLIC_APP_URL = "http://app.fixture.test";
    process.env.SF_SUPERADMIN_EMAILS = "ops@platform.fixture.test";
    process.env.UPLINK_ASK_EMPLOYEE_SERVICE = ASK_SERVICE;
    process.env.SF_OAUTH_ENABLED = "true";
    for (const k of ["SMTP2GO_API_KEY", "RESEND_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "TWILIO_AUTH_TOKEN"]) delete process.env[k];

    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => ctx.session, signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({
          get: (n: string) => (ctx.cookies.has(n) ? { name: n, value: ctx.cookies.get(n)! } : undefined),
          getAll: () => [...ctx.cookies].map(([name, value]) => ({ name, value })),
          has: (n: string) => ctx.cookies.has(n),
          set: (n: string, v: string) => { if (v) ctx.cookies.set(n, v); else ctx.cookies.delete(n); },
          delete: (n: string) => ctx.cookies.delete(n),
        }),
        headers: async () => { if (ctx.noRequest) throw Object.assign(new Error("`headers` was called outside a request scope."), { __NEXT_ERROR_CODE: "E251" }); return new Headers(); },
      },
    });
    mock.module("next/cache", {
      namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (f: unknown) => f, unstable_noStore: () => undefined },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const host = new URL(url).hostname;
      if (host === process.env.NEON_LOCAL_HOST || host === "localhost" || host === "127.0.0.1") return realFetch(input as RequestInfo, init);
      externalFetchCalls.push(host);
      return new Response("blocked by test", { status: 503 });
    }) as typeof fetch;

    ({ db } = await import("@/db"));
    policy = await import("@/lib/auth/staff-access-policy");
    S = await import("@/lib/operator-portal/session");
    OP = await import("@/lib/operator-portal/auth");
    helpers = await import("@/lib/auth/helpers");
    // Tolerant import: on the BASE tree (RED run) this module does not exist; tests that need it then fail individually
    // instead of the whole suite failing to load, so the sweeps still measure the base.
    RW = (await import("@/lib/auth/require-workspace-role").catch(() => ({}))) as typeof RW;
    opCtx = await import("@/lib/auth/operator-portal-context");
    V1 = await import("@/lib/auth/v1-identity");
    ({ NextRequest: NextRequestCtor } = await import("next/server"));

    // Fixture: workspace W owned by OWNER, whose HOME is another workspace (so a home-only Team list misses the owner).
    for (const [o, slug] of [[W, SLUG], [OWNER_HOME, "staff-owner-home"], [OUT_HOME, "staff-outsider-home"], [DUAL_A, "staff-dual-own"], [PARENT_HOME, "staff-parent-home"]] as const) {
      await db.execute(sql`insert into organizations (id, name, slug) values (${o}::uuid, ${"ws " + slug}, ${slug}) on conflict do nothing`);
    }
    const people: Array<[string, string, string]> = [
      [OWNER, OWNER_HOME, "owner"], [ADMIN, W, "member"], [STAFF, W, "member"], [STAFF2, W, "member"],
      [REMOVABLE, W, "member"], [DOWNGRADE, W, "member"], [OUTSIDER, OUT_HOME, "owner"], [ROLEPROBE, W, "member"],
      // DUAL: an invited STAFF member of W (home W) who also OWNS another workspace DUAL_A (the Codex r1 cross-target case).
      // PARENT: W's creating operator (parent_user_id). HOMEOWNER: a legacy home owner of W (users.role 'owner', no row).
      [DUAL, W, "member"], [PARENT, PARENT_HOME, "owner"], [HOMEOWNER, W, "owner"],
    ];
    for (const [u, home, role] of people) {
      await db.execute(sql`insert into users (id, org_id, name, email, role) values (${u}::uuid, ${home}::uuid, ${"user " + u.slice(-4)}, ${email(u)}, ${role}) on conflict do nothing`);
    }
    await db.execute(sql`update organizations set owner_id = ${OWNER}::uuid where id in (${W}::uuid, ${OWNER_HOME}::uuid)`);
    await db.execute(sql`update organizations set owner_id = ${OUTSIDER}::uuid where id = ${OUT_HOME}::uuid`);
    await db.execute(sql`update organizations set owner_id = ${DUAL}::uuid where id = ${DUAL_A}::uuid`);
    // Workspace creation also records the owner membership (lib/billing/orgs.ts); the OAuth picker lists memberships.
    await db.execute(sql`insert into org_members (org_id, user_id, role) values (${DUAL_A}::uuid, ${DUAL}::uuid, 'owner') on conflict do nothing`);
    await db.execute(sql`update organizations set owner_id = ${PARENT}::uuid where id = ${PARENT_HOME}::uuid`);
    await db.execute(sql`update organizations set parent_user_id = ${PARENT}::uuid where id = ${W}::uuid`);
    await db.execute(sql`insert into oauth_clients (client_id, client_name, redirect_uris) values (${OAUTH_CLIENT}, 'fixture', ${JSON.stringify([OAUTH_REDIRECT])}::jsonb) on conflict do nothing`);
    for (const [u, role] of [[OWNER, "owner"], [ADMIN, "admin"], [STAFF, "staff"], [STAFF2, "staff"], [REMOVABLE, "staff"], [DOWNGRADE, "admin"], [DUAL, "staff"]] as const) {
      await db.execute(sql`insert into org_members (org_id, user_id, role) values (${W}::uuid, ${u}::uuid, ${role}) on conflict do nothing`);
    }
  });

  // ── 1. completeness ─────────────────────────────────────────────────────────
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name) ? [p] : [];
    });
  const src = () => path.join(crm, "src");
  const rel = (p: string) => path.relative(src(), p).split(path.sep).join("/");

  test("completeness: every module-level 'use server' export is classified, and every classified export exists", () => {
    const found = new Set<string>();
    for (const p of walk(src())) {
      const text = fs.readFileSync(p, "utf8");
      const first = text.replace(/^﻿/, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
      if (!first || !/^["']use server["'];?$/.test(first)) continue;
      for (const m of text.matchAll(/^export\s+async\s+function\s+(\w+)/gm)) found.add(`${rel(p)}#${m[1]}`);
    }
    // Control: the enumeration really sees files (a broken walk would make both sets small and "equal").
    assert.ok(found.size > 300, `enumerated only ${found.size} exports`);
    assert.ok(found.has("lib/workspace/actions.ts#mintApiKeyAction"), "control: a known admin action is enumerated");
    // Codex r1: server helpers that take a workspace id as an argument are no longer client-callable server actions.
    for (const gone of ["lib/agents/store.ts#updateAgentBlueprint", "lib/agents/store.ts#publishAgent", "lib/payments/actions.ts#handleStripeCheckoutCompleted",
      "lib/seldon/block-installer.ts#installBlock", "lib/soul/install.ts#installSoul", "lib/marketplace/seller-actions.ts#resolvePublishGuard",
      "lib/emails/actions.ts#sendWelcomeEmailForContact", "lib/agents/eval-runner.ts#runEvalSuite",
      "lib/landing/lead-form-action.ts#submitLeadFormWithDeps", "lib/ai/export-workspace-as-agent.ts#exportWorkspaceAsAgentForWorkspace"]) {
      assert.equal(found.has(gone), false, `${gone} must not be a "use server" export`);
    }
    const declared = new Set(Object.keys(policy.SERVER_ACTION_POLICY));
    assert.deepEqual([...found].filter((k) => !declared.has(k)).sort(), [], "unclassified server actions");
    assert.deepEqual([...declared].filter((k) => !found.has(k)).sort(), [], "policy entries with no such export");
  });

  test("completeness: every session-authenticated route file is classified", () => {
    const sessionRe = /getOrgId\(|requireAuth\(|getCurrentUser\(|await auth\(\)|resolveOperatorPortalContext|getCurrentWorkspaceRole|requireOperatorSession|getOperatorSessionForOrg/;
    const found = walk(path.join(src(), "app/api")).filter((p) => p.endsWith("route.ts") && sessionRe.test(fs.readFileSync(p, "utf8"))).map(rel);
    assert.ok(found.length >= 30, `control: enumerated ${found.length} route files`);
    const declared = new Set(Object.keys(policy.SESSION_ROUTE_POLICY));
    assert.deepEqual(found.filter((k) => !declared.has(k)).sort(), [], "unclassified session routes");
  });

  // ── 2 + 3. actions ──────────────────────────────────────────────────────────
  const byCategory = (c: string) => Object.entries(policy.SERVER_ACTION_POLICY).filter(([, v]) => v === c).map(([k]) => k).sort();

  test("role resolution (positive controls): owner, admin and staff resolve as such in both realms", async () => {
    for (const [u, want] of [[OWNER, "owner"], [ADMIN, "admin"], [STAFF, "staff"]] as const) {
      asOperator(u);
      assert.equal(await helpers.getCurrentWorkspaceRole(), want, `operator ${want}`);
      asNextAuth(u, u === OWNER ? OWNER_HOME : W, W);
      assert.equal(await helpers.getCurrentWorkspaceRole(), want, `nextauth ${want}`);
    }
  });

  for (const realm of ["operator", "nextauth"] as const) {
    test(`admin actions: a STAFF member (${realm}) is refused by the role guard on every one`, async () => {
      const keys = byCategory("admin");
      assert.ok(keys.length >= 150, "control: the admin list is the full list");
      const reached: string[] = [];
      for (const key of keys) {
        const fn = await loadExport(key);
        if (realm === "operator") asOperator(STAFF); else asNextAuth(STAFF, W);
        if ((await outcome(callAction(fn))) !== "refused") reached.push(key);
      }
      assert.deepEqual(reached, [], `admin actions reachable as staff (${realm})`);
    });
  }

  test("admin actions (positive control): never refused by the role guard for the OWNER or an ADMIN", async () => {
    const refused: string[] = [];
    for (const key of byCategory("admin")) {
      const fn = await loadExport(key);
      for (const u of [OWNER, ADMIN]) {
        asOperator(u);
        if ((await outcome(callAction(fn))) === "refused") refused.push(`${key} as ${u === OWNER ? "owner" : "admin"}`);
      }
    }
    assert.deepEqual(refused, []);
  });

  test("staff actions: legitimate work is never refused by the role guard for a STAFF member", async () => {
    const keys = byCategory("staff");
    assert.ok(keys.includes("lib/contacts/actions.ts#createContactAction") && keys.includes("lib/bookings/actions.ts#listBookings"));
    const refused: string[] = [];
    for (const key of keys) {
      const fn = await loadExport(key);
      asOperator(STAFF);
      if ((await outcome(callAction(fn))) === "refused") refused.push(key);
    }
    assert.deepEqual(refused, []);
  });

  test("staff work really works (not just 'not refused'): a staff member creates and lists a contact in their workspace", async () => {
    const { createContactAction, listContacts } = await import("@/lib/contacts/actions");
    asOperator(STAFF);
    const fd = new FormData();
    fd.set("firstName", "Staffcreated");
    fd.set("lastName", "Contact");
    fd.set("email", "created.by.staff@fixture.test");
    await createContactAction(fd).catch((e: unknown) => { if (isRoleRefusal(e)) throw e; });
    const listed = (await listContacts()) as Array<{ firstName?: string; orgId?: string }>;
    const mine = await rows<{ org_id: string }>(sql`select org_id from contacts where email = 'created.by.staff@fixture.test'`);
    assert.equal(mine.length, 1, "the contact row exists");
    assert.equal(mine[0].org_id, W, "in the staff member's workspace");
    assert.ok(listed.some((c) => c.firstName === "Staffcreated"), "and the staff member's list shows it");
  });

  test("DI seams: an injected getOrgId is ignored inside a request (staff stays refused); honoured only outside one (control)", async () => {
    const { serverSideDeps } = await import("@/lib/auth/server-side-deps");
    const injected = { getOrgId: async () => W };
    asOperator(STAFF);
    assert.equal(await serverSideDeps(injected), undefined, "inside a request the injected value is discarded");
    ctx.noRequest = true;
    try { assert.equal(await serverSideDeps(injected), injected, "control: outside a request (unit tests) it is honoured"); } finally { ctx.noRequest = false; }
    const { setBookingPolicyAction } = await import("@/lib/deployments/actions");
    const { previewShareCardAction } = await import("@/lib/agent-templates/share-card-actions");
    const { installAgentListingAction } = await import("@/lib/marketplace/actions");
    const forged = { getOrgId: async () => W, getCurrentUser: async () => ({ id: STAFF }) } as never;
    asOperator(STAFF);
    assert.equal(await outcome(() => setBookingPolicyAction({ deploymentId: U(91), policy: {} } as never, forged)), "refused");
    assert.equal(await outcome(() => previewShareCardAction(U(92), forged)), "refused");
    assert.equal(await outcome(() => installAgentListingAction({ slug: "x" } as never, forged)), "refused");
  });

  test("caller-supplied workspace on reads (contacts/deals/bookings): honoured only with a role there", async () => {
    const { listContacts } = await import("@/lib/contacts/actions");
    const { listDeals, getDefaultPipeline } = await import("@/lib/deals/actions");
    const { listBookings } = await import("@/lib/bookings/actions");
    asOperator(STAFF);
    const mine = (await listContacts({ orgId: W } as never)) as Array<{ firstName?: string }>;
    assert.ok(mine.some((c) => c.firstName === "Staffcreated"), "control: a staff member reads their own workspace by id (the contact made earlier)");
    asNextAuth(OUTSIDER, OUT_HOME);
    assert.deepEqual(await listContacts({ orgId: W } as never), [], "an outsider passing W's id reads nothing");
    assert.deepEqual(await listDeals(W), []);
    assert.equal(await getDefaultPipeline(W), null);
    assert.deepEqual(await listBookings(W), []);
  });

  test("customer-portal feedback is not blocked by the builder role guard (end-client mode)", async () => {
    const { recordSeldonFeedbackAction } = await import("@/lib/ai/record-seldon-feedback");
    asNextAuth(null);
    const fd = new FormData();
    fd.set("end_client_mode", "true"); fd.set("orgSlug", SLUG); fd.set("feedbackScore", "1");
    const r = await recordSeldonFeedbackAction(fd).catch((e: unknown) => (isRoleRefusal(e) ? "refused" : "error"));
    assert.notEqual(r, "refused", "end-client mode reaches its own portal-session check");
    asOperator(STAFF);
    const builder = new FormData();
    builder.set("feedbackScore", "1");
    assert.equal(await outcome(() => recordSeldonFeedbackAction(builder)), "refused", "the builder path still needs owner/admin");
  });

  test("Stripe Connect completion re-checks owner/admin of the target workspace (demoted/staff refused; owner proceeds)", async () => {
    // Combined with the Stripe Connect signed-state candidate (641c89b5): the state is a signed, session-bound cookie.
    const { GET } = await import("@/app/api/stripe/connect/callback/route");
    const { signStripeConnectState, newStripeConnectNonce, STRIPE_CONNECT_STATE_COOKIE } = await import("@/lib/payments/stripe-connect-state");
    const payments = (await import("@/lib/payments/actions")) as Record<string, unknown>;
    assert.equal(typeof payments.completeStripeConnectFromCode, "undefined", "the unsigned completion action no longer exists");
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "fixture", "staff"].join("_");
    const callAs = (userId: string) => {
      const nonce = newStripeConnectNonce();
      const signed = signStripeConnectState({ v: 1, nonce, orgId: W, userId, exp: Date.now() + 60_000 }, String(process.env.AUTH_SECRET));
      const qs = new URLSearchParams({ state: nonce });
      qs.set("code", ["fixture", "auth", "grant"].join("-"));
      return GET(new NextRequestCtor(`http://app.fixture.test/api/stripe/connect/callback?${qs.toString()}`, { headers: { cookie: `${STRIPE_CONNECT_STATE_COOKIE}=${signed}` } }));
    };
    const stripeCalls = () => externalFetchCalls.filter((h) => h === "connect.stripe.com").length;
    try {
      // An ADMIN starts the flow, is demoted to staff, then completes it: refused before the token exchange.
      asNextAuth(OWNER, OWNER_HOME);
      assert.deepEqual(await OP.setWorkspaceMemberRoleAction({ orgSlug: SLUG, userId: DOWNGRADE, role: "staff" }), { ok: true });
      const before = stripeCalls();
      asNextAuth(DOWNGRADE, W);
      const demoted = await callAs(DOWNGRADE);
      assert.match(String(demoted.headers.get("location")), /error=connect_failed/);
      assert.equal(stripeCalls(), before, "no token exchange for a demoted member");
      // Control: the OWNER's own signed flow reaches the exchange (blocked in-process; no Stripe account is saved).
      asNextAuth(OWNER, OWNER_HOME, W);
      await callAs(OWNER);
      assert.equal(stripeCalls(), before + 1, "control: the owner reaches the token exchange");
      assert.equal((await rows(sql`select 1 from stripe_connections where org_id = ${W}::uuid`)).length, 0);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      asNextAuth(OWNER, OWNER_HOME);
      await OP.setWorkspaceMemberRoleAction({ orgSlug: SLUG, userId: DOWNGRADE, role: "admin" });
    }
  });

  test("permission changes for two members at once never restore a stale list", async () => {
    asNextAuth(OWNER, OWNER_HOME);
    await OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: ADMIN, enabled: true });
    await Promise.all([
      OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: ADMIN, enabled: false }),
      OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: DOWNGRADE, enabled: true }),
    ]);
    const [g] = await rows<{ ids: string[] }>(sql`select settings #> '{staffAccess,askEmployeeUserIds}' as ids from organizations where id = ${W}::uuid`);
    assert.equal(g.ids.includes(ADMIN), false, "the disable was not undone by the concurrent enable");
    assert.equal(g.ids.includes(DOWNGRADE), true, "control: the concurrent enable landed");
    await OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: DOWNGRADE, enabled: false });
    // Codex r5: an enable racing the member's removal can never leave a grant behind for a later re-invite.
    await db.execute(sql`insert into org_members (org_id, user_id, role) values (${W}::uuid, ${ROLEPROBE}::uuid, 'staff') on conflict do nothing`);
    await Promise.all([
      OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: ROLEPROBE, enabled: true }),
      OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: ROLEPROBE }),
    ]);
    const [h] = await rows<{ ids: string[] | null }>(sql`select settings #> '{staffAccess,askEmployeeUserIds}' as ids from organizations where id = ${W}::uuid`);
    assert.equal((h.ids ?? []).includes(ROLEPROBE), false, "no stale grant survives the removal");
    assert.equal(await memberRole(ROLEPROBE), null, "control: the removal landed");
  });

  // ── routes ─────────────────────────────────────────────────────────────────
  const callRoute = async (file: string, method: string) => {
    const mod = (await import(pathToFileURL(path.join(src(), file)).href)) as Record<string, unknown>;
    const handler = mod[method] as (req: unknown, c: unknown) => Promise<Response>;
    assert.equal(typeof handler, "function", `${file} ${method}`);
    const same = { origin: "http://app.fixture.test", "x-forwarded-host": "app.fixture.test", "sec-fetch-site": "same-origin" };
    const init: RequestInit = method === "GET" ? { method, headers: same } : { method, body: "{}", headers: { "content-type": "application/json", ...same } };
    const req = new NextRequestCtor("http://app.fixture.test/api/x?code=c&state=s", init as never);
    const params = Promise.resolve({ id: W, approvalId: U(99), listingId: U(98), pageId: U(97), runId: U(96) });
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = await Promise.race([handler(req, { params }), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 8000); })]);
      if (!r) return { status: 0, code: "" };
      const body = (await r.clone().json().catch(() => ({}))) as { code?: string; error?: string };
      return { status: r.status, code: body.code ?? body.error ?? "" };
    } catch (e) {
      return { status: -1, code: isRoleRefusal(e) ? ROLE_REFUSAL : "threw" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const adminRoutes = () => Object.entries(policy.SESSION_ROUTE_POLICY).filter(([, v]) => v.category === "admin").flatMap(([f, v]) => v.methods.map((m) => [f, m] as const));

  test("admin routes: a STAFF member is refused (403) on every one, in both realms", async () => {
    const reached: string[] = [];
    for (const [file, method] of adminRoutes()) {
      for (const realm of ["operator", "nextauth"] as const) {
        if (realm === "operator") asOperator(STAFF); else asNextAuth(STAFF, W);
        const r = await callRoute(file, method);
        if (r.status !== 403) reached.push(`${method} ${file} (${realm}) -> ${r.status} ${r.code}`);
      }
    }
    assert.deepEqual(reached, []);
  });

  test("admin routes (positive control): the OWNER (app sign-in) is never refused: no 401/403 and no role refusal", async () => {
    const refused: string[] = [];
    for (const [file, method] of adminRoutes()) {
      asNextAuth(OWNER, OWNER_HOME, W);
      const r = await callRoute(file, method);
      if (r.code === ROLE_REFUSAL || r.status === 401 || r.status === 403) refused.push(`${method} ${file} -> ${r.status} ${r.code}`);
    }
    assert.deepEqual(refused, []);
  });

  test("owner/admin really work (successful effects, not just 'not refused')", async () => {
    const { mintApiKeyAction } = await import("@/lib/workspace/actions");
    const { setWorkspaceTestModeAction } = await import("@/lib/test-mode/actions");
    for (const u of [OWNER, ADMIN]) {
      asOperator(u);
      const fd = new FormData();
      fd.set("name", `key-${u.slice(-4)}`);
      const minted = (await mintApiKeyAction(fd)) as { ok?: boolean };
      assert.notEqual(minted.ok, false, `${u === OWNER ? "owner" : "admin"} mints an API key`);
    }
    asOperator(ADMIN);
    const on = new FormData();
    on.set("testMode", "true");
    await setWorkspaceTestModeAction(on).catch((e: unknown) => { if (isRoleRefusal(e)) throw e; });
    const [tm] = await rows<{ test_mode: boolean }>(sql`select test_mode from organizations where id = ${W}::uuid`);
    assert.equal(tm.test_mode, true, "admin switched test mode on");
    const off = new FormData();
    off.set("testMode", "false");
    await setWorkspaceTestModeAction(off).catch((e: unknown) => { if (isRoleRefusal(e)) throw e; });
    asOperator(STAFF);
    await assert.rejects(() => setWorkspaceTestModeAction(on), (e: unknown) => isRoleRefusal(e));
    const [tm2] = await rows<{ test_mode: boolean }>(sql`select test_mode from organizations where id = ${W}::uuid`);
    assert.equal(tm2.test_mode, false, "staff could not switch it");
  });

  test("actions added by live 7fe2158d: booking calendar setting is owner/admin, its read is staff; Chatwoot link lookup/confirm are owner/admin", async () => {
    const { updateBookingCalendarAction, getBookingCalendarSelectionAction } = await import("@/lib/bookings/actions");
    const { findChatwootCandidatesAction, confirmChatwootLinkAction } = await import("@/lib/chatwoot-link/actions");
    const calendarId = "staff.fixture.calendar@group.calendar.test";
    asOperator(STAFF);
    await assert.rejects(() => updateBookingCalendarAction({ calendarId }), (e: unknown) => isRoleRefusal(e));
    assert.deepEqual(await getBookingCalendarSelectionAction(), { calendarId: null }, "staff's refused write changed nothing");
    asOperator(ADMIN);
    assert.deepEqual(await updateBookingCalendarAction({ calendarId }), { ok: true, calendarId }, "control: an admin saves the calendar");
    asOperator(STAFF);
    assert.deepEqual(await getBookingCalendarSelectionAction(), { calendarId }, "staff can READ the selection (the bookings page needs it)");
    asOperator(ADMIN);
    assert.deepEqual(await updateBookingCalendarAction({ calendarId: null }), { ok: true, calendarId: null });
    for (const realm of ["operator", "nextauth"] as const) {
      if (realm === "operator") asOperator(STAFF); else asNextAuth(STAFF, W);
      await assert.rejects(() => findChatwootCandidatesAction(U(95)), (e: unknown) => isRoleRefusal(e), `${realm}: staff lookup refused`);
      await assert.rejects(() => confirmChatwootLinkAction({ contactId: U(95), chatwootContactId: 1, conversationId: 1 }), (e: unknown) => isRoleRefusal(e), `${realm}: staff confirm refused`);
    }
    asNextAuth(OWNER, OWNER_HOME, W);
    const found = await findChatwootCandidatesAction(U(95));
    assert.equal(found.ok, false, "control: an owner passes the role guard and reaches the service (unknown contact -> typed result, no throw)");
    const confirmed = await confirmChatwootLinkAction({ contactId: U(95), chatwootContactId: 1, conversationId: 1 });
    assert.notDeepEqual(confirmed, { ok: false, code: "forbidden" }, "the owner is not told 'forbidden'");
  });

  test("target workspace: a staff member of W who OWNS another workspace cannot change W from there (home / client-supplied targets)", async () => {
    asNextAuth(DUAL, W, DUAL_A); // active = the workspace they own; home = W where they are staff
    assert.equal(await helpers.getCurrentWorkspaceRole(), "owner", "control: they are owner of the ACTIVE workspace");
    const { PUT } = await import("@/app/api/v1/integrations/route");
    const body = JSON.stringify({ provider: "resend", apiKey: ["fixture", "not", "a", "real", "value"].join("-") });
    const put = await PUT(new Request("http://app.fixture.test/api/v1/integrations", { method: "PUT", headers: { "content-type": "application/json" }, body }));
    assert.equal(put.status, 403, "v1/integrations writes the HOME workspace: refused");
    const { updateSoulCustomContextAction } = await import("@/lib/soul/actions");
    assert.equal(await outcome(() => updateSoulCustomContextAction({} as never)), "refused", "soul actions write the home workspace: refused");
    const { setContactPortalAccessAction } = await import("@/lib/portal/admin-actions");
    assert.equal(await outcome(() => setContactPortalAccessAction({ orgId: W, contactId: U(90), enabled: true } as never)), "refused", "client-supplied orgId W: refused");
    const { POST } = await import("@/app/api/oauth/authorize/route");
    const form = (org: string) => {
      const f = new FormData();
      f.set("client_id", OAUTH_CLIENT); f.set("redirect_uri", OAUTH_REDIRECT); f.set("code_challenge", "x".repeat(43)); f.set("state", "s"); f.set("org_id", org);
      return f;
    };
    const sameSite = { "sec-fetch-site": "same-origin", origin: "http://app.fixture.test" };
    const denied = await POST(new Request("http://app.fixture.test/api/oauth/authorize", { method: "POST", body: form(W), headers: sameSite }));
    assert.equal(denied.status, 403, "no OAuth grant for the workspace where they are staff");
    const granted = await POST(new Request("http://app.fixture.test/api/oauth/authorize", { method: "POST", body: form(DUAL_A), headers: sameSite }));
    assert.ok(granted.status !== 401 && granted.status !== 403, `control: their own workspace can be granted (got ${granted.status})`);
    const issued = await rows<{ org_id: string }>(sql`select org_id from oauth_authorization_codes where client_id = ${OAUTH_CLIENT}`);
    assert.deepEqual(issued.map((c) => c.org_id), [DUAL_A], "an authorization exists only for the owned workspace");
  });

  // ── v1 builder API chokepoints (user identity) ──────────────────────────────
  test("v1 builder API: staff cannot write the workspace; owner and admin can; a stranger cannot (soul submit had no check)", async () => {
    assert.equal(await V1.userCanWriteWorkspace(STAFF, W), false);
    assert.equal(await V1.userCanWriteWorkspace(ADMIN, W), true);
    assert.equal(await V1.userCanWriteWorkspace(OWNER, W), true);
    assert.equal(await V1.resolveOrgIdFromIdentity({ kind: "user", userId: STAFF }), null, "staff's home is not a write target");
    assert.equal(await V1.resolveOrgIdFromIdentity({ kind: "user", userId: OWNER }), OWNER_HOME, "control: the owner's home is");
    const { requireManagedWorkspaceForUser } = await import("@/lib/openclaw/self-service");
    await assert.rejects(() => requireManagedWorkspaceForUser(W, STAFF));
    assert.equal((await requireManagedWorkspaceForUser(W, ADMIN)).id, W);

    process.env.SELDON_BUILDER_API_KEYS = [`k-staff:${STAFF}`, `k-owner:${OWNER}`, `k-out:${OUTSIDER}`].join(",");
    const { POST } = await import("@/app/api/v1/soul/submit/route");
    const submit = (key: string) => POST(new Request("http://app.fixture.test/api/v1/soul/submit", {
      method: "POST", headers: { "x-seldon-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ workspace_id: W, soul: { businessName: key } }),
    }));
    asNextAuth(null);
    assert.equal((await submit("k-out")).status, 403, "a user with no standing in W cannot overwrite its soul");
    assert.equal((await submit("k-staff")).status, 403, "staff cannot overwrite the soul");
    const ok = await submit("k-owner");
    assert.equal(ok.status, 200, "control: the owner can");
  });

  // ── 4. revocation ───────────────────────────────────────────────────────────
  test("removal: a removed member's EXISTING magic-link session is refused on the next request; NextAuth too", async () => {
    const token = operatorToken(REMOVABLE);
    asOperatorToken(token);
    assert.equal((await opCtx.resolveOperatorPortalContext())?.user.role, "staff", "control: the session works before removal");
    assert.equal(await helpers.getOrgId(), W);
    assert.equal((await OP.getOperatorSessionForOrg(SLUG))?.role, "staff");
    asNextAuth(REMOVABLE, W);
    assert.equal(await helpers.getOrgId(), W, "control: NextAuth home access before removal");

    asNextAuth(STAFF, W);
    assert.deepEqual(await OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: REMOVABLE }), { ok: false, reason: "not_authorized_for_workspace" }, "staff cannot remove");
    asNextAuth(ADMIN, W);
    assert.deepEqual(await OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: REMOVABLE }), { ok: false, reason: "not_authorized_for_workspace" }, "admin cannot remove");
    assert.equal(await memberRole(REMOVABLE), "staff", "nothing changed yet");
    asNextAuth(OWNER, OWNER_HOME);
    assert.deepEqual(await OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: OWNER }), { ok: false, reason: "cannot_change_owner" });
    assert.deepEqual(await OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: REMOVABLE }), { ok: true });
    assert.equal(await memberRole(REMOVABLE), null);
    const audit = await rows<{ action: string; actor_user_id: string }>(sql`select action, actor_user_id from workspace_admin_actions where org_id = ${W}::uuid and action = 'member_removed' and before->>'userId' = ${REMOVABLE}`);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, OWNER);

    asOperatorToken(token); // the SAME cookie, unchanged, still unexpired
    assert.equal(await opCtx.resolveOperatorPortalContext(), null, "magic-link session dead on the next request");
    assert.equal(await helpers.getOrgId(), null);
    assert.equal(await OP.getOperatorSessionForOrg(SLUG), null);
    const { createContactAction } = await import("@/lib/contacts/actions");
    const fd = new FormData();
    fd.set("firstName", "Afterremoval");
    fd.set("email", "after.removal@fixture.test");
    await createContactAction(fd).catch(() => undefined);
    assert.equal((await rows(sql`select 1 from contacts where email = 'after.removal@fixture.test'`)).length, 0, "staff work is refused too: nothing written");
    asNextAuth(REMOVABLE, W);
    assert.equal(await helpers.getOrgId(), null, "NextAuth: the home row no longer grants the workspace");
    assert.equal(await helpers.userCanAccessOrg(REMOVABLE, W), false);
    // A magic link minted before removal can no longer become a session.
    const iat = Date.now() - 1000;
    const magic = S.signOperatorToken({ orgId: W, email: email(REMOVABLE), kind: "magic", iat, exp: iat + 15 * 60 * 1000 });
    asNextAuth(null);
    assert.deepEqual(await OP.consumeOperatorMagicLink({ orgSlug: SLUG, token: magic }), { ok: false, reason: "not_authorized_for_workspace" });
  });

  test("role change: a downgrade to staff applies on the next request; an upgrade restores (control)", async () => {
    asOperator(DOWNGRADE);
    await RW.requireWorkspaceAdmin(); // admin today
    asNextAuth(OWNER, OWNER_HOME);
    assert.deepEqual(await OP.setWorkspaceMemberRoleAction({ orgSlug: SLUG, userId: DOWNGRADE, role: "staff" }), { ok: true });
    asOperator(DOWNGRADE);
    await assert.rejects(() => RW.requireWorkspaceAdmin(), (e: unknown) => isRoleRefusal(e));
    const { mintApiKeyAction } = await import("@/lib/workspace/actions");
    assert.equal(await outcome(() => mintApiKeyAction({} as never)), "refused", "the real API-key action refuses at once");
    asNextAuth(OWNER, OWNER_HOME);
    assert.deepEqual(await OP.setWorkspaceMemberRoleAction({ orgSlug: SLUG, userId: DOWNGRADE, role: "owner" }), { ok: false, reason: "invalid_role" });
    assert.deepEqual(await OP.setWorkspaceMemberRoleAction({ orgSlug: SLUG, userId: DOWNGRADE, role: "admin" }), { ok: true });
    asOperator(DOWNGRADE);
    await RW.requireWorkspaceAdmin();
  });

  // ── 5. Law 20 multi-gate ────────────────────────────────────────────────────
  test("multi-gate: magic-link consumption and the per-request gate admit the same roles, keyed on org_members.role", async () => {
    // Control: the two role columns really differ for a staff member (users.role 'member' vs org_members.role 'staff').
    const [u] = await rows<{ role: string }>(sql`select role from users where id = ${STAFF}::uuid`);
    assert.equal(u.role, "member");
    assert.equal(await memberRole(STAFF), "staff");
    // users.role 'admin' at home must NOT make a staff member admin: the gates read the membership.
    await db.execute(sql`update users set role = 'admin' where id = ${ROLEPROBE}::uuid`);
    const results: Record<string, { consume: boolean; session: boolean; role: string | null }> = {};
    for (const role of ["owner", "admin", "staff", "member", "junk", null] as const) {
      await db.execute(sql`delete from org_members where org_id = ${W}::uuid and user_id = ${ROLEPROBE}::uuid`);
      if (role) await db.execute(sql`insert into org_members (org_id, user_id, role) values (${W}::uuid, ${ROLEPROBE}::uuid, ${role})`);
      const iat = Date.now() - 1000;
      const magic = S.signOperatorToken({ orgId: W, email: email(ROLEPROBE), kind: "magic", iat, exp: iat + 15 * 60 * 1000 });
      asNextAuth(null);
      const consumed = await OP.consumeOperatorMagicLink({ orgSlug: SLUG, token: magic });
      asOperator(ROLEPROBE);
      const c = await opCtx.resolveOperatorPortalContext();
      results[String(role)] = { consume: consumed.ok, session: Boolean(c), role: c?.user.role ?? null };
    }
    for (const [role, r] of Object.entries(results)) assert.equal(r.consume, r.session, `gates disagree for membership role ${role}`);
    assert.deepEqual(results.staff, { consume: true, session: true, role: "staff" });
    assert.deepEqual(results.member, { consume: true, session: true, role: "staff" });
    assert.deepEqual(results.admin, { consume: true, session: true, role: "admin" });
    assert.deepEqual(results.junk, { consume: false, session: false, role: null }, "control: the gates can refuse");
    assert.deepEqual(results.null, { consume: false, session: false, role: null }, "users.role 'admin' at home grants nothing alone");
    await db.execute(sql`delete from org_members where org_id = ${W}::uuid and user_id = ${ROLEPROBE}::uuid`);
    // Codex r1: the ownership paths (creating operator, legacy home owner) pass every gate too.
    for (const u of [PARENT, HOMEOWNER]) {
      const iat = Date.now() - 1000;
      const magic = S.signOperatorToken({ orgId: W, email: email(u), kind: "magic", iat, exp: iat + 15 * 60 * 1000 });
      asNextAuth(null);
      assert.equal((await OP.consumeOperatorMagicLink({ orgSlug: SLUG, token: magic })).ok, true, `consume admits ${u}`);
      asOperator(u);
      assert.equal((await opCtx.resolveOperatorPortalContext())?.user.role, "owner", `session admits ${u} as owner`);
    }
  });

  // ── 6. invite + Team list ───────────────────────────────────────────────────
  test("invite: grants STAFF by default, admin only when chosen; an invalid role is refused; staff/admin cannot invite", async () => {
    asNextAuth(OWNER, OWNER_HOME);
    const a = await OP.inviteWorkspaceOperatorAction({ orgSlug: SLUG, email: "new.staff@staff.fixture.test" });
    assert.equal(a.ok, true);
    const [n] = await rows<{ role: string }>(sql`select m.role from org_members m join users u on u.id = m.user_id where m.org_id = ${W}::uuid and u.email = 'new.staff@staff.fixture.test'`);
    assert.equal(n.role, "staff");
    await OP.inviteWorkspaceOperatorAction({ orgSlug: SLUG, email: "new.admin@staff.fixture.test", role: "admin" });
    const [m] = await rows<{ role: string }>(sql`select m.role from org_members m join users u on u.id = m.user_id where m.org_id = ${W}::uuid and u.email = 'new.admin@staff.fixture.test'`);
    assert.equal(m.role, "admin", "control: admin when chosen");
    assert.deepEqual(await OP.inviteWorkspaceOperatorAction({ orgSlug: SLUG, email: "x@staff.fixture.test", role: "owner" }), { ok: false, reason: "invalid_role" });
    for (const u of [STAFF, ADMIN]) {
      asNextAuth(u, W);
      assert.deepEqual(await OP.inviteWorkspaceOperatorAction({ orgSlug: SLUG, email: "y@staff.fixture.test" }), { ok: false, reason: "not_authorized_for_workspace" });
    }
  });

  test("Team page: lists EVERY member with the enforced role (owner homed elsewhere included; removed member excluded)", async () => {
    asNextAuth(OWNER, OWNER_HOME, W);
    const { default: Page } = await import("@/app/(dashboard)/settings/team/page");
    const tree = await Page();
    const found: Array<{ rows: Array<{ userId: string; role: string }>; canManage: boolean }> = [];
    const visit = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(visit);
      const props = (n as { props?: Record<string, unknown> }).props;
      if (props && Array.isArray(props.rows) && "canManage" in props) found.push(props as never);
      if (props) visit(props.children);
    };
    visit(tree);
    assert.equal(found.length, 1, "the members table is rendered");
    const roles = Object.fromEntries(found[0].rows.map((r) => [r.userId, r.role]));
    assert.equal(roles[OWNER], "owner", "the owner (homed elsewhere) is listed");
    assert.equal(roles[ADMIN], "admin");
    assert.equal(roles[STAFF], "staff");
    assert.equal(roles[REMOVABLE], undefined, "a removed member is not listed");
    assert.equal(found[0].canManage, true);
    asNextAuth(ADMIN, W, W);
    const adminTree = await Page();
    found.length = 0;
    visit(adminTree);
    assert.equal(found[0].canManage, false, "an admin sees no management controls");
  });

  // ── 7. ask_employee X-Staff-Id ──────────────────────────────────────────────
  test("ask_employee: X-Staff-Id is the session member's id, only to the bridge, refused without staff session / permission / after removal", async () => {
    const { wrapMcpTool } = await import("@/lib/agents/mcp/wrap-tool");
    const { createRuntimeMcpClient } = await import("@/lib/agents/mcp/runtime-client");
    const { resolveSessionStaffIdForConnector } = await import("@/lib/agents/tools");
    const seen: Array<{ url: string; staffId: string | null; body: string }> = [];
    const capture = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const h = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      seen.push({ url, staffId: h.get("x-staff-id"), body });
      const parsed = JSON.parse(body) as { id?: number };
      if (parsed.id === undefined) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deps = {
      getSecret: async () => "bridge-bearer-fixture",
      makeClient: (e: string, b: string, h?: Record<string, string>) => createRuntimeMcpClient(e, b, capture, async () => [{ address: "93.184.216.34", family: 4 }] as never, h),
      resolveStaffId: resolveSessionStaffIdForConnector,
    };
    const binding = (serviceName: string) => ({ id: serviceName, kind: "byo" as const, serviceName, endpoint: `https://${serviceName}.fixture.test/mcp`, enabledTools: ["ask_employee"] });
    const tool = wrapMcpTool(binding(ASK_SERVICE), { name: "ask_employee", description: "", inputSchema: { type: "object" } }, deps as never);
    const other = wrapMcpTool(binding("other-connector"), { name: "ask_employee", description: "", inputSchema: { type: "object" } }, deps as never);
    const staffCtx = { orgId: W, orgSlug: SLUG, agentId: "a", conversationId: "c", testMode: false, staffSurface: true };
    const spoof = { question: "hi", x_staff_id: STAFF2, "X-Staff-Id": STAFF2, staffId: STAFF2 };
    const run = async (t: typeof tool, c: Record<string, unknown>) => { seen.length = 0; try { await t.execute(spoof, c as never); return "called"; } catch (e) { return (e as { code?: string }).code ?? "error"; } };
    const lastToolCall = () => seen.find((s) => s.body.includes("tools/call"));

    asOperator(STAFF);
    assert.equal(await run(tool, staffCtx), "ask_employee_staff_session_required", "permission OFF by default: refused");
    assert.equal(seen.length, 0, "and nothing was sent");
    asNextAuth(OWNER, OWNER_HOME);
    assert.deepEqual(await OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: STAFF, enabled: true }), { ok: true });
    assert.deepEqual(await OP.setMemberAskEmployeePermissionAction({ orgSlug: SLUG, userId: STAFF2, enabled: true }), { ok: true });

    asOperator(STAFF);
    assert.equal(await run(tool, staffCtx), "called", "positive control: a valid staff session calls the bridge");
    assert.equal(lastToolCall()?.staffId, STAFF, "the header is the SESSION member's id");
    assert.ok(seen.every((s) => s.staffId === STAFF), "every request to the bridge carries it");
    assert.match(lastToolCall()!.body, new RegExp(STAFF2), "spoofed tool arguments are forwarded as plain arguments...");
    assert.notEqual(lastToolCall()?.staffId, STAFF2, "...and never become the header");
    asNextAuth(STAFF2, W);
    assert.equal(await run(tool, staffCtx), "called");
    assert.equal(lastToolCall()?.staffId, STAFF2, "another staff member's own session gives their own id (realm 2)");

    asOperator(STAFF);
    assert.equal(await run(other, staffCtx), "called");
    assert.ok(seen.every((s) => s.staffId === null), "no other connector ever receives the header");
    assert.equal(await run(tool, { ...staffCtx, staffSurface: undefined }), "ask_employee_staff_session_required", "a turn not marked staff-driven is refused");
    asNextAuth(null);
    assert.equal(await run(tool, staffCtx), "ask_employee_staff_session_required", "no session (customer/public turn): refused");
    assert.equal(seen.length, 0);

    const { resolveAskEmployeeCaller } = await import("@/lib/auth/require-workspace-role");
    asOperator(STAFF);
    assert.deepEqual(await resolveAskEmployeeCaller({ requestedStaffId: STAFF2 }), { ok: false, reason: "staff_id_mismatch" }, "a handed-in id that is not the session's is refused");
    assert.deepEqual(await resolveAskEmployeeCaller({ orgId: OUT_HOME }), { ok: false, reason: "workspace_mismatch" });

    asNextAuth(OWNER, OWNER_HOME);
    assert.deepEqual(await OP.removeWorkspaceMemberAction({ orgSlug: SLUG, userId: STAFF2 }), { ok: true });
    asNextAuth(STAFF2, W);
    assert.equal(await run(tool, staffCtx), "ask_employee_staff_session_required", "a removed member is refused on the next call");
    assert.equal(seen.length, 0, "and gets no header");
    const granted = await rows<{ ids: unknown }>(sql`select settings #> '{staffAccess,askEmployeeUserIds}' as ids from organizations where id = ${W}::uuid`);
    assert.deepEqual(granted[0].ids, [STAFF], "removal also dropped the permission");
  });

  test("instrument: every external call attempted by the sweeps was blocked in-process (recorded, never sent)", () => {
    // Informational control: the fetch stub recorded these and answered 503; nothing left the test process.
    console.log(`[staff-access] blocked external hosts: ${[...new Set(externalFetchCalls)].join(", ") || "(none)"}`);
  });
});
