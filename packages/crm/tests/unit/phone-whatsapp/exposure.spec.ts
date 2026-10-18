// Deployment is not exposure. These tests pin who sees Phone & WhatsApp: nobody by default, listed workspaces, or everyone on "*".
// Each refusal has a positive twin in the same test so that a broken function cannot pass as "correctly closed".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildNavGroups, type BuildNavInput } from "../../../src/components/layout/nav-config";
import { isPhoneWhatsappEnabled } from "../../../src/lib/phone-whatsapp/exposure";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("isPhoneWhatsappEnabled", () => {
  test("default off: unset, empty and whitespace-only lists enable nobody (positive twin: a listed id is enabled)", () => {
    for (const raw of [undefined, "", "   ", ",,,"]) assert.equal(isPhoneWhatsappEnabled(A, raw), false, String(raw));
    assert.equal(isPhoneWhatsappEnabled(A, A), true);
  });
  test("only listed workspaces are enabled; others, and substrings, are not", () => {
    assert.equal(isPhoneWhatsappEnabled(A, `${A},${B}`), true);
    assert.equal(isPhoneWhatsappEnabled(B, `${A},${B}`), true);
    assert.equal(isPhoneWhatsappEnabled(B, A), false);
    assert.equal(isPhoneWhatsappEnabled(A.slice(0, 20), A), false);
    assert.equal(isPhoneWhatsappEnabled(A, A.slice(0, 20)), false);
  });
  test("tolerates spaces and letter case in the list", () => {
    assert.equal(isPhoneWhatsappEnabled(A, `  ${A.toUpperCase()} , ${B} `), true);
  });
  test('"*" enables every real workspace id but never a missing or malformed one', () => {
    assert.equal(isPhoneWhatsappEnabled(A, "*"), true);
    for (const bad of [null, undefined, "", "x", "short", "has space in it", "a".repeat(80)]) assert.equal(isPhoneWhatsappEnabled(bad as string, "*"), false, String(bad));
  });
});

const labels = { contact: "Contact", deal: "Deal", intakeForm: "Intake form" };
const input = (sessionType: BuildNavInput["sessionType"], extra: Partial<BuildNavInput> = {}): BuildNavInput => ({
  sessionType, workspaceCount: 1, hiddenBlocks: [], isSuperAdmin: false, primaryOrgId: "org-primary", labels, ...extra,
});
const count = (groups: ReturnType<typeof buildNavGroups>) => groups.flatMap((g) => g.items).filter((i) => i.href === "/phone-whatsapp").length;

describe("navigation entry follows the same flag", () => {
  for (const sessionType of ["inside-client-workspace", "agency"] as const) {
    test(`${sessionType}: flag off or absent leaves today's navigation byte-identical; flag on adds exactly one entry`, () => {
      const base = buildNavGroups(input(sessionType));
      assert.equal(count(base), 0);
      assert.deepEqual(buildNavGroups(input(sessionType, { phoneWhatsappOn: false })), base);
      const on = buildNavGroups(input(sessionType, { phoneWhatsappOn: true }));
      assert.equal(count(on), 1);
      // the only difference is that one item, in SYSTEM, before Integrations
      const flat = (g: typeof on) => g.flatMap((x) => x.items.map((i) => i.href));
      assert.deepEqual(flat(on).filter((h) => h !== "/phone-whatsapp"), flat(base));
      const sys = on.find((g) => g.title === "SYSTEM");
      assert.ok(sys && sys.items.findIndex((i) => i.href === "/phone-whatsapp") === sys.items.findIndex((i) => i.href === "/integrations") - 1);
    });
  }
});

describe("the nav entry and the page are gated by the SAME function on the SAME field", () => {
  const root = process.cwd();
  // Whole-line comments are dropped so a commented-out call cannot satisfy the check. Block-comment stripping is deliberately NOT used on the
  // layout: it is a large file whose string literals contain "/*" and would swallow real code.
  const noLineComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const layout = noLineComments(readFileSync(join(root, "src/app/(dashboard)/layout.tsx"), "utf8"));
  const page = noLineComments(readFileSync(join(root, "src/app/(dashboard)/phone-whatsapp/page.tsx"), "utf8"));
  test("layout and page both call isPhoneWhatsappEnabled(orgId, process.env.PHONE_WHATSAPP_ENABLED_ORGS)", () => {
    const call = /isPhoneWhatsappEnabled\(\s*orgId\s*,\s*process\.env\.PHONE_WHATSAPP_ENABLED_ORGS\s*\)/;
    assert.match(layout, call);
    assert.match(page, call);
    assert.match(page, /notFound\(\)/);
    // control: the pattern is specific (an unrelated flag does not satisfy it), and the two variable names being compared are the same field
    assert.doesNotMatch("isDraftApprovalsOn({ SF_DRAFT_APPROVALS: process.env.SF_DRAFT_APPROVALS })", call);
  });
});
