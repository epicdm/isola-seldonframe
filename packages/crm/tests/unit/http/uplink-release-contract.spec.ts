import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tryToParsePath } from "next/dist/lib/try-to-parse-path";

const repo = resolve(__dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");

test("proxy matcher uses valid explicit Next patterns for the same marketing paths", () => {
  const proxy = read("packages/crm/src/proxy.ts");
  const matcherBlock = proxy.slice(proxy.indexOf("export const config = {"));
  const matcher = [...matcherBlock.matchAll(/^\s+"([^"\n]+)",?$/gm)].map((match) => match[1]);
  const marketingPatterns = matcher.filter((path) =>
    ["pricing-public", "agencies", "blog", "guides", "charts", "docs", "demo", "compare", "alternatives", "best", "tools"]
      .some((prefix) => path === `/${prefix}/:path*`),
  );

  assert.equal(marketingPatterns.length, 11);
  for (const pattern of marketingPatterns) {
    assert.equal(tryToParsePath(pattern).error, undefined, `${pattern} should parse with the installed Next.js matcher parser`);
  }
  for (const [pattern, path] of [
    ["/alternative-to-:slug", "/alternative-to-foo"],
    ["/alternative-to-:slug.md", "/alternative-to-foo.md"],
    ["/:slug-pricing", "/foo-pricing"],
    ["/:slug-pricing.md", "/foo-pricing.md"],
    ["/home.md", "/home.md"],
  ]) {
    assert.ok(matcher.includes(pattern), `matcher should explicitly admit ${path}`);
    const parsed = tryToParsePath(pattern);
    assert.equal(parsed.error, undefined, `${pattern} should be valid`);
    assert.ok(new RegExp(parsed.regexStr!).test(path), `${pattern} should match ${path}`);
  }
});

test("Uplink Docker target bakes public defaults while upstream runner remains unbranded", () => {
  const dockerfile = read("Dockerfile");
  const workflow = read(".github/workflows/build-isola-seldonframe.yml");
  const runner = dockerfile.slice(dockerfile.indexOf("FROM node:22-bookworm-slim AS runner"), dockerfile.indexOf("FROM runner AS uplink"));
  const uplink = dockerfile.slice(dockerfile.indexOf("FROM runner AS uplink"));

  assert.match(runner, /ARG PLATFORM_NAME=SeldonFrame/);
  assert.match(runner, /ARG APP_HOSTS=/);
  assert.match(uplink, /ARG PLATFORM_NAME=Uplink/);
  assert.match(uplink, /ARG PLATFORM_OPERATOR_NAME=EPIC/);
  assert.match(uplink, /ARG APP_HOSTS=uplink\.epic\.dm/);
  assert.match(uplink, /PLATFORM_NAME=\$\{PLATFORM_NAME\}/);
  assert.match(uplink, /APP_HOSTS=\$\{APP_HOSTS\}/);
  assert.match(workflow, /target: uplink/);
  for (const key of [
    "NEXT_PUBLIC_APP_URL", "PLATFORM_NAME", "PLATFORM_OPERATOR_NAME", "PLATFORM_APP_URL",
    "PLATFORM_HOME_URL", "PLATFORM_SUPPORT_EMAIL", "PLATFORM_EMAIL_FROM_NAME",
    "PLATFORM_EMAIL_FOOTER", "WORKSPACE_BASE_DOMAIN", "APP_HOSTS", "PLATFORM_LOGO_URL",
    "PLATFORM_FAVICON_URL", "PLATFORM_SOURCE_URL", "SHOW_VENDOR_BRANDING",
  ]) {
    assert.match(workflow, new RegExp(`${key}=\\$\\{\\{ inputs\\.`));
  }
  assert.match(uplink, /SHOW_VENDOR_BRANDING=false/);
});

test("landing-page generation authenticates and tenant-matches before any workspace read or write", () => {
  const route = read("packages/crm/src/app/api/v1/workspace/generate-landing-page/route.ts");
  const guard = route.indexOf("guardApiRequest(request)");
  const body = route.indexOf("request.json()");
  const tenantCheck = route.indexOf("guard.orgId !== workspaceId");
  const workspaceRead = route.indexOf(".select({", body);
  const mutation = route.indexOf("seedInitialBlocks(");

  assert.ok(guard >= 0 && guard < body, "auth guard must run before parsing the request");
  assert.ok(tenantCheck > body && tenantCheck < workspaceRead, "tenant match must precede workspace reads");
  assert.ok(workspaceRead > tenantCheck && workspaceRead < mutation, "all workspace access must follow authorization");
  assert.match(route, /workspace_mismatch[\s\S]*status:\s*403/);
  assert.match(route, /guardApiRequest/);
});
