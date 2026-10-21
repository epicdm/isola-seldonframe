// packages/crm/tests/unit/agents/mcp/agent-connector-guard.spec.ts
//
// Server-side rules for binding an MCP connector to a WORKSPACE agent
// (lib/agents/mcp/agent-connector-guard.ts, used by actions.ts):
//   1 SSRF — private/loopback/metadata/CGNAT/IP-literal endpoints refused before
//     any secret write or discovery; discovery never follows a redirect.
//   2 id/serviceName derived on the server; key stored only AFTER discovery;
//     a non-byo binding (composio) is never replaced.
//   3 BYO secrets scoped per agent.
//   4 errors leave as fixed codes, never upstream text.
// Every refusal has a positive twin (a public https endpoint binds) in this run.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentConnectorError,
  agentByoServiceName,
  agentConnectorErrorCode,
  isAgentScopedSecret,
  noRedirectFetch,
  prepareAgentConnectorBinding,
  validateAgentByoEndpoint,
} from "../../../../src/lib/agents/mcp/agent-connector-guard";
import { buildConnectorBinding } from "../../../../src/lib/agents/mcp/bind";
import type { ConnectorBinding, McpToolSchema } from "../../../../src/lib/agents/mcp/connectors";

const ORG = "org-1";
const AGENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const KEY = "unit-test-key-0123456789";
const PUBLIC_IP = "93.184.216.34";
const TOOLS: McpToolSchema[] = [{ name: "search_records", description: "", inputSchema: { type: "object" } }];

const svc = (x: ConnectorBinding) => (x as { serviceName: string }).serviceName;
const publicResolver = async () => [{ address: PUBLIC_IP, family: 4 }];

function harness(opts: { discover?: () => Promise<McpToolSchema[]>; resolve?: typeof publicResolver } = {}) {
  const events: string[] = [];
  const stored: Array<{ workspaceId: string; serviceName: string; value: string }> = [];
  return {
    events,
    stored,
    deps: {
      resolve: opts.resolve ?? publicResolver,
      storeSecret: async (a: { workspaceId: string; serviceName: string; value: string }) => {
        events.push("store");
        stored.push(a);
      },
      discoverTools: async () => {
        events.push("discover");
        return opts.discover ? opts.discover() : TOOLS;
      },
    },
  };
}

function byo(endpoint: string, id = "client-id", serviceName = "composio_api_key") {
  return { kind: "byo" as const, id, serviceName, endpoint };
}

describe("1 SSRF", () => {
  test("control: a public https endpoint binds, discovers and stores", async () => {
    const h = harness();
    const b = await prepareAgentConnectorBinding({
      orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"),
      apiKey: KEY, existing: [], deps: h.deps,
    });
    assert.equal(b.kind, "byo");
    assert.deepEqual(h.events, ["discover", "store"]);
  });

  const refused = [
    "https://127.0.0.1/mcp",
    "https://10.0.0.5/mcp",
    "https://172.16.4.4/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.1.1/mcp",
    "https://[::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://2130706433/mcp", // decimal IP literal → 127.0.0.1
    "https://0x7f000001/mcp", // hex IP literal → 127.0.0.1
    "https://localhost/mcp",
    "https://user:pw@odoo-mcp.example.com/mcp",
    "http://odoo-mcp.example.com/mcp", // not https
    "not a url",
  ];
  for (const ep of refused) {
    test(`refused before any store/discovery: ${ep}`, async () => {
      const h = harness();
      await assert.rejects(
        prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo(ep), apiKey: KEY, existing: [], deps: h.deps }),
        (e: unknown) => e instanceof AgentConnectorError && e.code === "endpoint_not_allowed",
      );
      assert.deepEqual(h.events, []);
    });
  }

  test("a public NAME that resolves to a private address is refused", async () => {
    const h = harness({ resolve: async () => [{ address: PUBLIC_IP, family: 4 }, { address: "10.1.2.3", family: 4 }] });
    await assert.rejects(
      prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://rebind.example.com/mcp"), apiKey: KEY, existing: [], deps: h.deps }),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "endpoint_not_allowed",
    );
    assert.deepEqual(h.events, []);
  });

  test("control: the shared composer alone does NOT block a private endpoint (the guard is what blocks)", async () => {
    const stores: string[] = [];
    const b = await buildConnectorBinding({
      orgId: ORG, connector: byo("https://127.0.0.1/mcp", "x", "byo_x"), apiKey: KEY,
      deps: { storeSecret: async () => { stores.push("s"); }, discoverTools: async () => TOOLS },
    });
    assert.equal(b.kind, "byo");
    assert.equal(stores.length, 1);
  });

  test("discovery refuses redirects (3xx and opaque) and forces redirect:manual", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const mk = (status: number, type: ResponseType = "basic") =>
      (async (_i: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init);
        const r = new Response(null, { status: status === 0 ? 200 : status });
        if (type === "opaqueredirect") Object.defineProperty(r, "type", { value: "opaqueredirect" });
        return r;
      }) as typeof fetch;
    await assert.rejects(noRedirectFetch(mk(302))("https://x.example.com/mcp", { method: "POST" }),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "redirect_refused");
    await assert.rejects(noRedirectFetch(mk(307))("https://x.example.com/mcp"),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "redirect_refused");
    await assert.rejects(noRedirectFetch(mk(0, "opaqueredirect"))("https://x.example.com/mcp"),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "redirect_refused");
    // control: a 200 passes through
    const ok = await noRedirectFetch(mk(200))("https://x.example.com/mcp", { method: "POST" });
    assert.equal(ok.status, 200);
    assert.ok(seen.every((i) => i?.redirect === "manual"));
  });
});

