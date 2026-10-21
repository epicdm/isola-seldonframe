// EPIC 2026-10-21 — Port def-uplink-server-actions-caller-supplied-orgid-onboarding-and-portal-admin-2026-10-21.
// Server actions that took an orgId from the client and acted in it after only checking that it EXISTS:
//   app/start/actions.ts applyOnboardingMiniFormAction; lib/portal/admin-actions.ts setContactPortalAccessAction,
//   sendPortalInviteAction, uploadPortalDocumentAction, deletePortalDocumentAction.
// Each now requires that the signed-in user may act in that workspace (home workspace, member, owner/parent user, or owner of the
// partner agency it is attached to — the rules getOrgId() uses), and refuses a foreign workspace exactly like a missing one.
// Also proves that internal helpers which took a caller orgId are no longer exported from "use server" modules (so no server
// action id is generated for them), while the session-scoped actions next to them still are.
//
// Real actions against a scratch Postgres through the production driver. Seams: the NextAuth session (src/auth.ts), next/headers
// cookies, next/cache, and @vercel/blob put/del (recorded, never sent). Every refusal has a positive twin in the same run.
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set, DB_DRIVER=pg AND ACTIVITY_SCOPE_DB_TEST=scratch.
// Run: node --experimental-test-module-mocks --import tsx --test tests/integration/server-action-org-scope.spec.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST && process.env.DB_DRIVER === "pg";

const U = (n: number) => `ab000000-0000-4000-8000-00000000000${n}`;
const O = (n: number) => `bb000000-0000-4000-8000-00000000000${n}`;
const C = (n: number) => `cb000000-0000-4000-8000-00000000000${n}`;
const D = (n: number) => `db000000-0000-4000-8000-00000000000${n}`;
const USER_A = U(1); // operator, home workspace ORG_A
const USER_AG = U(2); // agency owner; home ORG_AGH, manages ORG_C through the partner agency
const USER_B = U(3); // owner of ORG_B (the victim)
const USER_M = U(4); // home ORG_B, member of ORG_A via org_members
const ORG_A = O(1), ORG_B = O(2), ORG_C = O(3), ORG_AGH = O(4);
const MISSING_ORG = O(9);
const AGENCY = "eb000000-0000-4000-8000-000000000001";
const CONTACT_A = C(1), CONTACT_B = C(2), CONTACT_C = C(3);
const DOC_A = D(1), DOC_B = D(2);

