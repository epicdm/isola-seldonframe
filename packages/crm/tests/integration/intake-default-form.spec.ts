// EPIC 2026-10-21 (Lane A) — workspace default intake form, PATH test against a scratch Postgres through the
// production driver. Pages and routes are rendered and called, not their helpers. Seams: the operator session
// (getOrgId / requireAuth) and next/cache, because node:test has no Next runtime.
// The fixture copies EPIC's real shape (org 2a62ca68, read-only, 21 Oct): "Get my Personal Line" /personal-line-intake
// (updated 11 Oct) and the internal "Personal Line staff test feedback" /pl-staff-test-oct15, updated LATER (15 Oct),
// so a "most recently updated" pick chooses the staff form. A second workspace keeps the platform-seeded slug
// "intake", and its /intake must keep resolving as today.
// Every refusal or not-available assertion has a positive twin in the same run.
// Opt-in: needs NEON_LOCAL_HOST, DB_DRIVER=pg and ACTIVITY_SCOPE_DB_TEST=scratch, plus node --experimental-test-module-mocks.
// Run: node --experimental-test-module-mocks --import tsx --test tests/integration/intake-default-form.spec.ts
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, mock, test } from "node:test";
import { isValidElement, type ReactNode } from "react";
import { sql } from "drizzle-orm";

const enabled = process.env.ACTIVITY_SCOPE_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST && process.env.DB_DRIVER === "pg";

const ORG_E = "ee000000-0000-4000-8000-0000000000e1"; // EPIC-shaped workspace
const ORG_L = "ee000000-0000-4000-8000-0000000000e2"; // legacy seeded "intake" workspace
const F_CUSTOMER = "fe000000-0000-4000-8000-000000000001";
const F_STAFF = "fe000000-0000-4000-8000-000000000002";
const F_LEGACY = "fe000000-0000-4000-8000-000000000003";
const SLUG_E = "zz-intake-epic";
const SLUG_L = "zz-intake-legacy";
const DEFAULT = "(workspace default /intake)"; // rendered through app/workspace-intake/[orgSlug]
let currentOrg = ORG_E;

/** Walks a rendered server-component tree, returning every props object that carries `key`. */
function findProps(node: ReactNode, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) findProps(n, key, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as Record<string, unknown>;
  if (key in props) out.push(props);
  findProps(props.children as ReactNode, key, out);
  return out;
}

function isNotFound(error: unknown): boolean {
  const digest = (error as { digest?: unknown })?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
}

