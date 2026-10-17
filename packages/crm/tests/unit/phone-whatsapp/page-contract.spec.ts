import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Structural guarantees for the read-only page and its nav entry. These are source-level checks on purpose: the page must not
// even contain the means for a browser to name a number, submit a change or run a command. (Tests run with cwd = packages/crm.)
const root = process.cwd();
// Comments may legitimately name the things the code must not contain, so checks run on code with comments removed.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const page = stripComments(readFileSync(join(root, "src/app/(dashboard)/phone-whatsapp/page.tsx"), "utf8"));
const view = stripComments(readFileSync(join(root, "src/app/(dashboard)/phone-whatsapp/view.tsx"), "utf8"));
const loading = stripComments(readFileSync(join(root, "src/app/(dashboard)/phone-whatsapp/loading.tsx"), "utf8"));
const libFiles = ["types.ts", "view-model.ts", "evidence-provider.ts", "link-store.ts", "service.ts", "server.ts"].map((f) => [f, stripComments(readFileSync(join(root, "src/lib/phone-whatsapp", f), "utf8"))] as const);

test("identity comes only from the server session: getOrgId is used; no params, searchParams, cookies, headers or request input", () => {
  assert.match(page, /await getOrgId\(\)/);
  for (const forbidden of [/searchParams/, /\bparams\b/, /cookies\(/, /headers\(/, /\bformData\b/, /NextRequest/]) assert.doesNotMatch(page, forbidden);
});

test("the page has no write path: no server action, no form, no input, no POST/PUT, and the destination button is disabled", () => {
  for (const [name, src] of [["page", page], ["view", view], ["loading", loading]] as const)
    for (const forbidden of [/["']use server["']/, /<form\b/i, /<input\b/i, /<select\b/i, /<textarea\b/i, /method=["']post/i, /fetch\(/, /action=/]) assert.doesNotMatch(src, forbidden, `${name} contains ${forbidden}`);
  assert.match(view, /data-testid="change-destination-disabled"/);
  assert.match(view, /<button type="button" disabled/);
  assert.doesNotMatch(view, /@\/db|@\/lib\/auth|next\/navigation/); // the view is pure rendering: no data or session access
});

test("no shell, process or filesystem access anywhere in the feature (no customer-entered command can run)", () => {
  for (const [name, src] of libFiles) for (const forbidden of [/child_process/, /\bexec\(/, /\bspawn\(/, /execSync/, /\beval\(/, /new Function\(/, /\bfs\./, /require\(["']fs/])
    assert.doesNotMatch(src, forbidden, `${name} contains ${forbidden}`);
});

test("the feature never writes to the database or to Meta/Magnus", () => {
  const server = libFiles.find(([n]) => n === "server.ts")![1];
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.execute\(/]) assert.doesNotMatch(server, forbidden);
  for (const [name, src] of libFiles) assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/, name);
});

test("the staff-assisted action is the only call to action and it is a link to the configured WhatsApp contact (wa.me), opened safely", () => {
  assert.match(view, /https:\/\/wa\.me\/\$\{waNumber\}/);
  assert.match(view, /rel="noopener noreferrer"/);
  assert.match(view, /data-testid="staff-action-missing"/); // honest when the contact is not configured
});

test("nav entry exists in both dashboard layouts and points at the page", () => {
  const nav = readFileSync(join(root, "src/components/layout/nav-config.ts"), "utf8");
  assert.equal((nav.match(/href: "\/phone-whatsapp", label: "Phone & WhatsApp"/g) ?? []).length, 2);
  const sidebar = readFileSync(join(root, "src/components/layout/sidebar-nav.tsx"), "utf8");
  assert.match(sidebar, /phone: Phone,/);
});
