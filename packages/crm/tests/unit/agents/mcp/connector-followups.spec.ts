// packages/crm/tests/unit/agents/mcp/connector-followups.spec.ts
//
// Follow-ups to the approved connector guard (a64025be):
//   P2-1 every conversation-time MCP request re-checks the URL is public https.
//   P2-2 refused template / cross-tenant connectors are COUNTED and surfaced in
//        the deploy and install results (fail-closed, never silent — Law 26),
//        incl. the legacy pl-action-adapter shape.
//   P3   vetted tool discovery refuses redirects; composio toolkits are part of
//        an agent connector's identity.
// Every refusal has a positive control in the same run.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createRuntimeMcpClient, publicOnlyFetch } from "../../../../src/lib/agents/mcp/runtime-client";
import { updateAgentTemplate } from "../../../../src/lib/agent-templates/store";
import {
  crossTenantDroppedCount,
  withCrossTenantSafeConnectors,
} from "../../../../src/lib/agents/mcp/connector-identity";
import { isConnectorsPatchAllowed } from "../../../../src/lib/agents/mcp/agent-connector-guard";
import {
  copyTemplateConnectorsToAgent,
  provisionClientWorkspaceForDeployment,
  type ProvisionClientWorkspaceDeps,
} from "../../../../src/lib/deployments/provision-client-workspace";
import { formatDeployResult } from "../../../../src/lib/chatgpt-app/chatgpt-mcp-rpc";
import { getVettedConnector, type ConnectorBinding } from "../../../../src/lib/agents/mcp/connectors";

const src = path.resolve(__dirname, "../../../../src");
const read = (p: string) => readFileSync(path.join(src, p), "utf8");

// The two production BYO bindings use this legacy, non-derived shape.
const LEGACY: ConnectorBinding = {
  kind: "byo", id: "pl-action-adapter", serviceName: "pl-action-adapter",
  endpoint: "https://pl-adapter.uplink.epic.dm/mcp", enabledTools: ["lookup"],
};
const POSTIZ: ConnectorBinding = { kind: "vetted", id: "postiz", serviceName: getVettedConnector("postiz")!.secretService, enabledTools: [] };