describe("server actions refuse a client-supplied workspace the caller cannot act in (scratch Postgres)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch and DB_DRIVER=pg with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let currentUser: string | null = USER_A;
  const blobPuts: string[] = [];
  const blobDels: string[] = [];
  const warns: string[] = [];
  const escaped: string[] = [];
  let start: typeof import("@/app/start/actions");
  let admin: typeof import("@/lib/portal/admin-actions");
  const n = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n);
  const orgRow = async (id: string) =>
    JSON.stringify(((await db.execute(sql`select to_jsonb(o) - 'updated_at' as r from organizations o where id = ${id}::uuid`)) as unknown as { rows: unknown[] }).rows);
  const as = (u: string | null) => { currentUser = u; };

  before(async () => {
    const crm = path.resolve(".");
    process.env.AUTH_SECRET = ["fixture", "orgscope", "secret", "only"].join("-");
    delete process.env.RESEND_API_KEY;
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => (currentUser ? { user: { id: currentUser } } : null), signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });
    mock.module("next/cache", { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } });
    // @vercel/blob is replaced at every specifier the action can load it through (bare, ESM entry, CJS entry): put/del are
    // recorded and answered locally. It uses undici's own fetch, so a globalThis.fetch stub would NOT contain it.
    const blobFake = {
      put: async (p: string) => { blobPuts.push(p); return { url: `https://blob.test/${p}`, downloadUrl: `https://blob.test/${p}`, pathname: p }; },
      del: async (p: string | string[]) => { blobDels.push(...(Array.isArray(p) ? p : [p])); },
    };
    const req = createRequire(path.join(crm, "src/lib/portal/admin-actions.ts"));
    const cjsEntry = req.resolve("@vercel/blob");
    const esmEntry = path.join(path.dirname(cjsEntry), "index.js");
    // the bare specifier already resolves to the ESM entry; the action itself is loaded through the CJS entry
    void esmEntry;
    for (const spec of ["@vercel/blob", pathToFileURL(cjsEntry).href]) {
      mock.module(spec, { namedExports: blobFake });
    }
    // Belt and braces: any outbound HTTP that still escapes is recorded and refused, and asserted to be zero below.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      escaped.push(String(input instanceof Request ? input.url : input));
      throw new Error("network disabled in this spec");
    }) as typeof fetch;
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); void realWarn; };

    ({ db } = await import("@/db"));
    const orgs = [ORG_A, ORG_B, ORG_C, ORG_AGH];
    const inOrgs = sql.raw(orgs.map((o) => `'${o}'`).join(","));
    await db.execute(sql`delete from portal_documents where org_id in (${inOrgs})`);
    await db.execute(sql`delete from org_members where org_id in (${inOrgs})`);
    await db.execute(sql`delete from contacts where org_id in (${inOrgs})`);
    await db.execute(sql`update organizations set parent_agency_id = null where id in (${inOrgs})`);
    await db.execute(sql`delete from partner_agencies where id = ${AGENCY}::uuid`);
    await db.execute(sql`delete from users where id in (${USER_A}::uuid, ${USER_AG}::uuid, ${USER_B}::uuid, ${USER_M}::uuid)`);
    await db.execute(sql`delete from organizations where id in (${inOrgs})`);
    const paid = sql.raw(`'{"tier":"workspace","status":"active","stripeCustomerId":"cus_ob","stripeSubscriptionId":"sub_ob","stripePriceId":"price_workspace_month"}'::jsonb`);
    for (const [id, slug] of [[ORG_A, "ob-a"], [ORG_B, "ob-b"], [ORG_C, "ob-c"], [ORG_AGH, "ob-agh"]]) {
      await db.execute(sql`insert into organizations (id, name, slug, plan, subscription) values (${id}::uuid, ${slug}, ${slug}, 'workspace', ${paid})`);
    }
    await db.execute(sql`insert into users (id, org_id, name, email) values
      (${USER_A}::uuid, ${ORG_A}::uuid, 'A op', 'a-ob@scope.test'), (${USER_AG}::uuid, ${ORG_AGH}::uuid, 'Agency', 'ag-ob@scope.test'),
      (${USER_B}::uuid, ${ORG_B}::uuid, 'B owner', 'b-ob@scope.test'), (${USER_M}::uuid, ${ORG_B}::uuid, 'Member', 'm-ob@scope.test')`);
    await db.execute(sql`update organizations set owner_id = ${USER_A}::uuid where id = ${ORG_A}::uuid`);
    await db.execute(sql`update organizations set owner_id = ${USER_B}::uuid where id = ${ORG_B}::uuid`);
    await db.execute(sql`update organizations set owner_id = ${USER_AG}::uuid where id = ${ORG_AGH}::uuid`);
    await db.execute(sql`insert into org_members (org_id, user_id) values (${ORG_A}::uuid, ${USER_M}::uuid)`);
    await db.execute(sql`insert into partner_agencies (id, owner_user_id, owner_workspace_id, name, slug) values (${AGENCY}::uuid, ${USER_AG}::uuid, ${ORG_AGH}::uuid, 'Agency', 'ob-agency')`);
    await db.execute(sql`update organizations set parent_agency_id = ${AGENCY}::uuid where id = ${ORG_C}::uuid`);
    await db.execute(sql`insert into contacts (id, org_id, first_name, email, portal_access_enabled) values
      (${CONTACT_A}::uuid, ${ORG_A}::uuid, 'Ann', 'ann-ob@scope.test', true), (${CONTACT_B}::uuid, ${ORG_B}::uuid, 'Bea', 'bea-ob@scope.test', true),
      (${CONTACT_C}::uuid, ${ORG_C}::uuid, 'Cal', 'cal-ob@scope.test', true)`);
    await db.execute(sql`insert into portal_documents (id, org_id, contact_id, file_name, file_size, mime_type, blob_url, blob_path, uploaded_by_user_id) values
      (${DOC_A}::uuid, ${ORG_A}::uuid, ${CONTACT_A}::uuid, 'a.pdf', 1, 'application/pdf', 'https://blob.test/a', 'org/a/a.pdf', ${USER_A}::uuid),
      (${DOC_B}::uuid, ${ORG_B}::uuid, ${CONTACT_B}::uuid, 'b.pdf', 1, 'application/pdf', 'https://blob.test/b', 'org/b/b.pdf', ${USER_B}::uuid)`);
    start = await import("@/app/start/actions");
    admin = await import("@/lib/portal/admin-actions");
  });

  test("fixture control: victim rows exist; all ids distinct; both workspaces pass the portal plan gate", async () => {
    assert.equal(await n(sql`select ((select count(*) from organizations where id = ${ORG_B}::uuid) + (select count(*) from contacts where id = ${CONTACT_B}::uuid and org_id = ${ORG_B}::uuid) + (select count(*) from portal_documents where id = ${DOC_B}::uuid and org_id = ${ORG_B}::uuid))::int as n`), 3);
    assert.equal(new Set([ORG_A, ORG_B, ORG_C, ORG_AGH, MISSING_ORG]).size, 5);
    const { checkPortalPlanGate } = await import("@/lib/portal/plan-gate");
    assert.equal((await checkPortalPlanGate(ORG_A)).allowed, true, "plan gate fixture");
    assert.equal((await checkPortalPlanGate(ORG_B)).allowed, true, "plan gate fixture");
  });

  test("userCanAccessOrg: home, member, owner and agency owner admitted; foreign and missing refused", async () => {
    const { userCanAccessOrg } = await import("@/lib/auth/helpers");
    assert.deepEqual(
      await Promise.all([[USER_A, ORG_A], [USER_M, ORG_A], [USER_AG, ORG_C], [USER_B, ORG_B], [USER_A, ORG_B], [USER_AG, ORG_B], [USER_A, MISSING_ORG], [USER_A, ORG_C]].map(([u, o]) => userCanAccessOrg(u, o))),
      [true, true, true, true, false, false, false, false],
    );
  });

  test("applyOnboardingMiniFormAction: agency owner on its client workspace -> ok (positive control); foreign and missing -> org_not_found, victim unchanged", async () => {
    as(USER_AG);
    const own = await start.applyOnboardingMiniFormAction({ orgId: ORG_C, services_text: "Install, Repair" });
    assert.equal(own.ok, true, JSON.stringify(own));
    const before = await orgRow(ORG_B);
    assert.deepEqual(await start.applyOnboardingMiniFormAction({ orgId: ORG_B, services_text: "Hijacked" }), { ok: false, error: "org_not_found" });
    assert.deepEqual(await start.applyOnboardingMiniFormAction({ orgId: MISSING_ORG, services_text: "x" }), { ok: false, error: "org_not_found" });
    assert.equal(await orgRow(ORG_B), before);
  });

  test("setContactPortalAccessAction: own and agency workspaces flip (positive controls); foreign -> org_not_found, contact untouched", async () => {
    as(USER_A);
    assert.deepEqual(await admin.setContactPortalAccessAction({ orgId: ORG_A, contactId: CONTACT_A, enabled: false }), { ok: true, enabled: false });
    as(USER_AG);
    assert.deepEqual(await admin.setContactPortalAccessAction({ orgId: ORG_C, contactId: CONTACT_C, enabled: false }), { ok: true, enabled: false });
    as(USER_A);
    assert.deepEqual(await admin.setContactPortalAccessAction({ orgId: ORG_B, contactId: CONTACT_B, enabled: false }), { ok: false, reason: "org_not_found" });
    assert.deepEqual(await admin.setContactPortalAccessAction({ orgId: MISSING_ORG, contactId: CONTACT_B, enabled: false }), { ok: false, reason: "org_not_found" });
    assert.equal(await n(sql`select count(*)::int as n from contacts where id = ${CONTACT_B}::uuid and portal_access_enabled = true`), 1);
    // restore A for the invite test
    await db.execute(sql`update contacts set portal_access_enabled = true where id in (${CONTACT_A}::uuid, ${CONTACT_C}::uuid)`);
  });

  test("sendPortalInviteAction: own workspace reaches link minting (positive control); foreign gets the missing-org silent no-op", async () => {
    as(USER_A);
    // independent of the previous test's outcome: every contact starts with portal access on
    await db.execute(sql`update contacts set portal_access_enabled = true where id in (${CONTACT_A}::uuid, ${CONTACT_B}::uuid, ${CONTACT_C}::uuid)`);
    warns.length = 0;
    assert.deepEqual(await admin.sendPortalInviteAction({ orgSlug: "ob-a", email: "ann-ob@scope.test" }), { ok: true });
    assert.ok(warns.some((w) => w.includes("resend_not_configured")), `own invite should pass the gate and mint: ${warns.join(" | ")}`);
    warns.length = 0;
    assert.deepEqual(await admin.sendPortalInviteAction({ orgSlug: "ob-b", email: "bea-ob@scope.test" }), { ok: true });
    assert.ok(warns.some((w) => w.includes("silent_no_op: org_not_found")), warns.join(" | "));
    assert.ok(!warns.some((w) => w.includes("resend_not_configured")), "a foreign invite must stop before minting");
  });

  test("uploadPortalDocumentAction: own workspace uploads (positive control); foreign orgId -> org_not_found, nothing stored", async () => {
    as(USER_A);
    const fd = (org: string, contact: string) => {
      const f = new FormData();
      f.set("orgId", org);
      f.set("contactId", contact);
      f.set("file", new File(["hello"], "note.txt", { type: "text/plain" }));
      return f;
    };
    const own = await admin.uploadPortalDocumentAction(fd(ORG_A, CONTACT_A));
    assert.equal(own.ok, true, JSON.stringify(own));
    assert.equal(blobPuts.length, 1);
    const putsBefore = blobPuts.length;
    assert.deepEqual(await admin.uploadPortalDocumentAction(fd(ORG_B, CONTACT_B)), { ok: false, reason: "org_not_found" });
    assert.equal(blobPuts.length, putsBefore);
    assert.equal(await n(sql`select count(*)::int as n from portal_documents where org_id = ${ORG_B}::uuid`), 1);
  });

  test("deletePortalDocumentAction: own document deleted (positive control); foreign document -> org_not_found, row and blob kept", async () => {
    as(USER_A);
    assert.deepEqual(await admin.deletePortalDocumentAction({ documentId: DOC_B, orgId: ORG_B }), { ok: false, reason: "org_not_found" });
    assert.equal(await n(sql`select count(*)::int as n from portal_documents where id = ${DOC_B}::uuid`), 1);
    assert.equal(blobDels.length, 0);
    assert.deepEqual(await admin.deletePortalDocumentAction({ documentId: DOC_A, orgId: ORG_A }), { ok: true });
    assert.equal(await n(sql`select count(*)::int as n from portal_documents where id = ${DOC_A}::uuid`), 0);
    assert.deepEqual(blobDels, ["org/a/a.pdf"]);
    assert.deepEqual(escaped, [], "no request may leave the process");
  });

  test("internal helpers that take a caller orgId are no longer exported from \"use server\" modules; the scoped actions still are", async () => {
    const surfaces: Array<[string, string[], string[]]> = [
      ["src/lib/portal/auth.ts", ["createPortalMagicLink"], ["requirePortalSessionForOrg"]],
      ["src/lib/integrations/actions.ts", ["updateIntegration", "disconnectIntegration"], ["updateIntegrationAction", "disconnectIntegrationAction"]],
      ["src/lib/marketplace/actions.ts", ["enableBlockForOrg", "finalizeBlockPurchaseFromWebhook", "finalizeSoulPurchaseFromWebhook", "provisionBuyerAgentFromPurchaseRow"], ["finalizeMarketplacePurchaseReturnAction", "purchaseMarketplaceBlockAction"]],
      ["src/app/start/actions.ts", ["getAgencySlug", "getOrCreateOnboardingCallBookingSlug"], ["applyOnboardingMiniFormAction", "createLiveSellCheckoutAction"]],
    ];
    for (const [file, gone, kept] of surfaces) {
      const src = readFileSync(path.resolve(file), "utf8");
      assert.ok(/^\s*(\/\/[^\n]*\n\s*)*"use server";/.test(src), `${file} is a "use server" module`);
      const exported = new Set([...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]));
      const reexported = [...src.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()));
      for (const k of kept) assert.ok(exported.has(k), `positive control: ${file} still exports ${k}`);
      for (const g of gone) assert.ok(!exported.has(g) && !reexported.includes(g), `${file} must not export ${g}`);
    }
    for (const file of ["src/lib/portal/magic-link.ts", "src/lib/marketplace/fulfillment.ts", "src/app/start/onboarding-slugs.ts"]) {
      assert.ok(!/^\s*(\/\/[^\n]*\n\s*)*["']use server["'];?/.test(readFileSync(path.resolve(file), "utf8")), `${file} must be a plain server module (no directive)`);
    }
  });

  test("moved createPortalMagicLink still mints a link for an own contact (positive control) and refuses a contact of another workspace", async () => {
    const { createPortalMagicLink } = await import("@/lib/portal/magic-link");
    const link = await createPortalMagicLink({ orgSlug: "ob-a", contactId: CONTACT_A });
    assert.match(link.inviteUrl, /\/customer\/ob-a\/magic\?token=/);
    await assert.rejects(createPortalMagicLink({ orgSlug: "ob-a", contactId: CONTACT_B }));
  });
});