describe("2 server-derived names, store after discovery, no cross-kind overwrite", () => {
  test("client id/serviceName are ignored; names derive from the validated endpoint", async () => {
    const h = harness();
    const b = await prepareAgentConnectorBinding({
      orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp", "composio", "composio_api_key"),
      apiKey: KEY, existing: [], deps: h.deps,
    });
    assert.equal(b.id, "odoo-mcp-example-com-mcp");
    assert.equal(svc(b), agentByoServiceName(AGENT_A, "odoo-mcp-example-com-mcp"));
    assert.equal(h.stored[0].serviceName, svc(b));
    assert.notEqual(h.stored[0].serviceName, "composio_api_key");
  });

  test("a failed discovery stores NOTHING", async () => {
    const h = harness({ discover: async () => { throw new Error("boom"); } });
    await assert.rejects(
      prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing: [], deps: h.deps }),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "discovery_failed",
    );
    assert.deepEqual(h.events, ["discover"]);
    assert.equal(h.stored.length, 0);
  });

  test("an existing non-byo binding with the derived id is never replaced", async () => {
    const h = harness();
    const existing: ConnectorBinding[] = [
      { kind: "composio", id: "odoo-mcp-example-com-mcp", enabledTools: [] } as unknown as ConnectorBinding,
    ];
    await assert.rejects(
      prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing, deps: h.deps }),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "connector_conflict",
    );
    assert.deepEqual(h.events, []);
  });

  test("control: re-binding an existing byo with the same id is allowed", async () => {
    const h = harness();
    const existing: ConnectorBinding[] = [{
      kind: "byo", id: "odoo-mcp-example-com-mcp", serviceName: "x", endpoint: "https://odoo-mcp.example.com/mcp", enabledTools: [],
    }];
    const b = await prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing, deps: h.deps });
    assert.equal(b.kind, "byo");
  });

  test("an unknown vetted id is refused; a vetted bind uses the registry's secret name, not the client's", async () => {
    const h = harness();
    await assert.rejects(
      prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: { kind: "vetted", id: "nope", serviceName: "composio_api_key" }, apiKey: KEY, existing: [], deps: h.deps }),
      (e: unknown) => e instanceof AgentConnectorError && e.code === "unknown_connector",
    );
    const b = await prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: { kind: "vetted", id: "postiz", serviceName: "composio_api_key" }, apiKey: KEY, existing: [], deps: h.deps });
    assert.equal(b.kind, "vetted");
    assert.notEqual(svc(b), "composio_api_key");
    assert.equal(h.stored[0].serviceName, svc(b));
  });
});

describe("3 per-agent secret scope", () => {
  test("two agents on the same endpoint get different secret names", async () => {
    const ha = harness();
    const hb = harness();
    const a = await prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing: [], deps: ha.deps });
    const b = await prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_B, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing: [], deps: hb.deps });
    assert.equal(a.id, b.id, "control: same endpoint → same binding id");
    assert.notEqual(svc(a), svc(b));
    assert.equal(isAgentScopedSecret(AGENT_A, svc(a)), true);
    assert.equal(isAgentScopedSecret(AGENT_A, svc(b)), false, "agent A must never delete agent B's key");
    assert.equal(isAgentScopedSecret(AGENT_A, "composio_api_key"), false);
    assert.equal(isAgentScopedSecret(AGENT_A, "byo_odoo-mcp-example-com-mcp"), false, "legacy unscoped name is not deleted");
  });
});

describe("4 error codes never carry upstream text", () => {
  test("a discovery error containing the key and a body is reduced to a code", async () => {
    const h = harness({ discover: async () => { throw new Error(`MCP server returned HTTP 500: Bearer ${KEY} <html>`); } });
    let caught: unknown;
    try {
      await prepareAgentConnectorBinding({ orgId: ORG, agentId: AGENT_A, connector: byo("https://odoo-mcp.example.com/mcp"), apiKey: KEY, existing: [], deps: h.deps });
    } catch (e) { caught = e; }
    const code = agentConnectorErrorCode(caught);
    assert.equal(code, "discovery_failed");
    assert.equal(String((caught as Error).message).includes(KEY), false);
    assert.equal(agentConnectorErrorCode(new Error(`leak ${KEY}`)), "discovery_failed");
  });

  test("validateAgentByoEndpoint normalises and derives the id (control for the refusals)", async () => {
    const v = await validateAgentByoEndpoint("  https://Odoo-MCP.example.com/mcp ", { resolve: publicResolver });
    assert.equal(v.endpoint, "https://odoo-mcp.example.com/mcp");
    assert.equal(v.id, "odoo-mcp-example-com-mcp");
  });
});
