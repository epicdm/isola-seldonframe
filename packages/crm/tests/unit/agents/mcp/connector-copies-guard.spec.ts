// packages/crm/tests/unit/agents/mcp/connector-copies-guard.spec.ts
//
// Law 21 — every place a connector binding is written or copied:
//   P1-1 Studio template saves (updateAgentTemplate) — untrusted patches may
//        keep/drop or add canonical vetted/composio, never add or repoint BYO;
//        only the bind-flow save is trusted.
//   P1-1 cross-tenant clones (buildInstalledAgentTemplate → purchase / ChatGPT
//        install / build-deploy; fork-listing) carry no BYO bindings.
//   P1-2 the conversation-time MCP client refuses a redirect on tools/call.
//   P3   the shared SSRF guard blocks 198.18/15, multicast and 240/4.
// Each refusal has a positive control in the same run.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { updateAgentTemplate } from "../../../../src/lib/agent-templates/store";
import { buildInstalledAgentTemplate } from "../../../../src/lib/marketplace/agent-listings";
import { createRuntimeMcpClient } from "../../../../src/lib/agents/mcp/runtime-client";
import { isBlockedIp } from "../../../../src/lib/security/ssrf-guard";
import { getVettedConnector, type ConnectorBinding } from "../../../../src/lib/agents/mcp/connectors";

const POSTIZ: ConnectorBinding = { kind: "vetted", id: "postiz", serviceName: getVettedConnector("postiz")!.secretService, enabledTools: [] };
const COMPOSIO: ConnectorBinding = { kind: "composio", id: "composio-gmail", enabledToolkits: ["gmail"], enabledTools: [] };
const BYO: ConnectorBinding = {
  kind: "byo", id: "odoo-mcp-example-com-mcp", serviceName: "byo_odoo-mcp-example-com-mcp",
  endpoint: "https://odoo-mcp.example.com/mcp", enabledTools: ["search_records"],
};

function templateDeps(connectors: ConnectorBinding[]) {
  const writes: unknown[] = [];
  const row = { id: "t1", builderOrgId: "o1", blueprint: { greeting: "hi", connectors } };
  return {
    writes,
    deps: {
      findById: async () => row as never,
      update: async (_id: string, patch: unknown) => {
        writes.push(patch);
        return { ...row, ...(patch as object) } as never;
      },
    },
  };
}

describe("P1-1 updateAgentTemplate — untrusted connectors patch", () => {
  test("repointing an existing BYO binding is refused (no write)", async () => {
    const h = templateDeps([BYO]);
    const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { connectors: [{ ...BYO, endpoint: "https://attacker.example.net/mcp" } as ConnectorBinding] } });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
    assert.equal(h.writes.length, 0);
  });

  test("adding a BYO binding naming any secret is refused (no write)", async () => {
    const h = templateDeps([]);
    const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { connectors: [BYO] } });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
    assert.equal(h.writes.length, 0);
  });

  test("a vetted binding with a forged secret pointer is refused", async () => {
    const h = templateDeps([]);
    const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { connectors: [{ ...POSTIZ, serviceName: "composio_api_key" } as ConnectorBinding] } });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
  });

  test("controls: keep/drop, tool-selection change, and canonical vetted/composio additions save", async () => {
    for (const [existing, patch] of [
      [[BYO], [BYO]],
      [[BYO], []],
      [[BYO], [{ ...BYO, enabledTools: [] }]],
      [[], [POSTIZ, COMPOSIO]],
    ] as Array<[ConnectorBinding[], ConnectorBinding[]]>) {
      const h = templateDeps(existing);
      const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { connectors: patch } });
      assert.equal(r.ok, true, JSON.stringify(patch));
      assert.equal(h.writes.length, 1);
    }
  });

  test("control: a patch without connectors saves", async () => {
    const h = templateDeps([BYO]);
    const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { greeting: "hello" } });
    assert.equal(r.ok, true);
  });

  test("control: the trusted bind-flow save can write a new BYO binding", async () => {
    const h = templateDeps([]);
    const r = await updateAgentTemplate({ id: "t1", deps: h.deps, patch: { connectors: [BYO] }, trustedConnectorsWrite: true });
    assert.equal(r.ok, true);
  });

  test("only template-mcp-server marks a template connectors write trusted", () => {
    const src = path.resolve(__dirname, "../../../../src");
    const read = (p: string) => readFileSync(path.join(src, p), "utf8");
    const count = (s: string) => (s.match(/trustedConnectorsWrite:\s*true/g) ?? []).length;
    assert.equal(count(read("lib/agent-templates/template-mcp-server.ts")), 1, "control: the bind-flow save is trusted");
    for (const f of [
      "lib/agent-templates/actions.ts",
      "lib/agent-templates/interview-actions.ts",
      "lib/agent-templates/starter-pack.ts",
      "lib/agent-templates/deploy-to-self-actions.ts",
      "lib/activation/agent-picks-actions.ts",
      "lib/agents/generate/actions.ts",
      "app/api/v1/agents/generate/route.ts",
      "app/api/v1/recordings/compile-agent/route.ts",
      "app/(dashboard)/studio/agents/[id]/page.tsx",
    ]) {
      assert.equal(count(read(f)), 0, `${f} must not mark connectors trusted`);
    }
  });
});

