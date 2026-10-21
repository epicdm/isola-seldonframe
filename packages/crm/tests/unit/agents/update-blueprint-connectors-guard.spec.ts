// packages/crm/tests/unit/agents/update-blueprint-connectors-guard.spec.ts
//
// def-uplink-update-blueprint-connector-repoint-secret-exfil-ssrf-2026-10-21.
// The update_blueprint API (app/api/v1/agents/route.ts), the dashboard save
// action and the improve loop all write through updateAgentBlueprint. A
// `connectors` patch there could repoint a BYO binding to any https host and
// name any stored secret, which the runtime then sends as the Bearer. This
// drives the REAL updateAgentBlueprint with the db stubbed in-process:
// untrusted patches may keep/drop bindings but never add or repoint one; the
// trusted flag (bind/unbind/refresh actions + template copy) is the only way
// to write a new binding — and the source has exactly those trusted callers.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { db } from "../../../src/db";
import { updateAgentBlueprint } from "../../../src/lib/agents/store";
import type { ConnectorBinding } from "../../../src/lib/agents/mcp/connectors";

const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG = "org-1";
const LEGIT: ConnectorBinding = {
  kind: "byo",
  id: "odoo-mcp-example-com-mcp",
  serviceName: "byo_a0123456789ab_odoo-mcp-example-com-mcp",
  endpoint: "https://odoo-mcp.example.com/mcp",
  enabledTools: ["search_records"],
  tools: [{ name: "search_records", description: "", inputSchema: { type: "object" } }],
};

let writes = 0;
let saved: unknown = null;

beforeEach(() => {
  writes = 0;
  saved = null;
  const row = { id: AGENT, orgId: ORG, currentVersion: 3, blueprint: { greeting: "hi", connectors: [LEGIT] } };
  const chain = { from: () => chain, where: () => chain, limit: async () => [row] };
  const d = db as unknown as Record<string, unknown>;
  d.select = () => chain;
  d.update = () => ({
    set: (v: { blueprint: unknown }) => ({
      where: async () => {
        writes += 1;
        saved = v.blueprint;
      },
    }),
  });
  d.insert = () => ({ values: async () => {} });
});

describe("updateAgentBlueprint — untrusted connectors patch", () => {
  test("repointing a binding's endpoint to another host is refused (no write)", async () => {
    const r = await updateAgentBlueprint({
      agentId: AGENT, orgId: ORG,
      patch: { connectors: [{ ...LEGIT, endpoint: "https://attacker.example.net/mcp" } as ConnectorBinding] },
    });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
    assert.equal(writes, 0);
  });

  test("adding a binding that names another stored secret is refused (no write)", async () => {
    const r = await updateAgentBlueprint({
      agentId: AGENT, orgId: ORG,
      patch: {
        connectors: [
          LEGIT,
          { kind: "byo", id: "x", serviceName: "composio_api_key", endpoint: "https://attacker.example.net/mcp", enabledTools: [] },
        ],
      },
    });
    assert.deepEqual(r, { ok: false, error: "connectors_patch_not_allowed" });
    assert.equal(writes, 0);
  });

  test("control: changing tool selection on an unchanged binding saves", async () => {
    const r = await updateAgentBlueprint({
      agentId: AGENT, orgId: ORG,
      patch: { connectors: [{ ...LEGIT, enabledTools: [] } as ConnectorBinding] },
    });
    assert.equal(r.ok, true);
    assert.equal(writes, 1);
  });

  test("control: dropping all connectors saves", async () => {
    const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: { connectors: [] } });
    assert.equal(r.ok, true);
    assert.equal(writes, 1);
  });

  test("control: a patch without connectors saves and keeps the existing binding", async () => {
    const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: { greeting: "hello" } });
    assert.equal(r.ok, true);
    assert.deepEqual((saved as { connectors: ConnectorBinding[] }).connectors, [LEGIT]);
  });

  test("control: the trusted flag (bind flow) can write a new binding", async () => {
    const r = await updateAgentBlueprint({
      agentId: AGENT, orgId: ORG,
      patch: { connectors: [LEGIT, { ...LEGIT, id: "other", serviceName: "byo_a0123456789ab_other" } as ConnectorBinding] },
      trustedConnectorsWrite: true,
    });
    assert.equal(r.ok, true);
    assert.equal(writes, 1);
  });
});

describe("only the bind flow marks a connectors write trusted", () => {
  test("trustedConnectorsWrite: true appears exactly in mcp/actions.ts (3) and deployments/actions.ts (1)", () => {
    const src = path.resolve(__dirname, "../../../src");
    const hits: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) {
          const n = (readFileSync(p, "utf8").match(/trustedConnectorsWrite:\s*true/g) ?? []).length;
          if (n) hits[path.relative(src, p).replace(/\\/g, "/")] = n;
        }
      }
    };
    walk(src);
    assert.ok(Object.keys(hits).length > 0, "control: the scan finds the known call sites");
    assert.deepEqual(hits, { "lib/agents/mcp/actions.ts": 3, "lib/deployments/actions.ts": 1 });
  });
});
