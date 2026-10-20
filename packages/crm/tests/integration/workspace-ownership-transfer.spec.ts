// EPIC tenant ownership transfer: entitlement, transfer, rollback, operator-session cut-off and platform-admin support access,
// against a REAL Postgres through the production driver (DB_DRIVER=pg). Port dec-owner-epic-tenant-transfer-revised-design-approved-2026-10-20.
//
// The real modules run: lib/workspace/transfer-ownership.ts, lib/operator-portal/{auth,support-session,session}.ts,
// lib/auth/operator-portal-context.ts, lib/auth/helpers.ts, lib/billing/tier-resolver.ts, lib/tier/limits.ts, lib/agents/tools.ts and
// lib/auth/workspace-token.ts. Only the request context is faked: the NextAuth session (@/auth), the next/headers cookie store and
// fetch (no external host is ever reached). Scratch database only; all fixtures are synthetic.
//
// The fixture mirrors the live shape: EPIC's workspace owned by the platform admin and homed by it; the tenant owner homed on its
// own (other) workspace; the platform admin also owning synthetic workspaces.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const pad = (n: number) => `0000${n}`.slice(-4);
const U = (n: number) => `a1000000-0000-4000-8000-00000000${pad(n)}`;
const O = (n: number) => `b1000000-0000-4000-8000-00000000${pad(n)}`;

const SUPER = U(1), INFO = U(2), SUPER2 = U(3), OUTSIDER = U(4), AGENCY_OWNER = U(5);
const EPIC = O(1), INFO_HOME = O(2), SYN1 = O(3), SYN2 = O(4), OUT_HOME = O(5), AGENCY_WS = O(6), STRIPE_WS = O(7), PARENTED = O(8), AGO_HOME = O(9);
const AGENCY = "c1000000-0000-4000-8000-000000000001";
const SUPER_EMAIL = "ops@platform.test", SUPER2_EMAIL = "ops2@platform.test", INFO_EMAIL = "info@tenant.test", STAFF_EMAIL = "staff@tenant.test";
const EPIC_SLUG = "epic-pl-fixture";

type Ctx = { session: { user: { id: string; email: string; orgId: string | null } } | null; cookies: Map<string, string> };
const ctx: Ctx = { session: null, cookies: new Map() };
const externalFetchCalls: string[] = [];

