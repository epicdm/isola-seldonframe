// packages/crm/tests/unit/agents/mcp/agent-connector-guard.spec.ts
//
// The shared, hardened bind composer (bind.ts buildConnectorBinding) used by
// BOTH the workspace-agent path (secretScope set) and the Studio template path
// (no secretScope), plus the guard helpers (agent-connector-guard.ts):
//   1 SSRF — private/loopback/metadata/CGNAT/IP-literal endpoints refused before
//     any secret write or discovery; discovery never follows a redirect.
//   2 id/serviceName derived on the server; key stored only AFTER discovery;
//     a non-byo binding (composio) is never replaced.
//   3 workspace-agent BYO secrets scoped per agent, bounded in length.
//   4 errors leave as fixed codes, never upstream text.
// Every refusal has a positive twin (a public https endpoint binds) in this run.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentConnectorError,
  agentByoServiceName,
  agentConnectorErrorCode,
  isAgentScopedSecret,
  isConnectorsPatchAllowed,
  noRedirectFetch,
  validateAgentByoEndpoint,
} from "../../../../src/lib/agents/mcp/agent-connector-guard";
import { buildConnectorBinding, type BindConnectorInput } from "../../../../src/lib/agents/mcp/bind";
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

function byo(endpoint: string, id = "client-id", serviceName = "composio_api_key"): BindConnectorInput {
  return { kind: "byo", id, serviceName, endpoint };
}

// Both callers of the shared composer: agent (scoped) and Studio template.
const PATHS: Array<{ name: string; scope?: { agentId: string } }> = [
  { name: "agent", scope: { agentId: AGENT_A } },
  { name: "template", scope: undefined },
];

function bindVia(path: (typeof PATHS)[number], connector: BindConnectorInput, h: ReturnType<typeof harness>, existing: ConnectorBinding[] = []) {
  return buildConnectorBinding({ orgId: ORG, connector, apiKey: KEY, deps: h.deps, existing, secretScope: path.scope });
}

const isCode = (code: string) => (e: unknown) => e instanceof AgentConnectorError && e.code === code;

describe("1 SSRF (both paths)", () => {
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
  for (const path of PATHS) {
    test(`[${path.name}] control: a public https endpoint binds — discover THEN store`, async () => {
      const h = harness();
      const b = await bindVia(path, byo("https://odoo-mcp.example.com/mcp"), h);
      assert.equal(b.kind, "byo");
      assert.deepEqual(h.events, ["discover", "store"]);
    });
    for (const ep of refused) {
      test(`[${path.name}] refused before any store/discovery: ${ep}`, async () => {
        const h = harness();
        await assert.rejects(bindVia(path, byo(ep), h), isCode("endpoint_not_allowed"));
        assert.deepEqual(h.events, []);
      });
    }
    test(`[${path.name}] a public NAME that also resolves to a private address is refused`, async () => {
      const h = harness({ resolve: async () => [{ address: PUBLIC_IP, family: 4 }, { address: "10.1.2.3", family: 4 }] });
      await assert.rejects(bindVia(path, byo("https://rebind.example.com/mcp"), h), isCode("endpoint_not_allowed"));
      assert.deepEqual(h.events, []);
    });
  }

  test("discovery refuses redirects (3xx and opaque) and forces redirect:manual", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const mk = (status: number, opaque = false) =>
      (async (_i: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init);
        const r = new Response(null, { status });
        if (opaque) Object.defineProperty(r, "type", { value: "opaqueredirect" });
        return r;
      }) as typeof fetch;
    await assert.rejects(noRedirectFetch(mk(302))("https://x.example.com/mcp", { method: "POST" }), isCode("redirect_refused"));
    await assert.rejects(noRedirectFetch(mk(307))("https://x.example.com/mcp"), isCode("redirect_refused"));
    await assert.rejects(noRedirectFetch(mk(200, true))("https://x.example.com/mcp"), isCode("redirect_refused"));
    const ok = await noRedirectFetch(mk(200))("https://x.example.com/mcp", { method: "POST" });
    assert.equal(ok.status, 200, "control: a 200 passes through");
    assert.ok(seen.every((i) => i?.redirect === "manual"));
  });

  test("a redirect refusal re-wrapped by the MCP client still surfaces as redirect_refused", async () => {
    const h = harness({ discover: async () => { throw new Error("MCP request failed (initialize): redirect_refused"); } });
    await assert.rejects(bindVia(PATHS[0], byo("https://odoo-mcp.example.com/mcp"), h), isCode("redirect_refused"));
    assert.deepEqual(h.events, ["discover"], "nothing stored");
  });
});

