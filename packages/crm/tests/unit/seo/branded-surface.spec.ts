import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { brandedPublicSurface } from "../../../src/lib/seo/public-origins";

const brandedEnv = { PLATFORM_NAME: "Uplink", PLATFORM_APP_URL: "https://uplink.epic.dm", PLATFORM_HOME_URL: "https://uplink.epic.dm", WORKSPACE_BASE_DOMAIN: "uplink.epic.dm" };
const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("a workspace host advertises its own origin; the app host and unknown hosts advertise the platform origin", () => {
  const previous = process.env.WORKSPACE_BASE_DOMAIN;
  process.env.WORKSPACE_BASE_DOMAIN = "uplink.epic.dm";
  try {
    const ws = brandedPublicSurface("uplinks-workspace-4816.uplink.epic.dm", brandedEnv);
    assert.deepEqual(ws, { branded: true, workspaceSlug: "uplinks-workspace-4816", origin: "https://uplinks-workspace-4816.uplink.epic.dm" });
    const app = brandedPublicSurface("uplink.epic.dm", brandedEnv);
    assert.equal(app.workspaceSlug, null);
    assert.equal(app.origin, "https://uplink.epic.dm");
    assert.equal(brandedPublicSurface("elsewhere.example", brandedEnv).workspaceSlug, null);
    assert.equal(brandedPublicSurface(null, brandedEnv).workspaceSlug, null);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_BASE_DOMAIN; else process.env.WORKSPACE_BASE_DOMAIN = previous;
  }
});

test("an unbranded SeldonFrame deployment keeps the upstream behaviour (no host-specific surface)", () => {
  const surface = brandedPublicSurface("some-slug.app.seldonframe.com", {});
  assert.equal(surface.branded, false);
  assert.equal(surface.workspaceSlug, null);
  assert.equal(surface.origin, "https://www.seldonframe.com");
});

test("the three vendor markdown paths are hidden on branded builds by a build-time rewrite (the proxy matcher stays a whitelist)", () => {
  const config = read("next.config.ts");
  for (const p of ["/ai-agents.md", "/build.md", "/SKILL.md"]) assert.ok(config.includes(`"${p}"`), `${p} missing from the branded rewrite list`);
  assert.match(config, /brandedBuild/);
  assert.match(config, /beforeFiles/);
  const proxy = read("src/proxy.ts");
  assert.ok(!proxy.includes('"/SKILL.md",'), "the proxy matcher must NOT capture /SKILL.md (upstream regression guard)");
});

test("robots and sitemap are host-aware on branded deployments", () => {
  assert.match(read("src/app/robots.txt/route.ts"), /surface\.branded \? surface\.origin : siteBaseUrl\(\)/);
  assert.match(read("src/app/sitemap.ts"), /surface\.workspaceSlug\s*\?\s*\[\{ url: `\$\{surface\.origin\}\/`/);
});
