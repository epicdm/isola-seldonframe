// packages/crm/tests/integration/connector-legacy-binding-actions.spec.ts
//
// P2-3 — route-level tests (the REAL server actions) for the legacy,
// non-derived BYO binding shape that production's two BYO bindings use
// (id = serviceName = "pl-action-adapter", endpoint pl-adapter.uplink.epic.dm):
//   refresh   → still works, keeps the legacy secret pointer and endpoint;
//   tool patch (dashboard save) → allowed for tool selection, refused for a repoint;
//   unbind    → removes the binding but NEVER deletes the legacy secret
//               (it is not this agent's scoped secret; other bindings share it).
// Module-mocked: auth (getOrgId), secrets, db, the MCP client, the DNS-backed
// public-address check, next/cache. Each refusal has a positive control.
//
// Needs: node --experimental-test-module-mocks --import tsx --test <this file>

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, describe, mock, test } from "node:test";

import type { ConnectorBinding } from "../../src/lib/agents/mcp/connectors";

const crm = path.resolve(__dirname, "../..");
const url = (p: string) => pathToFileURL(path.join(crm, p)).href;

const ORG = "org-1";
const AGENT = "28a55c69-ef04-416f-9c91-7d72e9e21345";
const LEGACY: ConnectorBinding = {
  kind: "byo", id: "pl-action-adapter", serviceName: "pl-action-adapter",
  endpoint: "https://pl-adapter.uplink.epic.dm/mcp", enabledTools: ["lookup"],
  tools: [{ name: "lookup", description: "", inputSchema: { type: "object" } }],
};

const state = {
  connectors: [] as ConnectorBinding[],
  writes: [] as Array<{ connectors?: ConnectorBinding[] }>,
  rotated: [] as string[],
  secretReads: [] as string[],
  endpointPublic: true,
};

let refreshMcpConnectorAction: typeof import("../../src/lib/agents/mcp/actions").refreshMcpConnectorAction;
let unbindMcpConnectorAction: typeof import("../../src/lib/agents/mcp/actions").unbindMcpConnectorAction;
let saveAgentBlueprintAction: typeof import("../../src/lib/agents/actions").saveAgentBlueprintAction;
let agentByoServiceName: typeof import("../../src/lib/agents/mcp/agent-connector-guard").agentByoServiceName;

before(async () => {
  const row = () => ({ id: AGENT, orgId: ORG, currentVersion: 7, blueprint: { greeting: "hi", connectors: state.connectors } });
  const chain = { from: () => chain, where: () => chain, limit: async () => [row()] };
  const fakeDb = {
    select: () => chain,
    update: () => ({ set: (v: { blueprint: { connectors?: ConnectorBinding[] } }) => ({ where: async () => { state.writes.push(v.blueprint); } }) }),
    insert: () => ({ values: async () => {} }),
  };
  mock.module(url("src/db/index.ts"), { namedExports: { db: fakeDb } });
  // auth.ts builds the Auth.js Drizzle adapter from db at import time; stub it.
  mock.module(url("auth.ts"), {
    namedExports: { auth: async () => null, signIn: async () => {}, signOut: async () => {}, handlers: {} },
  });
  mock.module(url("src/lib/auth/helpers.ts"), {
    // EPIC 2026-10-21 (staff access): connector actions are owner/admin actions and ask for the caller's workspace role.
    namedExports: { getOrgId: async () => ORG, getCurrentUser: async () => ({ id: "u1", orgId: ORG }), getCurrentWorkspaceRole: async () => "owner" },
  });
  mock.module(url("src/lib/secrets.ts"), {
    namedExports: {
      storeSecret: async () => {},
      getSecretValue: async ({ serviceName }: { serviceName: string }) => { state.secretReads.push(serviceName); return "legacy-bearer"; },
      rotateSecret: async ({ serviceName }: { serviceName: string }) => { state.rotated.push(serviceName); return {}; },
    },
  });
  mock.module(url("src/lib/agents/mcp/client.ts"), {
    namedExports: {
      createMcpClient: () => ({
        initialize: async () => {},
        listTools: async () => [{ name: "lookup", description: "", inputSchema: { type: "object" } }, { name: "status", description: "", inputSchema: { type: "object" } }],
        callTool: async () => ({}),
      }),
    },
  });
  mock.module(url("src/lib/security/ssrf-guard.ts"), {
    namedExports: {
      assertPublicHttpUrl: async (u: string) => {
        if (!state.endpointPublic) throw new Error("URL not allowed");
        return { url: new URL(u), ip: "66.118.37.29" };
      },
    },
  });
  mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

  ({ refreshMcpConnectorAction, unbindMcpConnectorAction } = await import("../../src/lib/agents/mcp/actions"));
  ({ saveAgentBlueprintAction } = await import("../../src/lib/agents/actions"));
  ({ agentByoServiceName } = await import("../../src/lib/agents/mcp/agent-connector-guard"));
});

