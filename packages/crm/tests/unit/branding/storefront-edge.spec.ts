import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { shouldServeBrandedRootPublicly, shouldHideVendorMarketingPath } from "../../../src/lib/branding/platform";

// Evaluate the small Traefik rule subset we use: Host(`x`), Path(`x`), PathPrefix(`x`), &&, ||, ().
function matches(rule: string, host: string, requestPath: string): boolean {
  const expr = rule
    .replace(/Host\(`([^`]+)`\)/g, (_m, h) => `(${JSON.stringify(host)}===${JSON.stringify(h)})`)
    .replace(/PathPrefix\(`([^`]+)`\)/g, (_m, p) => `(${JSON.stringify(requestPath)}.startsWith(${JSON.stringify(p)}))`)
    .replace(/Path\(`([^`]+)`\)/g, (_m, p) => `(${JSON.stringify(requestPath)}===${JSON.stringify(p)})`);
  if (/[^()&|!=.\s"\w\-/_:%?*,{}[\]+]/.test(expr.replace(/\s/g, ""))) throw new Error(`unexpected token in rule: ${expr}`);
  return new Function(`return (${expr});`)() as boolean;
}

const repoRoot = path.resolve(__dirname, "../../../../..");
const doc = parse(readFileSync(path.join(repoRoot, "docs/ops/uplink-storefront-edge.traefik.yaml"), "utf8")) as {
  http: { routers: Record<string, { rule: string; priority: number; middlewares?: string[] }> };
};
const router = doc.http.routers["uplink-storefront-public"];
const HOST = "uplink.epic.dm";

describe("storefront edge exception (Traefik rule)", () => {
  it("POSITIVE CONTROL: the matcher opens the storefront root and its static assets", () => {
    for (const p of ["/", "/_next/static/chunks/abc.js", "/_next/static/media/font.woff2", "/favicon.ico", "/manifest.webmanifest"]) {
      assert.equal(matches(router.rule, HOST, p), true, p);
    }
  });

  it("keeps operator and private routes OUT of the public router", () => {
    for (const p of [
      "/login", "/signup", "/dashboard", "/dashboard/agents", "/settings", "/settings/billing", "/contacts", "/forms",
      "/api/v1/forms", "/api/auth/signin", "/api/v1/admin/public-pilot", "/api/cron/automations", "/operators", "/admin",
      "/super-admin", "/_next/data/build/x.json", "/_next/image", "/switch-workspace", "/welcome", "/orgs/x",
      "//", "/ ", "/index", "/loginx/", "/_next/static", "/favicon.ico/x/../../login",
    ]) {
      assert.equal(matches(router.rule, HOST, p), false, p);
    }
  });

  it("is scoped to the app host only", () => {
    assert.equal(matches(router.rule, "uplinks-workspace-4816.uplink.epic.dm", "/"), false);
    assert.equal(matches(router.rule, "evil.example", "/"), false);
  });

  it("CONTROL: a sloppy prefix rule WOULD open operator routes, so this check can fail", () => {
    const sloppy = "Host(`uplink.epic.dm`) && PathPrefix(`/`)";
    assert.equal(matches(sloppy, HOST, "/login"), true);
  });

  it("attaches no middleware (public page) and outranks the restricted router", () => {
    assert.equal(router.middlewares, undefined);
    assert.ok(router.priority >= 10000);
  });

  it("app layer agrees: only the root is served publicly by the app proxy; operator paths are not", () => {
    assert.equal(shouldServeBrandedRootPublicly("/", "Uplink"), true);
    for (const p of ["/login", "/dashboard", "/settings", "/api/v1/forms", "/operators", "/admin"]) {
      assert.equal(shouldServeBrandedRootPublicly(p, "Uplink"), false, p);
    }
    // vendor marketing stays hidden on the branded host
    assert.equal(shouldHideVendorMarketingPath("/pricing", "Uplink"), true);
  });
});
