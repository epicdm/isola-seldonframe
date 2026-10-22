import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { shouldHideVendorMarketingPath } from "../../../src/lib/branding/platform";

// Content guards for the REACHABLE docs pages on Uplink: upstream instructions that do not apply are flagged with ONE
// shared notice, operational hosts are Uplink's where they were verified, no page claims an integration is configured
// for EPIC, and every internal link resolves to a real page, a verified app route, or is removed.

const crmRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appDir = join(crmRoot, "src", "app");
const docsDir = join(appDir, "docs");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}
function routeOf(file: string): string {
  const segs = relative(appDir, file).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
  return "/" + segs.join("/");
}
const allPages = walk(docsDir).concat(walk(join(appDir, "(marketing)", "docs")));
const reachable = allPages.filter((f) => !shouldHideVendorMarketingPath(routeOf(f), "Uplink"));
const read = (f: string) => readFileSync(f, "utf8");
const shell = readFileSync(join(docsDir, "article-shell.tsx"), "utf8");

// Page (relative to src/app/docs) -> the notice kinds it must carry.
const NOTICE_PAGES: Record<string, string[]> = {
  "page.tsx": ["signup", "plans", "keys", "mcp", "domains"],
  "learn/page.tsx": ["signup"],
  "getting-started/first-workspace/page.tsx": ["signup", "mcp", "hosts"],
  "getting-started/demo/page.tsx": ["signup", "mcp", "hosts"],
  "getting-started/what-is-seldonframe/page.tsx": ["signup", "plans", "hosts"],
  "getting-started/connect-claude-code/page.tsx": ["mcp", "plans", "hosts"],
  "agents/build-chatbot/page.tsx": ["mcp"],
  "agents/update-agent/page.tsx": ["mcp"],
  "agents/eval-gate/page.tsx": ["mcp"],
  "agents/voice-sms/page.tsx": ["keys"],
  "agents/embed/page.tsx": ["hosts"],
  "integrations/stripe/page.tsx": ["keys"],
  "integrations/twilio/page.tsx": ["keys"],
  "integrations/resend/page.tsx": ["keys"],
  "integrations/google-calendar/page.tsx": ["keys"],
  "pages/forms/page.tsx": ["hosts"],
  "pages/booking/page.tsx": ["keys", "hosts"],
  "automation/reminders/page.tsx": ["keys"],
  "automation/email/page.tsx": ["keys"],
  "automation/rules/page.tsx": ["keys"],
  "pages/public-pages/page.tsx": ["signup", "hosts"],
  "customers/customer-portal/page.tsx": ["domains", "hosts", "keys"],
  "your-business/custom-domains/page.tsx": ["domains", "hosts"],
  "your-business/team/page.tsx": ["plans"],
  "your-business/workspaces/page.tsx": ["plans"],
};

// The claim detector. Exported shape is tested against a synthetic claim (positive control) below.
const CLAIM = /\b(stripe|twilio|resend|google calendar|voice|sms|email|mcp|claude code)\b[^.\n]{0,80}\b(is|are) (already |now |fully )?(configured|connected|enabled|set up|ready to use|available)( for| on| in) (epic|uplink|you)\b/i;

// Internal app routes referenced by the docs, each READ on the live app 2026-10-22 (200, or 307 to /login = exists).
const VERIFIED_APP_ROUTES = new Set([
  "/agents", "/settings/integrations", "/settings/billing", "/signup", "/login", "/settings/branding", "/automations",
  "/templates", "/settings/team", "/settings/integrations/llm", "/landing", "/contacts", "/settings/portal",
  "/settings/pipeline", "/settings/fields", "/settings/domains", "/orgs/new", "/forms", "/emails", "/deals", "/bookings",
]);