describe("EPIC tenant ownership transfer (scratch Postgres, production driver)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let T: typeof import("@/lib/workspace/transfer-ownership");
  let OP: typeof import("@/lib/operator-portal/auth");
  let SS: typeof import("@/lib/operator-portal/support-session");
  let S: typeof import("@/lib/operator-portal/session");
  let resolveOperatorPortalContext: typeof import("@/lib/auth/operator-portal-context").resolveOperatorPortalContext;
  let helpers: typeof import("@/lib/auth/helpers");
  let isWorkspaceOwnerLike: typeof import("@/lib/workspace/workspace-owner").isWorkspaceOwnerLike;
  let resolveTierForWorkspace: typeof import("@/lib/billing/tier-resolver").resolveTierForWorkspace;
  let assertPortalEnabled: typeof import("@/lib/tier/limits").assertPortalEnabled;
  let tools: typeof import("@/lib/agents/tools");
  let WT: typeof import("@/lib/auth/workspace-token");
  let AT: typeof import("@/lib/auth/admin-token");
  let requireSuperAdmin: typeof import("@/lib/auth/super-admin").requireSuperAdmin;

  const rows = async <R>(q: ReturnType<typeof sql>): Promise<R[]> => {
    const r = await db.execute(q);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as R[];
  };
  const one = async <R>(q: ReturnType<typeof sql>) => (await rows<R>(q))[0];
  const as = (userId: string | null, email = "", orgId: string | null = null) => {
    ctx.session = userId ? { user: { id: userId, email, orgId } } : null;
  };
  const superActor = { userId: SUPER, email: SUPER_EMAIL };
  const operatorCookie = () => ctx.cookies.get("sf_operator_session") ?? null;
  const withOperatorCookie = async <R>(token: string | null, fn: () => Promise<R>) => {
    const saved = new Map(ctx.cookies);
    ctx.cookies.clear();
    if (token) ctx.cookies.set("sf_operator_session", token);
    try { return await fn(); } finally { ctx.cookies.clear(); for (const [k, v] of saved) ctx.cookies.set(k, v); }
  };
  const signAt = (kind: "magic" | "session", email: string, iat: number, extra: Record<string, unknown> = {}) =>
    S.signOperatorToken({ orgId: EPIC, email, kind, iat, exp: iat + (kind === "magic" ? S.OPERATOR_MAGIC_LINK_TTL_MS : S.OPERATOR_SESSION_TTL_MS), ...extra });
  const portalOrgFor = async (token: string) => withOperatorCookie(token, async () => (await resolveOperatorPortalContext())?.orgId ?? null);
  const sessionForOrg = async (token: string) => withOperatorCookie(token, async () => (await OP.getOperatorSessionForOrg(EPIC_SLUG))?.orgId ?? null);
  const ownerState = async () => ({
    owner: (await one<{ owner_id: string | null }>(sql`select owner_id from organizations where id = ${EPIC}::uuid`))?.owner_id ?? null,
    superHome: (await one<{ org_id: string | null }>(sql`select org_id from users where id = ${SUPER}::uuid`))?.org_id ?? null,
    infoHome: (await one<{ org_id: string | null }>(sql`select org_id from users where id = ${INFO}::uuid`))?.org_id ?? null,
    members: (await rows<{ user_id: string; role: string }>(sql`select user_id, role from org_members where org_id = ${EPIC}::uuid order by user_id`)).map((m) => `${m.user_id}:${m.role}`),
  });
  const portalOk = async (orgId: string) => { try { await assertPortalEnabled(orgId); return true; } catch { return false; } };
  // The six runtime paths that resolve "the workspace's owner" through users.orgId (reuse-review finding).
  const sixPaths = async () => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toolCtx = { orgId: EPIC, orgSlug: EPIC_SLUG, agentId: U(900), conversationId: U(901), testMode: false } as import("@/lib/agents/tools").ToolExecuteContext;
    await tools.escalateToHuman.execute({ reason: `escalation ${tag}`, contactEmail: "cust@fixture.test" }, toolCtx);
    const esc = await one<{ user_id: string }>(sql`select user_id from activities where org_id = ${EPIC}::uuid and type = 'agent_escalation' and body = ${`escalation ${tag}`}`);
    await tools.takeMessage.execute({ caller_name: "Cal Back", caller_phone: "+17675550100", message: `callback ${tag}` }, toolCtx);
    const cb = await one<{ user_id: string }>(sql`select user_id from activities where org_id = ${EPIC}::uuid and body like ${`%callback ${tag}`}`);
    // Internal helpers (not exported): their exact query, as written in the source.
    const firstTurn = await one<{ id: string }>(sql`select id from users where org_id = ${EPIC}::uuid limit 1`); // agents/runtime.ts:1027-1035
    const genWorkflow = await one<{ id: string }>(sql`select id from users where org_id = ${EPIC}::uuid limit 1`); // automations/generated-workflows.ts:474-480
    const aiPlan = await one<{ id: string }>(sql`select id from users where org_id = ${EPIC}::uuid and role = 'owner' limit 1`); // ai/client.ts:104-108
    const team = (await rows<{ id: string }>(sql`select id from users where org_id = ${EPIC}::uuid`)).map((r) => r.id); // settings/team/page.tsx:24
    return { escalate: esc?.user_id ?? null, callback: cb?.user_id ?? null, firstTurn: firstTurn?.id ?? null, genWorkflow: genWorkflow?.id ?? null, aiPlan: aiPlan?.id ?? null, team };
  };

  // Tokens minted BEFORE the transfer (must all be dead after it).
  let preSession7d = "", preUnusedMagic = "", preLegacySession = "", preSupport = "";
  let apiKeyMcp = "", apiKeyRelay = "";
  let transferActionId = "", cutoff = 0;
  let infoSessionAfterTransfer = "";

  before(async () => {
    process.env.SF_SUPERADMIN_EMAILS = `${SUPER_EMAIL}, ${SUPER2_EMAIL}`;
    process.env.AUTH_SECRET = ["fixture", "operator", "secret", "only"].join("-");
    process.env.NEXT_PUBLIC_APP_URL = "http://app.fixture.test";
    delete process.env.SMTP2GO_API_KEY; delete process.env.RESEND_API_KEY; // no email transport: issuance answers without sending

    const crm = path.resolve(".");
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
        headers: async () => new Headers(),
      },
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
    T = await import("@/lib/workspace/transfer-ownership");
    OP = await import("@/lib/operator-portal/auth");
    SS = await import("@/lib/operator-portal/support-session");
    S = await import("@/lib/operator-portal/session");
    ({ resolveOperatorPortalContext } = await import("@/lib/auth/operator-portal-context"));
    helpers = await import("@/lib/auth/helpers");
    ({ isWorkspaceOwnerLike } = await import("@/lib/workspace/workspace-owner"));
    ({ resolveTierForWorkspace } = await import("@/lib/billing/tier-resolver"));
    ({ assertPortalEnabled } = await import("@/lib/tier/limits"));
    tools = await import("@/lib/agents/tools");
    WT = await import("@/lib/auth/workspace-token");
    AT = await import("@/lib/auth/admin-token");
    ({ requireSuperAdmin } = await import("@/lib/auth/super-admin"));

    const ex = (q: ReturnType<typeof sql>) => db.execute(q);
    for (const [o, slug] of [[EPIC, EPIC_SLUG], [INFO_HOME, "info-home"], [SYN1, "syn-one"], [SYN2, "syn-two"], [OUT_HOME, "out-home"], [AGENCY_WS, "agency-ws"], [STRIPE_WS, "stripe-ws"], [PARENTED, "parented"], [AGO_HOME, "ago-home"]] as const) {
      await ex(sql`insert into organizations (id, name, slug) values (${o}::uuid, ${slug}, ${slug})`);
    }
    for (const [u, email, home] of [[SUPER, SUPER_EMAIL, EPIC], [INFO, INFO_EMAIL, INFO_HOME], [SUPER2, SUPER2_EMAIL, OUT_HOME], [OUTSIDER, "outsider@fixture.test", OUT_HOME], [AGENCY_OWNER, "agency-owner@fixture.test", AGO_HOME]] as const) {
      await ex(sql`insert into users (id, org_id, name, email, role, plan_id) values (${u}::uuid, ${home}::uuid, ${email.split("@")[0]}, ${email}, 'owner', 'free')`);
    }
    await ex(sql`update organizations set owner_id = ${SUPER}::uuid where id in (${EPIC}::uuid, ${SYN1}::uuid, ${SYN2}::uuid, ${PARENTED}::uuid, ${STRIPE_WS}::uuid)`);
    await ex(sql`update organizations set parent_user_id = ${SUPER}::uuid where id in (${SYN1}::uuid, ${SYN2}::uuid, ${PARENTED}::uuid)`);
    await ex(sql`update organizations set owner_id = ${INFO}::uuid where id = ${INFO_HOME}::uuid`);
    await ex(sql`update organizations set owner_id = ${OUTSIDER}::uuid where id = ${OUT_HOME}::uuid`);
    await ex(sql`update organizations set owner_id = ${AGENCY_OWNER}::uuid where id = ${AGO_HOME}::uuid`);
    await ex(sql`update organizations set subscription = ${JSON.stringify({ stripeSubscriptionId: "sub_fixture_0001", tier: "managed" })}::jsonb where id = ${STRIPE_WS}::uuid`);
    await ex(sql`insert into partner_agencies (id, name, slug, owner_user_id, status) values (${AGENCY}::uuid, 'Fixture agency', 'fixture-agency', ${AGENCY_OWNER}::uuid, 'active')`);
    await ex(sql`update organizations set parent_agency_id = ${AGENCY}::uuid where id = ${AGENCY_WS}::uuid`);
    await ex(sql`insert into contacts (org_id, first_name, email) values (${EPIC}::uuid, 'Cust', 'cust@fixture.test')`);
    await ex(sql`insert into contacts (org_id, first_name) values (${INFO_HOME}::uuid, 'Only')`);
    apiKeyMcp = (await WT.mintWorkspaceToken(EPIC, { name: "user:MCP_Server" })).token;
    apiKeyRelay = (await WT.mintWorkspaceToken(EPIC, { name: "user:host04" })).token;
  });

  // ── BEFORE: positive controls on the live-shaped fixture ─────────────────────
  test("before: the six home-dependent paths resolve to the CURRENT owner (the platform admin) — positive control", async () => {
    const p = await sixPaths();
    assert.deepEqual({ ...p, team: p.team }, { escalate: SUPER, callback: SUPER, firstTurn: SUPER, genWorkflow: SUPER, aiPlan: SUPER, team: [SUPER] });
  });

  test("before: owner-like, tier and limits on every workspace either user owns", async () => {
    assert.equal(await isWorkspaceOwnerLike(EPIC, SUPER), true);
    assert.equal(await isWorkspaceOwnerLike(EPIC, INFO), false);
    assert.equal(await isWorkspaceOwnerLike(INFO_HOME, INFO), true);
    assert.equal(await isWorkspaceOwnerLike(SYN1, SUPER), true);
    assert.equal(await isWorkspaceOwnerLike(SYN2, SUPER), true);
    assert.equal(await resolveTierForWorkspace(EPIC), "agency_scale"); // owner-derived today
    assert.equal(await resolveTierForWorkspace(SYN1), "agency_scale");
    assert.equal(await resolveTierForWorkspace(INFO_HOME), "inactive");
    assert.equal(await portalOk(EPIC), true); // home + superadmin bypass
    assert.equal(await portalOk(SYN1), true);
    assert.equal(await portalOk(INFO_HOME), false);
  });

  test("before: the two workspace API keys authenticate as workspace admin, never owner-like", async () => {
    for (const key of [apiKeyMcp, apiKeyRelay]) {
      assert.equal((await WT.validateRawWorkspaceToken(key))?.orgId, EPIC);
      const role = await withOperatorCookie(null, async () => { ctx.cookies.set(AT.ADMIN_TOKEN_COOKIE, key); as(null); return helpers.getCurrentWorkspaceRole(); });
      assert.equal(role, "admin");
      assert.notEqual(AT.adminTokenUserId(EPIC), (await ownerState()).owner);
    }
  });

  test("before: mint the tokens that the transfer must kill (a 7-day session, an unused magic link, a legacy no-iat session, a support session)", async () => {
    const now = Date.now();
    preSession7d = signAt("session", SUPER_EMAIL, now - 60_000);
    preUnusedMagic = signAt("magic", SUPER_EMAIL, now - 30_000);
    preLegacySession = S.signOperatorToken({ orgId: EPIC, email: SUPER_EMAIL, kind: "session", exp: now - 10_000 + S.OPERATOR_SESSION_TTL_MS });
    preSupport = signAt("session", "support+platform-x@seldonframe-agency.local", now - 5_000, { supportOriginUserId: SUPER, exp: now - 5_000 + S.OPERATOR_SUPPORT_SESSION_TTL_MS });
    for (const t of [preSession7d, preLegacySession, preSupport]) assert.equal(await portalOrgFor(t), EPIC, "valid before the transfer (positive control)");
    assert.equal(await sessionForOrg(preSession7d), EPIC);
  });

  // ── Entitlement ─────────────────────────────────────────────────────────────
  test("transfer is refused while the workspace's tier still comes from its owner (and nothing changes)", async () => {
    const before = await ownerState();
    const r = await T.transferWorkspaceOwnership({ orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: SYN1, actor: superActor });
    assert.deepEqual(r.ok ? "ok" : r.reason, "entitlement_depends_on_owner");
    assert.deepEqual(await ownerState(), before);
    const audit = await one<{ outcome: string; reason: string }>(sql`select outcome, reason from workspace_admin_actions where org_id = ${EPIC}::uuid and action = 'ownership_transfer' order by created_at desc limit 1`);
    assert.deepEqual(audit, { outcome: "refused", reason: "entitlement_depends_on_owner" });
  });

  test("internal entitlement: refused for a non-platform-admin and for a Stripe-managed subscription", async () => {
    const r1 = await T.setInternalWorkspaceEntitlement({ orgId: EPIC, tier: "growth", actor: { userId: INFO, email: INFO_EMAIL } });
    assert.equal(r1.ok ? "ok" : r1.reason, "not_platform_admin");
    const r2 = await T.setInternalWorkspaceEntitlement({ orgId: STRIPE_WS, tier: "growth", actor: superActor });
    assert.equal(r2.ok ? "ok" : r2.reason, "stripe_managed_subscription");
    assert.equal((await one<{ plan: string }>(sql`select plan from organizations where id = ${EPIC}::uuid`))?.plan, "free");
  });

  test("internal entitlement: 'growth' with payment collection off, audited; the tier no longer depends on the owner", async () => {
    const r = await T.setInternalWorkspaceEntitlement({ orgId: EPIC, tier: "growth", actor: superActor });
    assert.equal(r.ok, true);
    const org = await one<{ plan: string; subscription: Record<string, unknown> }>(sql`select plan, subscription from organizations where id = ${EPIC}::uuid`);
    assert.equal(org?.plan, "growth");
    assert.deepEqual({ tier: org?.subscription.tier, status: org?.subscription.status }, { tier: "growth", status: "active" });
    for (const k of ["stripeCustomerId", "stripeSubscriptionId", "stripePriceId"]) assert.equal(org?.subscription[k], undefined);
    assert.equal(await resolveTierForWorkspace(EPIC), "workspace");
    const audit = await one<{ outcome: string; after: Record<string, unknown> }>(sql`select outcome, after from workspace_admin_actions where org_id = ${EPIC}::uuid and action = 'internal_entitlement' and outcome = 'applied'`);
    assert.equal(audit?.after.paymentCollection, "off");
  });

  // ── Transfer safeguards ───────────────────────────────────────────────────────
  test("transfer refusals: wrong expected owner, platform-admin target, tier mismatch, non-admin actor — each with no change", async () => {
    const before = await ownerState();
    const cases: Array<[string, Parameters<typeof T.transferWorkspaceOwnership>[0]]> = [
      ["owner_changed", { orgId: EPIC, expectedCurrentOwnerId: OUTSIDER, newOwnerUserId: INFO, expectedTier: "growth", actor: superActor }],
      ["new_owner_is_platform_admin", { orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: SUPER2, expectedTier: "growth", actor: superActor }],
      ["tier_mismatch", { orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "agency_scale", actor: superActor }],
      ["not_platform_admin", { orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", actor: { userId: INFO, email: INFO_EMAIL } }],
    ];
    for (const [reason, input] of cases) {
      const r = await T.transferWorkspaceOwnership(input);
      assert.equal(r.ok ? "ok" : r.reason, reason);
      assert.deepEqual(await ownerState(), before, `no change after ${reason}`);
    }
  });

  test("old owner's home: required when it is this workspace, must be a workspace it already owns, never this one; no change on refusal", async () => {
    const before = await ownerState();
    const cases: Array<[string, string | undefined]> = [
      ["old_owner_home_required", undefined],
      ["old_owner_home_is_this_workspace", EPIC],
      ["old_owner_home_not_owned", OUT_HOME], // exists, owned by someone else: moving the home there would GRANT access
      ["old_owner_home_not_owned", INFO_HOME],
    ];
    for (const [reason, home] of cases) {
      const r = await T.transferWorkspaceOwnership({ orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: home, actor: superActor });
      assert.equal(r.ok ? "ok" : r.reason, reason, `home=${home}`);
      assert.deepEqual(await ownerState(), before, `no change after ${reason} (${home})`);
    }
  });

  test("atomicity: a refusal raised AFTER the writes (old owner still owner-like via parentUserId) leaves no partial state", async () => {
    await db.execute(sql`update organizations set plan = 'growth', subscription = '{"tier":"growth","status":"active"}'::jsonb where id = ${PARENTED}::uuid`);
    const snap = async () => rows(sql`select o.owner_id, (select org_id from users where id = ${INFO}::uuid) info_home, (select count(*) from org_members where org_id = ${PARENTED}::uuid) members, o.operator_sessions_valid_after from organizations o where o.id = ${PARENTED}::uuid`);
    const before = await snap();
    const r = await T.transferWorkspaceOwnership({ orgId: PARENTED, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", actor: superActor });
    assert.equal(r.ok ? "ok" : r.reason, "old_owner_still_owner_like");
    assert.deepEqual(await snap(), before);
  });

  // ── The transfer ──────────────────────────────────────────────────────────────
  test("transfer: ownership, both homes, memberships and the session cut-off change together; audit row + post-commit event", async () => {
    const r = await T.transferWorkspaceOwnership({ orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: SYN1, actor: superActor });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    transferActionId = r.actionId;
    cutoff = new Date(r.operatorSessionsValidAfter!).getTime();
    assert.deepEqual(await ownerState(), { owner: INFO, superHome: SYN1, infoHome: EPIC, members: [`${INFO}:owner`] });
    const audit = await one<{ outcome: string; actor_email: string; before: { ownerId: string }; after: { ownerId: string } }>(sql`select outcome, actor_email, before, after from workspace_admin_actions where id = ${transferActionId}::uuid`);
    assert.deepEqual({ o: audit?.outcome, a: audit?.actor_email, b: audit?.before.ownerId, f: audit?.after.ownerId }, { o: "applied", a: SUPER_EMAIL, b: SUPER, f: INFO });
    const ev = await one<{ n: number }>(sql`select count(*)::int n from workflow_event_log where org_id = ${EPIC}::uuid and event_type = 'workspace.ownership_transferred'`);
    assert.equal(ev?.n, 1);
  });

  test("after: the six home-dependent paths resolve to the NEW owner (info@)", async () => {
    const p = await sixPaths();
    assert.deepEqual(p, { escalate: INFO, callback: INFO, firstTurn: INFO, genWorkflow: INFO, aiPlan: INFO, team: [INFO] });
  });

  test("after: owner-like / tier / limits on EPIC, info@'s old workspace and the platform admin's other workspaces", async () => {
    assert.equal(await isWorkspaceOwnerLike(EPIC, INFO), true);
    assert.equal(await isWorkspaceOwnerLike(EPIC, SUPER), false);
    assert.equal(await isWorkspaceOwnerLike(INFO_HOME, INFO), true, "info@ keeps owner access to its old workspace");
    assert.equal(await isWorkspaceOwnerLike(SYN1, SUPER), true);
    assert.equal(await isWorkspaceOwnerLike(SYN2, SUPER), true);
    assert.equal(await isWorkspaceOwnerLike(INFO_HOME, SUPER), false);
    assert.equal(await resolveTierForWorkspace(EPIC), "workspace", "EPIC keeps its own entitlement");
    assert.equal(await resolveTierForWorkspace(SYN1), "agency_scale", "unchanged");
    assert.equal(await resolveTierForWorkspace(SYN2), "agency_scale", "unchanged");
    // Documented effect, not hidden: a plan-less workspace inherits its owner's HOME tier (tier-resolver.ts, upstream). info@'s
    // home is now EPIC, so its old (plan-less) workspace resolves 'workspace' instead of 'inactive'.
    assert.equal(await resolveTierForWorkspace(INFO_HOME), "workspace");
    assert.equal(await portalOk(EPIC), true, "growth: portal on, without any bypass");
    assert.equal(await portalOk(SYN1), true, "unchanged");
    assert.equal(await portalOk(INFO_HOME), false, "starter cloud limits: portal still off");
  });

  test("after: the workspace API keys still authenticate as admin and are still not owner-like", async () => {
    for (const key of [apiKeyMcp, apiKeyRelay]) {
      assert.equal((await WT.validateRawWorkspaceToken(key))?.orgId, EPIC);
      const role = await withOperatorCookie(null, async () => { ctx.cookies.set(AT.ADMIN_TOKEN_COOKIE, key); as(null); return helpers.getCurrentWorkspaceRole(); });
      assert.equal(role, "admin");
      assert.notEqual(AT.adminTokenUserId(EPIC), INFO);
    }
  });

  // ── Session cut-off (A) ─────────────────────────────────────────────────────
  test("A: every pre-transfer token is refused on every read path", async () => {
    for (const t of [preSession7d, preLegacySession, preSupport]) assert.equal(await portalOrgFor(t), null);
    assert.equal(await sessionForOrg(preSession7d), null);
    const consumed = await withOperatorCookie(null, () => OP.consumeOperatorMagicLink({ orgSlug: EPIC_SLUG, token: preUnusedMagic }));
    assert.equal(consumed.ok ? "ok" : consumed.reason, "invalid_or_expired_token", "an UNUSED pre-transfer magic link is dead");
    const supportConsumed = await withOperatorCookie(null, () => SS.consumeAgencySupportSession({ orgSlug: EPIC_SLUG, token: preSupport }));
    assert.equal(supportConsumed.ok, false);
  });

  test("A: boundaries against the real cut-off — equal and 1 ms before refused, 1 ms after accepted", async () => {
    // Positive control first: the account is authorised (info@ is now the owner).
    assert.equal(await portalOrgFor(signAt("session", INFO_EMAIL, cutoff + 1)), EPIC);
    assert.equal(await portalOrgFor(signAt("session", INFO_EMAIL, cutoff)), null);
    assert.equal(await portalOrgFor(signAt("session", INFO_EMAIL, cutoff - 1)), null);
    assert.equal(await sessionForOrg(signAt("session", INFO_EMAIL, cutoff)), null);
    assert.equal(await sessionForOrg(signAt("session", INFO_EMAIL, cutoff + 1)), EPIC);
  });

  test("A: the new owner gets a normal 7-day session after the transfer (positive control)", async () => {
    const asked = await OP.requestOperatorMagicLinkAction({ orgSlug: EPIC_SLUG, email: INFO_EMAIL });
    assert.equal(asked.ok && asked.expiresAt !== "", true, "authorised: a link would be issued");
    const link = signAt("magic", INFO_EMAIL, Date.now());
    const consumed = await withOperatorCookie(null, async () => {
      const r = await OP.consumeOperatorMagicLink({ orgSlug: EPIC_SLUG, token: link });
      return { r, cookie: operatorCookie() };
    });
    assert.equal(consumed.r.ok, true);
    infoSessionAfterTransfer = consumed.cookie!;
    const v = S.verifyOperatorToken(infoSessionAfterTransfer)!;
    assert.equal(v.exp - S.operatorTokenIssuedAt(v), S.OPERATOR_SESSION_TTL_MS);
    assert.equal(await portalOrgFor(infoSessionAfterTransfer), EPIC);
  });

  // ── Platform admin: no standing session (B), audited 2-hour support only (C) ──
  test("B: a platform-admin-only identity never gets a standing session — request, consume, invite self/alias", async () => {
    const asked = await OP.requestOperatorMagicLinkAction({ orgSlug: EPIC_SLUG, email: SUPER_EMAIL });
    assert.equal(asked.ok && asked.expiresAt, "", "the public request path (also used by the agency 'ready' page) issues nothing");
    const forged = await withOperatorCookie(null, () => OP.consumeOperatorMagicLink({ orgSlug: EPIC_SLUG, token: signAt("magic", SUPER_EMAIL, Date.now()) }));
    assert.equal(forged.ok ? "ok" : forged.reason, "not_authorized_for_workspace", "a link minted for it cannot become a session");
    as(INFO, INFO_EMAIL, EPIC);
    for (const email of [SUPER_EMAIL, "  OPS@Platform.TEST "]) {
      const r = await OP.inviteWorkspaceOperatorAction({ orgSlug: EPIC_SLUG, email });
      assert.equal(r.ok ? "ok" : r.reason, "platform_admin_uses_support_session", `owner inviting ${email.trim()}`);
    }
    as(SUPER, SUPER_EMAIL, null);
    const self = await OP.inviteWorkspaceOperatorAction({ orgSlug: EPIC_SLUG, email: SUPER_EMAIL });
    assert.equal(self.ok ? "ok" : self.reason, "platform_admin_uses_support_session", "platform admin inviting itself");
    assert.deepEqual((await ownerState()).members, [`${INFO}:owner`], "no membership was created for the platform admin");
  });

  test("B: legitimate access is preserved — the platform admin can still INVITE staff, and staff get a normal 7-day session", async () => {
    as(SUPER, SUPER_EMAIL, null);
    const r = await OP.inviteWorkspaceOperatorAction({ orgSlug: EPIC_SLUG, email: STAFF_EMAIL });
    assert.equal(r.ok, true, JSON.stringify(r));
    const staff = await one<{ id: string; role: string }>(sql`select u.id, m.role from users u join org_members m on m.user_id = u.id and m.org_id = ${EPIC}::uuid where u.email = ${STAFF_EMAIL}`);
    assert.equal(staff?.role, "admin");
    const asked = await OP.requestOperatorMagicLinkAction({ orgSlug: EPIC_SLUG, email: STAFF_EMAIL });
    assert.equal(asked.ok && asked.expiresAt !== "", true);
    const consumed = await withOperatorCookie(null, async () => ({ r: await OP.consumeOperatorMagicLink({ orgSlug: EPIC_SLUG, token: signAt("magic", STAFF_EMAIL, Date.now()) }), c: operatorCookie() }));
    assert.equal(consumed.r.ok, true);
    assert.equal(await portalOrgFor(consumed.c!), EPIC);
    // Remove the fixture staff member again so the rollback sees exactly the state the transfer left.
    await db.execute(sql`delete from org_members where org_id = ${EPIC}::uuid and user_id = ${staff!.id}::uuid`);
    await db.execute(sql`update users set org_id = ${OUT_HOME}::uuid where id = ${staff!.id}::uuid`);
  });

  test("C: the platform admin's tenant access is the audited 2-hour support session (agency_id NULL, actor id + email, event)", async () => {
    as(SUPER, SUPER_EMAIL, null);
    const r = await SS.createAgencySupportSession({ workspaceId: EPIC });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    const token = new URL(r.url).searchParams.get("token")!;
    const v = S.verifyOperatorToken(token)!;
    assert.deepEqual({ kind: v.kind, origin: v.supportOriginUserId, ttl: v.exp - S.operatorTokenIssuedAt(v) }, { kind: "session", origin: SUPER, ttl: S.OPERATOR_SUPPORT_SESSION_TTL_MS });
    const audit = await one<{ agency_id: string | null; origin_user_id: string; notes: string }>(sql`select agency_id, origin_user_id, notes from agency_support_sessions where id = ${r.sessionId}::uuid`);
    assert.deepEqual(audit, { agency_id: null, origin_user_id: SUPER, notes: `platform_support actor_email=${SUPER_EMAIL}` });
    const ev = await one<{ n: number }>(sql`select count(*)::int n from workflow_event_log where org_id = ${EPIC}::uuid and event_type = 'agency.support_session_started' and payload->>'sessionId' = ${r.sessionId}`);
    assert.equal(ev?.n, 1);
    const consumed = await withOperatorCookie(null, async () => ({ r: await SS.consumeAgencySupportSession({ orgSlug: EPIC_SLUG, token }), c: operatorCookie() }));
    assert.equal(consumed.r.ok, true);
    assert.equal(await portalOrgFor(consumed.c!), EPIC);
    const ctxUser = await withOperatorCookie(consumed.c!, () => resolveOperatorPortalContext());
    assert.equal(ctxUser?.user.supportOriginUserId, SUPER);
  });

  test("C: a support session cannot outlive 2 hours or be converted into a 7-day session", async () => {
    const expired = S.signOperatorToken({ orgId: EPIC, email: "support+platform-x@seldonframe-agency.local", kind: "session", supportOriginUserId: SUPER, iat: Date.now() - S.OPERATOR_SUPPORT_SESSION_TTL_MS - 1000, exp: Date.now() - 1000 });
    assert.equal(await portalOrgFor(expired), null);
    const re = await withOperatorCookie(null, () => SS.consumeAgencySupportSession({ orgSlug: EPIC_SLUG, token: expired }));
    assert.equal(re.ok, false);
    const live = S.signOperatorToken({ orgId: EPIC, email: "support+platform-x@seldonframe-agency.local", kind: "session", supportOriginUserId: SUPER, iat: Date.now(), exp: Date.now() + S.OPERATOR_SUPPORT_SESSION_TTL_MS });
    const asMagic = await withOperatorCookie(null, () => OP.consumeOperatorMagicLink({ orgSlug: EPIC_SLUG, token: live }));
    assert.equal(asMagic.ok ? "ok" : asMagic.reason, "invalid_or_expired_token", "a support token is not a magic link");
  });

  test("C: both branches — a non-platform-admin is refused an agency-less session; the agency branch stays strict", async () => {
    as(OUTSIDER, "outsider@fixture.test", OUT_HOME);
    const refused = await SS.createAgencySupportSession({ workspaceId: EPIC });
    assert.equal(refused.ok ? "ok" : refused.reason, "workspace_not_under_an_agency");
    as(AGENCY_OWNER, "agency-owner@fixture.test", AGO_HOME);
    const agencyOk = await SS.createAgencySupportSession({ workspaceId: AGENCY_WS });
    assert.equal(agencyOk.ok, true, "agency owner (positive control)");
    if (agencyOk.ok) {
      const row = await one<{ agency_id: string }>(sql`select agency_id from agency_support_sessions where id = ${agencyOk.sessionId}::uuid`);
      assert.equal(row?.agency_id, AGENCY);
    }
    for (const [u, e] of [[OUTSIDER, "outsider@fixture.test"], [SUPER, SUPER_EMAIL]] as const) {
      as(u, e, null);
      const r = await SS.createAgencySupportSession({ workspaceId: AGENCY_WS });
      assert.equal(r.ok ? "ok" : r.reason, "not_agency_owner", `${e} on an agency workspace`);
    }
  });

  // ── Dashboard sessions after the home moves (users.org_id is NOT NULL: the home moves to a workspace it already owns) ──
  test("moved home: the platform admin's dashboard lands in its own workspace (SYN1), switches only into workspaces it owns, never EPIC", async () => {
    as(SUPER, SUPER_EMAIL, SYN1);
    assert.equal(await withOperatorCookie(null, () => helpers.getOrgId()), SYN1);
    for (const ws of [SYN1, SYN2]) {
      const org = await withOperatorCookie(null, async () => { ctx.cookies.set("sf_active_org_id", ws); return helpers.getOrgId(); });
      assert.equal(org, ws, "switching into its other owned workspaces still works");
    }
    const epic = await withOperatorCookie(null, async () => { ctx.cookies.set("sf_active_org_id", EPIC); return helpers.getOrgId(); });
    assert.notEqual(epic, EPIC, "no tenant foothold in EPIC through the dashboard");
    const gate = await requireSuperAdmin();
    assert.equal(gate.userId, SUPER, "platform admin pages: authority is role-based (SF_SUPERADMIN_EMAILS), not ownership");
  });

  test("dashboard: info@ lands in EPIC by default as owner; its old workspace is still reachable", async () => {
    as(INFO, INFO_EMAIL, EPIC);
    assert.equal(await withOperatorCookie(null, () => helpers.getOrgId()), EPIC);
    assert.equal(await withOperatorCookie(null, () => helpers.getCurrentWorkspaceRole()), "owner");
    const old = await withOperatorCookie(null, async () => { ctx.cookies.set("sf_active_org_id", INFO_HOME); return helpers.getOrgId(); });
    assert.equal(old, INFO_HOME);
  });

  // ── Idempotency, rollback, concurrency ────────────────────────────────────────
  test("idempotent: re-running the same transfer reports it as already applied and writes nothing", async () => {
    const count = async () => (await one<{ n: number }>(sql`select count(*)::int n from workspace_admin_actions where org_id = ${EPIC}::uuid`))?.n;
    const n = await count();
    const r = await T.transferWorkspaceOwnership({ orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: SYN1, actor: superActor });
    assert.deepEqual(r.ok ? { a: r.alreadyApplied, id: r.actionId } : r.reason, { a: true, id: transferActionId });
    assert.equal(await count(), n);
  });

  test("rollback is refused when the state has drifted since the transfer", async () => {
    await db.execute(sql`insert into org_members (org_id, user_id, role) values (${EPIC}::uuid, ${OUTSIDER}::uuid, 'admin')`);
    const r = await T.rollbackWorkspaceOwnershipTransfer({ orgId: EPIC, transferActionId, actor: superActor });
    assert.equal(r.ok ? "ok" : r.reason, "state_drifted");
    assert.equal((await ownerState()).owner, INFO, "nothing reversed");
    await db.execute(sql`delete from org_members where org_id = ${EPIC}::uuid and user_id = ${OUTSIDER}::uuid`);
  });

  test("rollback restores ownership, homes and memberships, and does NOT revive revoked sessions", async () => {
    const r = await T.rollbackWorkspaceOwnershipTransfer({ orgId: EPIC, transferActionId, actor: superActor });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await ownerState(), { owner: SUPER, superHome: EPIC, infoHome: INFO_HOME, members: [] });
    const validAfter = (await one<{ v: string }>(sql`select operator_sessions_valid_after v from organizations where id = ${EPIC}::uuid`))?.v;
    assert.ok(validAfter && new Date(validAfter).getTime() > cutoff, "the cut-off only moves forward");
    for (const t of [preSession7d, preLegacySession, preSupport]) assert.equal(await portalOrgFor(t), null, "pre-transfer tokens stay dead");
    assert.equal(await portalOrgFor(infoSessionAfterTransfer), null, "sessions minted between the transfer and the rollback end too");
    assert.equal(await resolveTierForWorkspace(EPIC), "workspace", "the entitlement is unchanged by the rollback");
    const again = await T.rollbackWorkspaceOwnershipTransfer({ orgId: EPIC, transferActionId, actor: superActor });
    assert.equal(again.ok ? "ok" : again.reason, "already_reverted");
  });

  test("concurrency: two simultaneous transfers with the same expected owner — exactly one applies, the other is refused", async () => {
    const input = { orgId: EPIC, expectedCurrentOwnerId: SUPER, newOwnerUserId: INFO, expectedTier: "growth", oldOwnerHomeOrgId: SYN1, actor: superActor };
    const results = await Promise.all([T.transferWorkspaceOwnership(input), T.transferWorkspaceOwnership(input)]);
    const oks = results.filter((r) => r.ok && !r.alreadyApplied).length;
    const others = results.filter((r) => !r.ok || r.alreadyApplied).map((r) => (r.ok ? "already_applied" : r.reason));
    assert.equal(oks, 1, JSON.stringify(results));
    assert.ok(["owner_changed", "already_applied"].includes(others[0]!), JSON.stringify(results));
    assert.deepEqual(await ownerState(), { owner: INFO, superHome: SYN1, infoHome: EPIC, members: [`${INFO}:owner`] });
  });

  test("no external host was ever reached", () => {
    assert.deepEqual(externalFetchCalls.filter((h) => !/posthog|i\.posthog/.test(h)), []);
  });
});
