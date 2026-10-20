// EPIC 2026-10-20 — tenant vs agency wording in the nav (pure; no database). An ordinary multi-workspace tenant gets neutral
// "Workspaces" wording; agency wording appears only with agencyMode (an authorised agency relationship). Routes are identical.
// The pre-existing nav-config.spec.ts cases run with agencyMode: true (agency operator).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { buildNavGroups, type BuildNavInput } from "../../../src/components/layout/nav-config";

const LABELS = {
  contact: { singular: "Customer", plural: "Customers" },
  deal: { singular: "Deal", plural: "Deals" },
  intakeForm: { singular: "Intake Form", plural: "Intake Forms" },
};
const input = (o: Partial<BuildNavInput> = {}): BuildNavInput => ({
  sessionType: "agency", workspaceCount: 2, hiddenBlocks: [], isSuperAdmin: false, primaryOrgId: "org-primary", labels: LABELS, ...o,
});
const items = (o: Partial<BuildNavInput>) => buildNavGroups(input(o)).flatMap((g) => g.items);

describe("multi-workspace TENANT (no authorised agency): neutral wording, same routes", () => {
  test("portfolio noun is 'Workspaces' (default when agencyMode is absent)", () => {
    const it = items({}).find((i) => i.href === "/clients");
    assert.equal(it?.label, "Workspaces");
  });
  test("inside another own workspace: back link reads '← All workspaces' and still switches to the primary org", () => {
    const back = items({ sessionType: "inside-client-workspace" }).find((i) => i.icon === "ChevronLeft");
    assert.equal(back?.label, "← All workspaces");
    assert.ok(back?.href.startsWith("/switch-workspace?to=org-primary"));
  });
  test("no agency wording anywhere in a tenant nav", () => {
    for (const o of [{}, { sessionType: "inside-client-workspace" as const }, { workspaceCount: 5 }]) {
      const labels = items(o).map((i) => i.label).join(" | ");
      assert.doesNotMatch(labels, /agency|Clients/i, labels);
    }
  });
});

describe("AUTHORISED AGENCY (agencyMode): agency wording preserved, same routes", () => {
  test("portfolio noun is 'Clients' and the back link is '← Back to agency'", () => {
    assert.equal(items({ agencyMode: true }).find((i) => i.href === "/clients")?.label, "Clients");
    assert.equal(items({ agencyMode: true, sessionType: "inside-client-workspace" }).find((i) => i.icon === "ChevronLeft")?.label, "← Back to agency");
  });
  test("control: tenant and agency navs have identical hrefs (wording-only change)", () => {
    for (const o of [{}, { sessionType: "inside-client-workspace" as const }]) {
      assert.deepEqual(items(o).map((i) => i.href), items({ ...o, agencyMode: true }).map((i) => i.href));
    }
  });
  test("single-workspace accounts are unchanged either way (no portfolio noun)", () => {
    assert.equal(items({ workspaceCount: 1 }).some((i) => i.href === "/clients"), false);
    assert.equal(items({ workspaceCount: 1, agencyMode: true }).some((i) => i.href === "/clients"), false);
  });
});

describe("wiring (source): every agency string on the tenant path is gated on agencyMode", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  test("dashboard header, add-workspace CTA, topbar switcher and layout threading", () => {
    const dash = read("src/app/(dashboard)/dashboard/page.tsx");
    assert.match(dash, /\{agencyMode \? "Agency dashboard" : "Workspaces"\}/);
    assert.match(dash, /\{agencyMode \? "Add client workspace" : "Add workspace"\}/);
    assert.match(dash, /agencyMode=\{agencyMode\}/);
    assert.match(dash, /const agencyMode = !isOperatorSession && user\?\.id \? await hasAuthorizedAgency\(user\.id\) : false;/);
    assert.match(read("src/components/layout/dashboard-topbar.tsx"), /\{agencyMode \? "Switch client workspace" : "Switch workspace"\}/);
    assert.match(read("src/components/dashboard/create-client-cta.tsx"), /const ctaLabel = agencyMode \? COPY\.cta : "Add workspace";/);
    const layout = read("src/app/(dashboard)/layout.tsx");
    assert.equal((layout.match(/agencyMode=\{agencyMode\}/g) || []).length, 2, "sidebar and topbar both receive agencyMode");
  });
});
