import assert from "node:assert/strict";
import { it } from "node:test";
import { NextRequest } from "next/server";

it("lets the configured branded app root reach its public page", async () => {
  const previous = {
    PLATFORM_NAME: process.env.PLATFORM_NAME,
    PLATFORM_APP_URL: process.env.PLATFORM_APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    APP_HOSTS: process.env.APP_HOSTS,
    WORKSPACE_BASE_DOMAIN: process.env.WORKSPACE_BASE_DOMAIN,
  };
  process.env.PLATFORM_NAME = "Uplink";
  process.env.PLATFORM_APP_URL = "https://uplink.epic.dm";
  process.env.NEXT_PUBLIC_APP_URL = "https://uplink.epic.dm";
  process.env.APP_HOSTS = "uplink.epic.dm";
  process.env.WORKSPACE_BASE_DOMAIN = "uplink.epic.dm";

  try {
    const { proxy } = await import("../../../src/proxy");
    const request = (path: string) => new NextRequest(`https://uplink.epic.dm${path}`, { headers: { host: "uplink.epic.dm" } });
    const response = await proxy(
      request("/"),
      undefined as never,
    );
    assert.equal(response?.headers.get("x-middleware-next"), "1");
    assert.equal(response?.headers.get("location"), null);

    const marketing = await proxy(request("/gohighlevel-pricing.md"), undefined as never);
    assert.equal(marketing?.status, 404);

    const domainChallenge = await proxy(request("/.well-known/openai-apps-challenge"), undefined as never);
    assert.equal(domainChallenge?.status, 404);

    const api = await proxy(request("/api/v1/marketplace/listings"), undefined as never);
    assert.equal(api?.headers.get("x-middleware-next"), "1");

    const workspaceRequest = (path: string) => new NextRequest(`https://uplinks-workspace-4816.uplink.epic.dm${path}`, { headers: { host: "uplinks-workspace-4816.uplink.epic.dm" } });
    const workspaceMarketing = await proxy(workspaceRequest("/pricing-public"), undefined as never);
    assert.equal(workspaceMarketing?.status, 404);

    const workspaceApi = await proxy(workspaceRequest("/api/v1/forms"), undefined as never);
    assert.equal(workspaceApi?.headers.get("x-middleware-next"), "1");

    const workspaceLicense = await proxy(workspaceRequest("/license"), undefined as never);
    assert.equal(workspaceLicense?.headers.get("x-middleware-next"), "1");

    const workspaceAdmin = await proxy(workspaceRequest("/admin/abc?token=synthetic"), undefined as never);
    assert.equal(workspaceAdmin?.status, 307);
    assert.equal(workspaceAdmin?.headers.get("location"), "https://uplink.epic.dm/admin/abc?token=synthetic");

    const workspaceSwitch = await proxy(workspaceRequest("/switch-workspace?to=org&next=%2Fdashboard"), undefined as never);
    assert.equal(workspaceSwitch?.status, 307);
    assert.equal(workspaceSwitch?.headers.get("location"), "https://uplink.epic.dm/switch-workspace?to=org&next=%2Fdashboard");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