describe("workspace default intake form (scratch Postgres, rendered pages and routes)", { skip: !enabled && "set ACTIVITY_SCOPE_DB_TEST=scratch and DB_DRIVER=pg with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let Page: typeof import("@/app/forms/[id]/[formSlug]/page");
  let Alias: typeof import("@/app/workspace-intake/[orgSlug]/page");
  let Domain: typeof import("@/app/api/v1/public/domain/route");
  let Actions: typeof import("@/lib/forms/actions");
  let Settings: typeof import("@/app/(dashboard)/settings/workspace/page");

  const render = async (orgSlug: string, formSlug: string) => {
    try {
      const tree = formSlug === DEFAULT
        ? await Alias.default({ params: Promise.resolve({ orgSlug }) })
        : await Page.default({ params: Promise.resolve({ id: orgSlug, formSlug }) });
      return { notFound: false, formSlugs: findProps(tree as ReactNode, "formSlug").map((p) => p.formSlug) };
    } catch (error) {
      if (isNotFound(error)) return { notFound: true, formSlugs: [] as unknown[] };
      throw error;
    }
  };
  const domainDefaults = async (host: string) => {
    const res = await Domain.GET(new Request(`http://localhost/api/v1/public/domain?host=${host}`));
    return ((await res.json()) as { org: { defaults: { formSlug: string | null; bookingSlug: string } } }).org.defaults;
  };
  const settingsIntakeHrefs = async () => {
    const tree = await Settings.default();
    const hrefs = findProps(tree as ReactNode, "href").map((p) => String(p.href));
    // control: the Landing and Booking links are rendered and unchanged
    assert.ok(hrefs.includes(`https://${SLUG_E}.uplink.epic.dm/book`) && hrefs.includes(`https://${SLUG_E}.uplink.epic.dm/`), hrefs.join(" "));
    // (match the path, not the host: the fixture slug itself contains "intake")
    return hrefs.filter((h) => h.endsWith("/intake") || h === "/forms");
  };
  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };
  const orgSettings = async (orgId: string) =>
    ((await db.execute(sql`select settings from organizations where id = ${orgId}::uuid`)) as unknown as { rows: { settings: Record<string, unknown> }[] }).rows[0].settings;
  const formSettings = async (formId: string) =>
    ((await db.execute(sql`select settings from intake_forms where id = ${formId}::uuid`)) as unknown as { rows: { settings: Record<string, unknown> }[] }).rows[0].settings;

  before(async () => {
    process.env.WORKSPACE_BASE_DOMAIN = "uplink.epic.dm";
    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/lib/auth/helpers.ts")).href, {
      namedExports: {
        getOrgId: async () => currentOrg,
        requireAuth: async () => ({ user: { id: "op-user", orgId: currentOrg } }),
        getCurrentUser: async () => ({ id: "op-user", orgId: currentOrg }),
      },
    });
    mock.module("next/cache", { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn } });
    ({ db } = await import("@/db"));
    await db.execute(sql`delete from intake_forms where org_id in (${ORG_E}::uuid, ${ORG_L}::uuid)`);
    await db.execute(sql`delete from organizations where id in (${ORG_E}::uuid, ${ORG_L}::uuid)`);
    // EPIC's org settings carry unrelated keys that every write must preserve.
    await db.execute(sql`insert into organizations (id, name, slug, settings) values
      (${ORG_E}::uuid, 'EPIC-shaped', ${SLUG_E}, '{"booking":{"keep":true},"chatbot":{"keep":true},"phoneWhatsapp":"keep"}'::jsonb),
      (${ORG_L}::uuid, 'Legacy-shaped', ${SLUG_L}, '{}'::jsonb)`);
    await db.execute(sql`insert into intake_forms (id, org_id, name, slug, fields, settings, is_active, updated_at) values
      (${F_CUSTOMER}::uuid, ${ORG_E}::uuid, 'Get my Personal Line', 'personal-line-intake', '[{"key":"name","label":"Full name","type":"text","required":true}]'::jsonb, '{}'::jsonb, true, '2026-10-11T15:32:21Z'),
      (${F_STAFF}::uuid, ${ORG_E}::uuid, 'Personal Line staff test feedback (15 Oct)', 'pl-staff-test-oct15', '[{"key":"q","label":"Staff question","type":"text","required":false}]'::jsonb, '{"theme":"dark"}'::jsonb, true, '2026-10-15T13:05:41Z'),
      (${F_LEGACY}::uuid, ${ORG_L}::uuid, 'Intake', 'intake', '[{"key":"name","label":"Name","type":"text","required":true}]'::jsonb, '{"submitLabel":"Send"}'::jsonb, true, now())`);
    Page = await import("@/app/forms/[id]/[formSlug]/page");
    Alias = await import("@/app/workspace-intake/[orgSlug]/page");
    Domain = await import("@/app/api/v1/public/domain/route");
    Actions = await import("@/lib/forms/actions");
    Settings = await import("@/app/(dashboard)/settings/workspace/page");
  });

  test("fixture control: the staff form IS the most recently updated form (the old pick would choose it)", async () => {
    const r = (await db.execute(sql`select slug from intake_forms where org_id = ${ORG_E}::uuid order by updated_at desc limit 1`)) as unknown as { rows: { slug: string }[] };
    assert.equal(r.rows[0].slug, "pl-staff-test-oct15");
  });

  test("existing explicit URLs keep rendering their own form (customer AND staff), bogus slug is a 404", async () => {
    assert.deepEqual(await render(SLUG_E, "personal-line-intake"), { notFound: false, formSlugs: ["personal-line-intake"] });
    assert.deepEqual(await render(SLUG_E, "pl-staff-test-oct15"), { notFound: false, formSlugs: ["pl-staff-test-oct15"] });
    assert.equal((await render(SLUG_E, "zz-bogus-slug-404")).notFound, true);
  });

  test("nothing marked public: /intake is an honest 404 (never the staff form); domain route says no form", async () => {
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: true, formSlugs: [] });
    assert.equal((await domainDefaults(`${SLUG_E}.uplink.epic.dm`)).formSlug, null);
    assert.deepEqual(await settingsIntakeHrefs(), ["/forms"], "Settings must not advertise a dead /intake link");
  });

  test("a form slugged 'intake' is not public by its name: /intake is not available until it is marked public; its explicit URL keeps working", async () => {
    assert.deepEqual(await render(SLUG_L, "intake"), { notFound: false, formSlugs: ["intake"] });
    assert.deepEqual(await render(SLUG_L, DEFAULT), { notFound: true, formSlugs: [] });
    assert.equal((await domainDefaults(`${SLUG_L}.uplink.epic.dm`)).formSlug, null);
    currentOrg = ORG_L;
    await Actions.updateFormAction(fd({ formId: F_LEGACY, name: "Intake", slug: "intake", fields: '[{"key":"name","label":"Name","type":"text","required":true}]', publicIntake: "1" }));
    assert.deepEqual(await formSettings(F_LEGACY), { submitLabel: "Send", public: true });
    assert.deepEqual(await render(SLUG_L, DEFAULT), { notFound: false, formSlugs: ["intake"] }, "positive twin: marked public -> /intake");
  });

  test("tenant isolation: workspace L cannot mark or default workspace E's form", async () => {
    currentOrg = ORG_L;
    await Actions.updateFormAction(fd({ formId: F_STAFF, name: "hijack", slug: "hijack", fields: "[]", publicIntake: "1" }));
    assert.deepEqual(await formSettings(F_STAFF), { theme: "dark" });
    const r = (await db.execute(sql`select name, slug from intake_forms where id = ${F_STAFF}::uuid`)) as unknown as { rows: { name: string; slug: string }[] };
    assert.deepEqual(r.rows[0], { name: "Personal Line staff test feedback (15 Oct)", slug: "pl-staff-test-oct15" });
    await assert.rejects(Actions.setDefaultIntakeFormAction(fd({ defaultIntakeFormId: F_CUSTOMER })), /marked public/);
    assert.equal((await orgSettings(ORG_L)).defaultIntakeFormId, undefined);
    currentOrg = ORG_E;
  });

  test("owner marks the customer form public in the editor: it becomes /intake; other settings keys survive", async () => {
    currentOrg = ORG_E;
    await Actions.updateFormAction(fd({ formId: F_CUSTOMER, name: "Get my Personal Line", slug: "personal-line-intake", fields: '[{"key":"name","label":"Full name","type":"text","required":true}]', publicIntake: "1" }));
    assert.equal((await formSettings(F_CUSTOMER)).public, true);
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: false, formSlugs: ["personal-line-intake"] });
    assert.equal((await domainDefaults(`${SLUG_E}.uplink.epic.dm`)).formSlug, "personal-line-intake");
    assert.deepEqual(await settingsIntakeHrefs(), [`https://${SLUG_E}.uplink.epic.dm/intake`]);
    // an editor save WITHOUT the field leaves the marking untouched (callers predating it)
    await Actions.updateFormAction(fd({ formId: F_STAFF, name: "Personal Line staff test feedback (15 Oct)", slug: "pl-staff-test-oct15", fields: '[{"key":"q","label":"Staff question","type":"text","required":false}]' }));
    assert.deepEqual(await formSettings(F_STAFF), { theme: "dark" });
  });

  test("explicit default: a non-public (staff) form is refused; a public form is accepted; org settings keys preserved", async () => {
    currentOrg = ORG_E;
    await assert.rejects(Actions.setDefaultIntakeFormAction(fd({ defaultIntakeFormId: F_STAFF })), /marked public/);
    assert.equal((await orgSettings(ORG_E)).defaultIntakeFormId, undefined);
    await assert.rejects(Actions.setDefaultIntakeFormAction(fd({ defaultIntakeFormId: F_LEGACY })), /marked public/, "another workspace's form is not this workspace's");
    await Actions.setDefaultIntakeFormAction(fd({ defaultIntakeFormId: F_CUSTOMER }));
    const s = await orgSettings(ORG_E);
    assert.equal(s.defaultIntakeFormId, F_CUSTOMER);
    assert.deepEqual([s.booking, s.chatbot, s.phoneWhatsapp], [{ keep: true }, { keep: true }, "keep"]);
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: false, formSlugs: ["personal-line-intake"] });
  });

  test("two public forms: the explicit default decides; clearing it with two public forms gives the honest 404", async () => {
    currentOrg = ORG_E;
    await Actions.updateFormAction(fd({ formId: F_STAFF, name: "Personal Line staff test feedback (15 Oct)", slug: "pl-staff-test-oct15", fields: '[{"key":"q","label":"Staff question","type":"text","required":false}]', publicIntake: "1" }));
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: false, formSlugs: ["personal-line-intake"] }, "explicit default wins over 'most recent'");
    await Actions.setDefaultIntakeFormAction(fd({ defaultIntakeFormId: "" }));
    assert.equal((await orgSettings(ORG_E)).defaultIntakeFormId, undefined);
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: true, formSlugs: [] }, "ambiguous: no guess");
    // positive twin: un-mark the staff form -> single public form again
    await Actions.updateFormAction(fd({ formId: F_STAFF, name: "Personal Line staff test feedback (15 Oct)", slug: "pl-staff-test-oct15", fields: '[{"key":"q","label":"Staff question","type":"text","required":false}]', publicIntake: "0" }));
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: false, formSlugs: ["personal-line-intake"] });
  });

  test("pre-rendered (blueprint) form at /intake submits to ITSELF: the stale island slug is re-bound; no island -> fail closed", async () => {
    currentOrg = ORG_E;
    const island = JSON.stringify({ orgSlug: SLUG_E, formSlug: "intake" }).replace(/</g, "\\u003c");
    const html = `<div class="sf-frame">form</div><script type="application/json" id="sf-intake-data">${island}</script>`;
    await db.execute(sql`update intake_forms set content_html = ${html}, content_css = '.x{}' where id = ${F_CUSTOMER}::uuid`);
    const htmlOf = async (formSlug: string) => {
      const tree = formSlug === DEFAULT ? await Alias.default({ params: Promise.resolve({ orgSlug: SLUG_E }) }) : await Page.default({ params: Promise.resolve({ id: SLUG_E, formSlug }) });
      const inner = findProps(tree as ReactNode, "dangerouslySetInnerHTML").map((p) => (p.dangerouslySetInnerHTML as { __html: string }).__html).find((h) => h.includes("sf-intake-data"));
      return JSON.parse(/id="sf-intake-data">([\s\S]*?)<\/script>/.exec(inner ?? "")![1]) as { formSlug: string };
    };
    assert.equal((await htmlOf(DEFAULT)).formSlug, "personal-line-intake");
    assert.equal((await htmlOf("personal-line-intake")).formSlug, "intake", "control: the explicit URL serves the stored HTML byte-for-byte, as today");
    await db.execute(sql`update intake_forms set content_html = '<div>no island</div>' where id = ${F_CUSTOMER}::uuid`);
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: true, formSlugs: [] });
    await db.execute(sql`update intake_forms set content_html = null, content_css = null where id = ${F_CUSTOMER}::uuid`);
    assert.deepEqual(await render(SLUG_E, DEFAULT), { notFound: false, formSlugs: ["personal-line-intake"] });
  });

  test("booking default in the domain route is untouched by this change", async () => {
    assert.equal((await domainDefaults(`${SLUG_E}.uplink.epic.dm`)).bookingSlug, "default");
  });
});
