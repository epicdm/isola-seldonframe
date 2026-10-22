import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { shouldHideVendorMarketingPath } from "../../../src/lib/branding/platform";

// Route-level proof for the /docs restoration on a branded host (Uplink).
// The proxy gate is: (appHost || workspaceHost) && shouldHideVendorMarketingPath(pathname, name)
// -> 404 with an empty body. So "reachable" == "not hidden" for every REAL docs page on disk.

const crmRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appDir = join(crmRoot, "src", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

/** Real URL path of a page file; route groups "(x)" do not appear in the URL. */
function routeOf(file: string): string {
  const segs = relative(appDir, file).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
  return "/" + segs.join("/");
}

const docsRoutes = walk(appDir).map(routeOf).filter((r) => r === "/docs" || r.startsWith("/docs/")).sort();

// Decided in the same change as the restoration; every other docs page must be reachable.
const stillHidden = new Set(["/docs/billing/pricing", "/docs/billing/tiers", "/docs/billing/invoices", "/docs/mcp-servers", "/docs/quickstart"]);

describe("bundled /docs on a branded host", () => {
  it("positive control: the docs pages exist on disk (an empty list would make every assertion below vacuous)", () => {
    assert.ok(docsRoutes.length >= 30, `found ${docsRoutes.length} docs routes`);
    assert.ok(docsRoutes.includes("/docs"));
    assert.ok(docsRoutes.includes("/docs/getting-started/first-workspace"));
    assert.ok(docsRoutes.includes("/docs/billing/pricing"));
  });

  it("serves /docs and every docs article except the vendor-pricing and vendor-marketing ones", () => {
    for (const route of docsRoutes) {
      const hidden = shouldHideVendorMarketingPath(route, "Uplink");
      assert.equal(hidden, stillHidden.has(route), `${route} hidden=${hidden}`);
    }
  });

  it("serves the trailing-slash form too (Next 308s /docs/ -> /docs; the gate strips the slash itself)", () => {
    assert.equal(shouldHideVendorMarketingPath("/docs/", "Uplink"), false);
    assert.equal(shouldHideVendorMarketingPath("/docs/billing/pricing/", "Uplink"), true);
  });

  it("never hides anything on the upstream default brand (behaviour for SeldonFrame is unchanged)", () => {
    for (const route of docsRoutes) assert.equal(shouldHideVendorMarketingPath(route, "SeldonFrame"), false, route);
  });

  it("control: the other vendor marketing families stay hidden on a branded host", () => {
    for (const p of ["/pricing", "/blog", "/guides/x", "/compare/x", "/agencies", "/llms.txt", "/marketplace/build"]) {
      assert.equal(shouldHideVendorMarketingPath(p, "Uplink"), true, p);
    }
  });

  it("source guard: the proxy still applies the gate and still admits /docs/:path* to the matcher", () => {
    const proxy = readFileSync(join(crmRoot, "src", "proxy.ts"), "utf8");
    assert.match(proxy, /\(appHost \|\| hostWorkspaceSlug\) && shouldHideVendorMarketingPath\(pathname, resolvePlatformBranding\(\)\.name\)/);
    assert.ok(proxy.includes('"/docs/:path*"'));
  });

  it("every sidebar link either resolves to a real page or is deliberately hidden (no dead link is introduced)", () => {
    const sidebar = readFileSync(join(appDir, "docs", "docs-sidebar.tsx"), "utf8");
    const hrefs = [...sidebar.matchAll(/href: "(\/docs[^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 20, `found ${hrefs.length} sidebar links`);
    for (const h of hrefs) {
      assert.ok(docsRoutes.includes(h), `${h} has no page`);
    }
  });
});
