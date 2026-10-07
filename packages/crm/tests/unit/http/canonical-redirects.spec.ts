import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalAppOrigin } from "../../../src/lib/http/app-hosts";
import { safeInternalRedirect } from "../../../src/lib/http/redirect-target";
import { tenantRedirectOrigin } from "../../../src/lib/http/tenant-redirect-origin";

test("operator origin uses configured app host, not an internal bind address", () => {
  const previous = { app: process.env.PLATFORM_APP_URL, hosts: process.env.APP_HOSTS };
  process.env.PLATFORM_APP_URL = "https://uplink.epic.dm";
  process.env.APP_HOSTS = "uplink.epic.dm";
  try {
    assert.equal(canonicalAppOrigin(), "https://uplink.epic.dm");
    const internalRequest = new Request("http://0.0.0.0:3000/switch-workspace", {
      headers: { host: "uplink.epic.dm", "x-forwarded-host": "uplink.epic.dm" },
    });
    assert.equal(new URL(internalRequest.url).origin, "http://0.0.0.0:3000");
    assert.equal(canonicalAppOrigin(), "https://uplink.epic.dm");
  } finally {
    if (previous.app === undefined) delete process.env.PLATFORM_APP_URL;
    else process.env.PLATFORM_APP_URL = previous.app;
    if (previous.hosts === undefined) delete process.env.APP_HOSTS;
    else process.env.APP_HOSTS = previous.hosts;
  }
});

test("portal origin preserves only the matching configured workspace host", async () => {
  const previous = { app: process.env.PLATFORM_APP_URL, hosts: process.env.APP_HOSTS, base: process.env.WORKSPACE_BASE_DOMAIN };
  process.env.PLATFORM_APP_URL = "https://uplink.epic.dm";
  process.env.APP_HOSTS = "uplink.epic.dm";
  process.env.WORKSPACE_BASE_DOMAIN = "clients.uplink.epic.dm";
  try {
    const request = (host: string) => new Request("http://0.0.0.0:3000/portal/pat/magic", {
      headers: { host, "x-forwarded-host": host },
    });
    const noCustomDomain = async () => false;
    assert.equal(await tenantRedirectOrigin(request("pat.clients.uplink.epic.dm"), "pat", noCustomDomain), "https://pat.clients.uplink.epic.dm");
    assert.equal(await tenantRedirectOrigin(request("quinn.clients.uplink.epic.dm"), "pat", noCustomDomain), "https://uplink.epic.dm");
    assert.equal(await tenantRedirectOrigin(request("evil.example"), "pat", noCustomDomain), "https://uplink.epic.dm");
    assert.equal(await tenantRedirectOrigin(request("evil.example:3000"), "pat", noCustomDomain), "https://uplink.epic.dm");
    assert.equal(await tenantRedirectOrigin(request("pat-owned.example"), "pat", async (host, slug) => host === "pat-owned.example" && slug === "pat"), "https://pat-owned.example");
    assert.equal(await tenantRedirectOrigin(request("pat-owned.example"), "quinn", async () => false), "https://uplink.epic.dm");
  } finally {
    if (previous.app === undefined) delete process.env.PLATFORM_APP_URL;
    else process.env.PLATFORM_APP_URL = previous.app;
    if (previous.hosts === undefined) delete process.env.APP_HOSTS;
    else process.env.APP_HOSTS = previous.hosts;
    if (previous.base === undefined) delete process.env.WORKSPACE_BASE_DOMAIN;
    else process.env.WORKSPACE_BASE_DOMAIN = previous.base;
  }
});

test("portal redirect targets reject external and host-escape forms", () => {
  const fallback = "/portal/pat";
  for (const target of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "javascript:alert(1)"]) {
    assert.equal(safeInternalRedirect(target, fallback), fallback, target);
  }
  assert.equal(safeInternalRedirect("/portal/pat?tab=service", fallback), "/portal/pat?tab=service");
});

test("all nine identified handlers use configured or tenant-validated origins", async () => {
  const root = fileURLToPath(new URL("../../../src/app/", import.meta.url));
  const targets = [
    ["switch-workspace/route.ts", "canonicalAppOrigin", "new URL(next, appOrigin)"],
    ["admin/[workspaceId]/route.ts", "canonicalAppOrigin", "new URL(\"/dashboard\", appOrigin)"],
    ["(public)/record/share-target/route.ts", "canonicalAppOrigin", "canonicalAppOrigin()), 303"],
    ["api/integrations/mcp/callback/route.ts", "canonicalAppOrigin", "resolveAppOrigin()"],
    ["api/stripe/connect/callback/route.ts", "canonicalAppOrigin", "appOrigin"],
    ["customer/[orgSlug]/demo/route.ts", "tenantRedirectOrigin", "safeInternalRedirect(result.redirectTo"],
    ["customer/[orgSlug]/magic/route.ts", "tenantRedirectOrigin", "safeInternalRedirect(result.redirectTo"],
    ["portal/[orgSlug]/magic/route.ts", "tenantRedirectOrigin", "new URL(redirectTo, origin)"],
    ["portal/[orgSlug]/support-magic/route.ts", "tenantRedirectOrigin", "safeInternalRedirect(result.redirectTo"],
  ] as const;
  for (const [path, resolver, binding] of targets) {
    const source = await readFile(`${root}/${path}`, "utf8");
    assert.ok(source.includes(`import { ${resolver} }`), `${path} imports ${resolver}`);
    assert.ok(source.includes(binding), `${path} applies its expected origin binding`);
    assert.ok(!/new URL\([\s\S]{0,240},\s*request\.url\s*\)/.test(source), `${path} does not use request.url as a redirect base`);
  }
});