describe("2 server-derived names, store after discovery, no cross-kind overwrite (both paths)", () => {
  for (const path of PATHS) {
    test(`[${path.name}] client id/serviceName are ignored; names derive from the validated endpoint`, async () => {
      const h = harness();
      const b = await bindVia(path, byo("https://odoo-mcp.example.com/mcp", "composio", "composio_api_key"), h);
      assert.equal(b.id, "odoo-mcp-example-com-mcp");
      const expected = path.scope ? agentByoServiceName(AGENT_A, "odoo-mcp-example-com-mcp") : "byo_odoo-mcp-example-com-mcp";
      assert.equal(svc(b), expected);
      assert.equal(h.stored[0].serviceName, expected);
      assert.notEqual(h.stored[0].serviceName, "composio_api_key");
    });

    test(`[${path.name}] a failed discovery stores NOTHING`, async () => {
      const h = harness({ discover: async () => { throw new Error("boom"); } });
      await assert.rejects(bindVia(path, byo("https://odoo-mcp.example.com/mcp"), h), isCode("discovery_failed"));
      assert.deepEqual(h.events, ["discover"]);
    });

    test(`[${path.name}] an existing non-byo binding with the derived id is never replaced`, async () => {
      const h = harness();
      const existing = [{ kind: "composio", id: "odoo-mcp-example-com-mcp", enabledTools: [] } as unknown as ConnectorBinding];
      await assert.rejects(bindVia(path, byo("https://odoo-mcp.example.com/mcp"), h, existing), isCode("connector_conflict"));
      assert.deepEqual(h.events, []);
    });

    test(`[${path.name}] control: re-binding an existing byo with the same id is allowed`, async () => {
      const h = harness();
      const existing: ConnectorBinding[] = [{ kind: "byo", id: "odoo-mcp-example-com-mcp", serviceName: "x", endpoint: "https://odoo-mcp.example.com/mcp", enabledTools: [] }];
      const b = await bindVia(path, byo("https://odoo-mcp.example.com/mcp"), h, existing);
      assert.equal(b.kind, "byo");
    });
  }

  test("an unknown vetted id is refused; a vetted bind uses the registry's secret name, not the client's", async () => {
    const h = harness();
    await assert.rejects(bindVia(PATHS[1], { kind: "vetted", id: "nope", serviceName: "composio_api_key" }, h), isCode("unknown_connector"));
    const b = await bindVia(PATHS[1], { kind: "vetted", id: "postiz", serviceName: "composio_api_key" }, h);
    assert.equal(b.kind, "vetted");
    assert.notEqual(svc(b), "composio_api_key");
    assert.equal(h.stored[0].serviceName, svc(b));
  });
});