describe("upstream-instruction notices on reachable docs pages", () => {
  it("positive control: the page set is real (an empty set would make every check below vacuous)", () => {
    assert.ok(reachable.length >= 30, `reachable=${reachable.length}`);
    for (const rel of Object.keys(NOTICE_PAGES)) assert.ok(reachable.some((f) => f.endsWith(rel.replace("/", sep))), rel);
  });

  it("the notice wording lives in ONE shared constant with every kind the pages use", () => {
    const kinds = new Set(Object.values(NOTICE_PAGES).flat());
    for (const k of kinds) assert.ok(new RegExp(`^  ${k}: \``, "m").test(shell), `UPSTREAM_NOTICES.${k}`);
    assert.ok(shell.includes("export function UpstreamNotice"));
    // no page re-states the notice text itself
    for (const f of reachable) assert.equal(read(f).includes("not applicable to EPIC"), false, f);
  });

  it("each listed page renders the notice with exactly its kinds (and imports it)", () => {
    for (const [rel, kinds] of Object.entries(NOTICE_PAGES)) {
      const src = readFileSync(join(docsDir, rel), "utf8");
      assert.ok(/UpstreamNotice[^;]*from "(\.\/|(\.\.\/)+)article-shell"/.test(src), `${rel}: import`);
      const m = src.match(/<UpstreamNotice kinds=\{\[([^\]]*)\]\} \/>/);
      assert.ok(m, `${rel}: <UpstreamNotice>`);
      assert.deepEqual(m![1].split(",").map((s) => s.trim().replace(/"/g, "")), kinds, rel);
    }
  });

  it("the notice never claims an integration is configured or usable for EPIC (say 'check with EPIC')", () => {
    const block = shell.slice(shell.indexOf("export const UPSTREAM_NOTICES"), shell.indexOf("export function UpstreamNotice"));
    assert.ok(block.length > 500);
    assert.equal(CLAIM.test(block), false);
    assert.equal(/\bconfigured for (EPIC|Uplink)\b/i.test(block), false);
    for (const k of ["keys", "mcp", "domains", "hosts"]) {
      const line = block.split("\n").find((l) => l.startsWith(`  ${k}: `)) ?? "";
      assert.ok(/check with EPIC/i.test(line), `${k} must say check with EPIC`);
    }
  });

  it("no reachable page claims an integration is configured for EPIC (control: the detector fires on a planted claim)", () => {
    assert.ok(CLAIM.test("Stripe is already configured for EPIC and ready."), "positive control");
    assert.ok(CLAIM.test("Twilio SMS are connected on Uplink"), "positive control 2");
    for (const f of reachable) assert.equal(CLAIM.test(read(f)), false, f);
  });

  it("verified hosts only: no reachable page still shows the upstream app host or the non-existent /embed.js path", () => {
    for (const f of reachable) {
      const s = read(f);
      assert.equal(s.includes("app.seldonframe.com"), false, `${f}: upstream host`);
      assert.equal(/\.(com|dm)\/embed\.js/.test(s), false, `${f}: root /embed.js (404 on Uplink)`);
      assert.equal(/data-(position|greeting-delay|agent|context)\b/.test(s.replace(/<code>data-[a-z-]+<\/code>/g, "")), false, `${f}: data-* options the embed route does not read`);
    }
    const embed = readFileSync(join(docsDir, "agents", "embed", "page.tsx"), "utf8");
    assert.ok(embed.includes("https://uplink.epic.dm/api/v1/public/agent/WORKSPACE--AGENT/embed.js"));
    // the route that serves it exists in this tree (what the host/path was verified against)
    assert.ok(statSync(join(appDir, "api", "v1", "public", "agent", "[slug]", "embed.js", "route.ts")).isFile());
    const embedText = embed.replace(/<code>data-[a-z-]+<\/code>/g, "");
    assert.equal(/wired automatically|known\s+email if you passed/.test(embedText), false, "embed: unverified automatic wiring / data-context claims");
    const domains = readFileSync(join(docsDir, "your-business", "custom-domains", "page.tsx"), "utf8");
    assert.equal(/vercel-dns|76\.76\.21\.21|SSL is automatic|takes 5 minutes/.test(domains), false, "custom-domains: upstream/Vercel DNS values and unverified SSL promises");
    const mcp = readFileSync(join(docsDir, "getting-started", "connect-claude-code", "page.tsx"), "utf8");
    assert.ok(mcp.includes("--url https://uplink.epic.dm/api/mcp/v1"));
    assert.ok(statSync(join(appDir, "api", "mcp", "v1", "route.ts")).isFile());
  });

  it("internal links: /docs targets exist and are public; anchors on the home exist or are page-level; app routes are in the verified set; removed links stay removed", () => {
    const docsRoutes = new Set(allPages.map(routeOf));
    const bad: string[] = [];
    for (const f of reachable) {
      const src = read(f);
      for (const m of src.matchAll(/href[=:] ?\{?"(\/[^"]*)"/g)) {
        const h = m[1];
        const path = h.split("#")[0].split("?")[0];
        if (path === "/" && h.includes("#")) { bad.push(`${routeOf(f)} -> ${h} (root anchor)`); continue; }
        if (path === "/docs" || path.startsWith("/docs/")) {
          if (!docsRoutes.has(path) || shouldHideVendorMarketingPath(path, "Uplink")) bad.push(`${routeOf(f)} -> ${h}`);
        } else if (!VERIFIED_APP_ROUTES.has(path)) bad.push(`${routeOf(f)} -> ${h} (unverified app route)`);
      }
    }
    assert.deepEqual(bad, []);
    const home = readFileSync(join(docsDir, "page.tsx"), "utf8");
    const ids = new Set([...home.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));
    const deadAnchors = new Set<string>();
    for (const f of reachable) for (const m of read(f).matchAll(/href[=:] ?\{?"\/docs#([a-z0-9-]+)"/g)) if (!ids.has(m[1])) deadAnchors.add(m[1]);
    // Known follow-up: upstream placeholder anchors on the docs home (the page loads; the anchor just does not scroll). A NEW one fails.
    assert.deepEqual([...deadAnchors].sort(), ["agents", "api", "automations", "booking-pages", "case-studies", "claude-code", "contacts", "email", "google", "reminders", "soul", "stripe", "suppression", "templates", "twilio", "webhooks", "workspaces"]);
    assert.ok(ids.has("popular") && ids.has("learn"), "control: the home's real ids are read");
    // control: the checker would flag the three links this change removed
    for (const gone of ['href="/emails/templates"', 'href="/#hero-form"', 'href="/docs/billing/tiers"']) {
      assert.ok(!reachable.some((f) => read(f).includes(gone)), gone);
    }
    assert.equal(VERIFIED_APP_ROUTES.has("/emails/templates"), false);
  });
});