beforeEach(() => {
  state.connectors = [LEGACY];
  state.writes = [];
  state.rotated = [];
  state.secretReads = [];
  state.endpointPublic = true;
});

describe("legacy pl-action-adapter binding through the real actions", () => {
  test("refresh: works, reads the legacy secret, keeps id/serviceName/endpoint, updates tools", async () => {
    const r = await refreshMcpConnectorAction({ agentId: AGENT, connectorId: "pl-action-adapter" });
    assert.deepEqual(r, { ok: true, version: 8, toolCount: 2 });
    assert.deepEqual(state.secretReads, ["pl-action-adapter"]);
    const saved = state.writes[0].connectors![0] as ConnectorBinding & { serviceName: string; endpoint: string };
    assert.equal(saved.id, "pl-action-adapter");
    assert.equal(saved.serviceName, "pl-action-adapter");
    assert.equal(saved.endpoint, "https://pl-adapter.uplink.epic.dm/mcp");
    assert.equal(saved.tools?.length, 2);
  });

  test("refresh control: if the host stops resolving public, refresh refuses (no secret read, no write)", async () => {
    state.endpointPublic = false;
    const r = await refreshMcpConnectorAction({ agentId: AGENT, connectorId: "pl-action-adapter" });
    assert.deepEqual(r, { ok: false, error: "endpoint_not_allowed" });
    assert.deepEqual(state.secretReads, []);
    assert.equal(state.writes.length, 0);
  });

  test("tool patch (dashboard save): changing enabledTools on the legacy binding saves", async () => {
    const r = await saveAgentBlueprintAction({ agentId: AGENT, patch: { connectors: [{ ...LEGACY, enabledTools: [] }] } });
    assert.deepEqual(r, { ok: true, version: 8 });
    assert.deepEqual(state.writes[0].connectors![0].enabledTools, []);
  });

  test("tool patch control: repointing the legacy binding's endpoint is refused", async () => {
    const r = await saveAgentBlueprintAction({
      agentId: AGENT,
      patch: { connectors: [{ ...LEGACY, endpoint: "https://attacker.example.net/mcp" } as ConnectorBinding] },
    });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
    assert.equal(state.writes.length, 0);
  });

  test("unbind: removes the binding and does NOT delete the shared legacy secret", async () => {
    const r = await unbindMcpConnectorAction({ agentId: AGENT, connectorId: "pl-action-adapter" });
    assert.deepEqual(r, { ok: true, version: 8 });
    assert.deepEqual(state.writes[0].connectors, []);
    assert.deepEqual(state.rotated, [], "pl-action-adapter must survive (the C3 copy and the live concierge share it)");
  });

  test("unbind control: an agent-scoped secret IS deleted (proves the delete path is live)", async () => {
    const scoped = { ...LEGACY, id: "pl-adapter-uplink-epic-dm-mcp", serviceName: agentByoServiceName(AGENT, LEGACY.endpoint as string) } as ConnectorBinding;
    state.connectors = [LEGACY, scoped];
    const r = await unbindMcpConnectorAction({ agentId: AGENT, connectorId: "pl-adapter-uplink-epic-dm-mcp" });
    assert.equal(r.ok, true);
    assert.deepEqual(state.rotated, [(scoped as { serviceName: string }).serviceName]);
    assert.deepEqual(state.writes[0].connectors, [LEGACY]);
  });
});