describe("3 per-agent secret scope", () => {
  test("two agents on the same endpoint get different, bounded secret names", async () => {
    const a = await bindVia({ name: "a", scope: { agentId: AGENT_A } }, byo("https://odoo-mcp.example.com/mcp"), harness());
    const b = await bindVia({ name: "b", scope: { agentId: AGENT_B } }, byo("https://odoo-mcp.example.com/mcp"), harness());
    assert.equal(a.id, b.id, "control: same endpoint → same binding id");
    assert.notEqual(svc(a), svc(b));
    assert.equal(isAgentScopedSecret(AGENT_A, svc(a)), true);
    assert.equal(isAgentScopedSecret(AGENT_A, svc(b)), false, "agent A must never delete agent B's key");
    assert.equal(isAgentScopedSecret(AGENT_A, "composio_api_key"), false);
    assert.equal(isAgentScopedSecret(AGENT_A, "byo_odoo-mcp-example-com-mcp"), false, "legacy unscoped name is not deleted");
  });

  test("endpoints that differ only past the readable slug prefix never share a secret", () => {
    const a = `example-com-${"x".repeat(30)}a`;
    const b = `example-com-${"x".repeat(30)}b`;
    assert.notEqual(a, b, "control: distinct ids");
    assert.notEqual(agentByoServiceName(AGENT_A, a), agentByoServiceName(AGENT_A, b));
    assert.equal(agentByoServiceName(AGENT_A, a), agentByoServiceName(AGENT_A, a), "control: deterministic");
    assert.equal(isAgentScopedSecret(AGENT_A, agentByoServiceName(AGENT_A, b)), true);
  });

  test("a scoped name is never longer than the old byo_<48-char slug> maximum (tool-name budget)", () => {
    const longSlug = "x".repeat(48);
    assert.equal(`byo_${longSlug}`.length, 52, "control: the old maximum");
    assert.ok(agentByoServiceName(AGENT_A, longSlug).length <= 52);
    assert.ok(`${agentByoServiceName(AGENT_A, longSlug)}__${"t".repeat(40)}`.length <= 94);
  });
});

describe("4 error codes never carry upstream text", () => {
  test("a discovery error containing the key and a body is reduced to a code", async () => {
    const h = harness({ discover: async () => { throw new Error(`MCP server returned HTTP 500: Bearer ${KEY} <html>`); } });
    let caught: unknown;
    try {
      await bindVia(PATHS[1], byo("https://odoo-mcp.example.com/mcp"), h);
    } catch (e) { caught = e; }
    assert.equal(agentConnectorErrorCode(caught), "discovery_failed");
    assert.equal(String((caught as Error).message).includes(KEY), false);
    assert.equal(agentConnectorErrorCode(new Error(`leak ${KEY}`)), "discovery_failed");
  });

  test("validateAgentByoEndpoint normalises and derives the id (control for the refusals)", async () => {
    const v = await validateAgentByoEndpoint("  https://Odoo-MCP.example.com/mcp ", { resolve: publicResolver });
    assert.equal(v.endpoint, "https://odoo-mcp.example.com/mcp");
    assert.equal(v.id, "odoo-mcp-example-com-mcp");
  });
});

describe("5 isConnectorsPatchAllowed (pure)", () => {
  const existing: ConnectorBinding[] = [
    { kind: "byo", id: "odoo", serviceName: "byo_aX_odoo", endpoint: "https://odoo-mcp.example.com/mcp", enabledTools: ["a"], tools: [] },
  ];
  test("controls: unchanged, tool selection change, drop all, absent patch are allowed", () => {
    assert.equal(isConnectorsPatchAllowed(existing, existing), true);
    assert.equal(isConnectorsPatchAllowed(existing, [{ ...existing[0], enabledTools: [] } as ConnectorBinding]), true);
    assert.equal(isConnectorsPatchAllowed(existing, []), true);
    assert.equal(isConnectorsPatchAllowed(existing, undefined), true);
  });
  test("repointing the endpoint, renaming the secret, or adding a binding is refused", () => {
    assert.equal(isConnectorsPatchAllowed(existing, [{ ...existing[0], endpoint: "https://evil.example.com/x" } as ConnectorBinding]), false);
    assert.equal(isConnectorsPatchAllowed(existing, [{ ...existing[0], serviceName: "composio_api_key" } as ConnectorBinding]), false);
    assert.equal(isConnectorsPatchAllowed(existing, [...existing, { kind: "vetted", id: "postiz", serviceName: "postiz", enabledTools: [] }]), false);
    assert.equal(isConnectorsPatchAllowed([], [{ ...existing[0] }]), false);
    assert.equal(isConnectorsPatchAllowed(existing, "x" as unknown as ConnectorBinding[]), false);
  });
});