describe("P1-1 cross-tenant clones carry no BYO bindings", () => {
  const listing = (connectors: ConnectorBinding[]) => ({
    id: "l1", name: "Agent", kind: "agent", agentType: "chat",
    agentBlueprint: { greeting: "hi", connectors },
  });

  test("a seller's BYO binding is dropped; canonical vetted + composio survive (control)", () => {
    const forged = { ...POSTIZ, serviceName: "composio_api_key" } as ConnectorBinding;
    const args = buildInstalledAgentTemplate(listing([BYO, POSTIZ, COMPOSIO, forged]) as never, "buyer-1");
    assert.deepEqual((args.blueprint as { connectors: ConnectorBinding[] }).connectors, [POSTIZ, COMPOSIO]);
  });

  test("control: a blueprint without connectors is cloned unchanged", () => {
    const l = { id: "l1", name: "Agent", kind: "agent", agentType: "chat", agentBlueprint: { greeting: "hi" } };
    const args = buildInstalledAgentTemplate(l as never, "buyer-1");
    assert.deepEqual(args.blueprint, { greeting: "hi" });
  });

  test("fork-listing uses the same cross-tenant filter", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../../src/lib/marketplace/fork-listing.ts"), "utf8");
    assert.match(src, /blueprint: withCrossTenantSafeConnectors\(structuredClone\(listing\.agentBlueprint\)\)/);
    assert.equal((src.match(/structuredClone\(listing\.agentBlueprint\)/g) ?? []).length, 1, "control: the only clone site in the file");
  });
});

describe("P1-2 conversation-time MCP client refuses redirects", () => {
  function fakeServer(callStatus: number) {
    const seen: Array<{ method: string; redirect?: RequestRedirect }> = [];
    const base = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
      seen.push({ method: body.method, redirect: init?.redirect });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call" && callStatus !== 200) {
        return new Response(null, { status: callStatus, headers: { location: "http://10.0.0.5/steal" } });
      }
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } }
        : { content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { base, seen };
  }

  test("a 307 on tools/call is refused and never followed", async () => {
    const s = fakeServer(307);
    const client = createRuntimeMcpClient("https://mcp.example.com/mcp", "k", s.base, async () => [{ address: "93.184.216.34", family: 4 }]);
    await assert.rejects(client.callTool("search_records", {}), /redirect_refused/);
    assert.deepEqual(s.seen.map((x) => x.method), ["initialize", "notifications/initialized", "tools/call"], "no request after the 307");
    assert.ok(s.seen.every((x) => x.redirect === "manual"));
  });

  test("control: a 200 tools/call succeeds through the same client", async () => {
    const s = fakeServer(200);
    const client = createRuntimeMcpClient("https://mcp.example.com/mcp", "k", s.base, async () => [{ address: "93.184.216.34", family: 4 }]);
    await client.callTool("search_records", {});
    assert.equal(s.seen.at(-1)?.method, "tools/call");
  });

  test("tools.ts builds the conversation-time client through createRuntimeMcpClient", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../../src/lib/agents/tools.ts"), "utf8");
    assert.match(src, /makeClient: \(endpoint, bearer\) => createRuntimeMcpClient\(endpoint, bearer\)/);
    assert.equal((src.match(/createMcpClient\(/g) ?? []).length, 0, "control: no direct client construction left in tools.ts");
  });
});

describe("P3 shared SSRF guard ranges", () => {
  test("198.18/15, multicast and 240/4 (and IPv6 multicast) are blocked", () => {
    for (const ip of ["198.18.0.1", "198.19.255.254", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.254", "ff02::1", "::ffff:198.18.0.1"]) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
  });
  test("controls: neighbouring public addresses are still allowed", () => {
    for (const ip of ["198.17.255.255", "198.20.0.1", "223.255.255.254", "93.184.216.34", "2606:4700::1111"]) {
      assert.equal(isBlockedIp(ip), false, ip);
    }
  });
});