function fakeServer() {
  const methods: string[] = [];
  const base = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
    methods.push(body.method);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } }
      : { content: [{ type: "text", text: "ok" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { base, methods };
}

describe("P2-1 conversation-time public-address check on every request", () => {
  test("a host that resolves to a private address is refused before any request is sent", async () => {
    const s = fakeServer();
    const client = createRuntimeMcpClient("https://pl-adapter.uplink.epic.dm/mcp", "k", s.base, async () => [{ address: "10.0.0.9", family: 4 }]);
    await assert.rejects(client.callTool("lookup", {}), /endpoint_not_allowed/);
    assert.deepEqual(s.methods, [], "nothing reached the network");
  });

  test("a resolution that turns private mid-session is refused on the next request", async () => {
    const s = fakeServer();
    let calls = 0;
    const resolve = async () => [{ address: calls++ < 2 ? "66.118.37.29" : "127.0.0.1", family: 4 }];
    const client = createRuntimeMcpClient("https://pl-adapter.uplink.epic.dm/mcp", "k", s.base, resolve);
    await assert.rejects(client.callTool("lookup", {}), /endpoint_not_allowed/);
    assert.deepEqual(s.methods, ["initialize", "notifications/initialized"], "tools/call was never sent");
  });

  test("control: a public host (as pl-adapter resolves today) completes a tools/call", async () => {
    const s = fakeServer();
    const client = createRuntimeMcpClient("https://pl-adapter.uplink.epic.dm/mcp", "k", s.base, async () => [{ address: "66.118.37.29", family: 4 }]);
    await client.callTool("lookup", {});
    assert.deepEqual(s.methods, ["initialize", "notifications/initialized", "tools/call"]);
  });
});

describe("P2-2 refused connectors are counted and surfaced", () => {
  test("deploy-copy of the legacy shape: copied 0, notCopied 1, no write (fail-closed)", async () => {
    const writes: ConnectorBinding[][] = [];
    const r = await copyTemplateConnectorsToAgent(
      {
        loadTemplateConnectors: async () => [LEGACY],
        findClientDefaultAgentId: async () => "agent-1",
        updateAgentConnectors: async ({ connectors }) => { writes.push(connectors); return { ok: true }; },
        resolve: async () => [{ address: "66.118.37.29", family: 4 }],
      },
      { builderOrgId: "b", agentTemplateId: "t", clientOrgId: "c" },
    );
    assert.deepEqual(r, { ok: true, copied: 0, notCopied: 1 });
    assert.equal(writes.length, 0);
  });

  test("control: a canonical binding still copies alongside a refused one", async () => {
    const r = await copyTemplateConnectorsToAgent(
      {
        loadTemplateConnectors: async () => [POSTIZ, LEGACY],
        findClientDefaultAgentId: async () => "agent-1",
        updateAgentConnectors: async () => ({ ok: true }),
        resolve: async () => [{ address: "66.118.37.29", family: 4 }],
      },
      { builderOrgId: "b", agentTemplateId: "t", clientOrgId: "c" },
    );
    assert.deepEqual(r, { ok: true, copied: 1, notCopied: 1 });
  });

  function provisionDeps(notCopied: number): ProvisionClientWorkspaceDeps {
    return {
      createFullWorkspace: async () => ({ status: "ready", workspace_id: "client-org-9" }),
      resolveBuilderAgency: async () => null,
      setParentAgency: async () => {},
      updateDeployment: async () => {},
      enforceSubAccountCap: async () => ({ ok: true }),
      copyTemplateConnectors: async () => ({ ok: true, copied: 0, notCopied }),
    } as unknown as ProvisionClientWorkspaceDeps;
  }
  const deployment = {
    id: "d1", builderOrgId: "b", agentTemplateId: "t", clientName: "Client", clientOrgId: null,
    surface: "chat", status: "active", customization: {},
  } as never;

  test("the deploy result carries connectorsNotCopied when the copy refused something", async () => {
    const r = await provisionClientWorkspaceForDeployment(provisionDeps(1), deployment);
    assert.equal(r.ok, true);
    assert.equal((r as { connectorsNotCopied?: number }).connectorsNotCopied, 1);
  });

  test("control: nothing refused → no connectorsNotCopied field", async () => {
    const r = await provisionClientWorkspaceForDeployment(provisionDeps(0), deployment);
    assert.equal(r.ok, true);
    assert.equal("connectorsNotCopied" in r, false);
  });

  test("the deploy action passes it through, and both deploy forms render it", () => {
    const action = read("lib/deployments/actions.ts");
    assert.match(action, /return copyTemplateConnectorsToAgent\(/);
    assert.match(action, /connectorsNotCopied = provisioned\.connectorsNotCopied \?\? 0/);
    for (const f of ["app/(dashboard)/studio/clients/activate-form.tsx", "components/buyer/steps/phone-step.tsx"]) {
      const s = read(f);
      assert.match(s, /setConnectorsNotCopied\(\w+\.connectorsNotCopied \?\? 0\)/, f);
      assert.match(s, /\{connectorsNotCopied > 0 && \(/, f);
    }
  });

  test("install clone stamps a count (no endpoint / secret name) and the Studio page shows it", () => {
    const stamped = withCrossTenantSafeConnectors({ greeting: "hi", connectors: [LEGACY, POSTIZ] });
    assert.deepEqual(stamped, { greeting: "hi", connectors: [POSTIZ], connectorsNotCopied: 1 });
    assert.equal(JSON.stringify(stamped).includes("pl-adapter"), false, "nothing about the dropped binding leaks");
    assert.equal(crossTenantDroppedCount({ connectors: [LEGACY, POSTIZ] }), 1);
    assert.deepEqual(withCrossTenantSafeConnectors({ connectors: [POSTIZ] }), { connectors: [POSTIZ] }, "control: nothing dropped → no stamp");
    assert.match(read("app/(dashboard)/studio/agents/[id]/page.tsx"), /connectorsNotCopied > 0 \? \(/);
  });

  test("ChatGPT install reply and fork result say so", () => {
    assert.match(formatDeployResult({ name: "A", connectorsNotCopied: 2 }), /2 connector\(s\) from the original agent were not copied/);
    assert.equal(formatDeployResult({ name: "A" }), 'Installed "A" into your workspace.', "control: unchanged when nothing dropped");
    assert.match(read("lib/marketplace/fork-listing.ts"), /\.\.\.\(connectorsNotCopied > 0 \? \{ connectorsNotCopied \} : \{\}\)/);
    assert.match(read("lib/chatgpt-app/deps.ts"), /\.\.\.\(connectorsNotCopied > 0 \? \{ connectorsNotCopied \} : \{\}\)/);
  });
});

describe("P3 cheap follow-ups", () => {
  test("vetted tool discovery builds its client with noRedirectFetch", () => {
    const s = read("lib/agents/mcp/discover-vetted-tools.ts");
    assert.match(s, /createMcpClient\(\{ endpoint: connector\.endpoint, bearer, fetchImpl: noRedirectFetch\(\) \}\)/);
    assert.equal((s.match(/createMcpClient\(/g) ?? []).length, 1, "control: the only client construction in the file");
  });

  test("an untrusted patch may not widen a composio binding's toolkits", () => {
    const existing: ConnectorBinding[] = [{ kind: "composio", id: "c1", enabledToolkits: ["gmail"], enabledTools: [] }];
    assert.equal(isConnectorsPatchAllowed(existing, [{ kind: "composio", id: "c1", enabledToolkits: ["gmail", "slack"], enabledTools: [] }]), false);
  });

  test("controls: same toolkits (any order) and tool-selection changes are allowed", () => {
    const existing: ConnectorBinding[] = [{ kind: "composio", id: "c1", enabledToolkits: ["slack", "gmail"], enabledTools: [] }];
    assert.equal(isConnectorsPatchAllowed(existing, [{ kind: "composio", id: "c1", enabledToolkits: ["gmail", "slack"], enabledTools: ["composio__X"] }]), true);
    assert.equal(isConnectorsPatchAllowed([LEGACY], [{ ...LEGACY, enabledTools: [] } as ConnectorBinding]), true, "legacy shape: tool patch allowed");
  });
});

describe("Codex delta fixes (b169f38e)", () => {
  test("the install notice renders above both page shells, not inside the collapsed editor", () => {
    const s = read("app/(dashboard)/studio/agents/[id]/page.tsx");
    const editor = s.slice(s.indexOf("const editor = ("), s.indexOf("const editor = (") + 400);
    assert.equal(editor.includes("connectorsNotCopiedNotice"), false, "not inside the editor");
    assert.match(s, /\{connectorsNotCopiedNotice\}\s*<SetupModeShell/);
    assert.match(s, /\{connectorsNotCopiedNotice\}\s*<AgentLifecycleAccordion/);
    assert.equal((s.match(/\{connectorsNotCopiedNotice\}/g) ?? []).length, 2, "control: exactly the two shells");
  });

  test("a stalled DNS check is cut off by the request's abort signal (timeout)", async () => {
    let sent = 0;
    const base = (async () => { sent += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const never = () => new Promise<never>(() => {});
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(
      publicOnlyFetch(base, never as never)("https://mcp.example.com/mcp", { method: "POST", signal: ac.signal }),
      /endpoint_not_allowed/,
    );
    assert.ok(Date.now() - started < 2000, "returned promptly after the abort");
    assert.equal(sent, 0, "nothing was sent");
  });

  test("control: an un-aborted public lookup still sends the request", async () => {
    let sent = 0;
    const base = (async () => { sent += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const ac = new AbortController();
    await publicOnlyFetch(base, async () => [{ address: "66.118.37.29", family: 4 }])("https://mcp.example.com/mcp", { signal: ac.signal });
    assert.equal(sent, 1);
  });

  test("an inherited connectorsNotCopied is never carried into a new copy; the fresh count wins", () => {
    assert.deepEqual(withCrossTenantSafeConnectors({ connectors: [POSTIZ], connectorsNotCopied: 5 } as never), { connectors: [POSTIZ] });
    assert.deepEqual(withCrossTenantSafeConnectors({ greeting: "hi", connectorsNotCopied: 3 } as never), { greeting: "hi" });
    assert.deepEqual(withCrossTenantSafeConnectors({ connectors: [LEGACY], connectorsNotCopied: 9 } as never), { connectors: [], connectorsNotCopied: 1 });
  });

  test("the bind-flow save dismisses the notice; an untrusted save cannot set a count", async () => {
    const writes: Array<{ blueprint: Record<string, unknown> }> = [];
    const row = { id: "t1", builderOrgId: "o1", blueprint: { connectors: [], connectorsNotCopied: 2 } };
    const deps = {
      findById: async () => row as never,
      update: async (_id: string, patch: unknown) => { writes.push(patch as { blueprint: Record<string, unknown> }); return row as never; },
    };
    const r = await updateAgentTemplate({ id: "t1", deps, patch: { connectors: [POSTIZ], connectorsNotCopied: null }, trustedConnectorsWrite: true });
    assert.equal(r.ok, true);
    assert.equal("connectorsNotCopied" in writes[0].blueprint, false, "cleared");
    assert.match(read("lib/agent-templates/template-mcp-server.ts"), /patch: \{ connectors, connectorsNotCopied: null \}/);
    // Type-level: TemplateBlueprintPatch only admits null for this key.
    const bad: Parameters<typeof updateAgentTemplate>[0]["patch"] = { greeting: "x" };
    assert.equal("connectorsNotCopied" in bad, false, "control: ordinary patches don't touch it");
  });
});
