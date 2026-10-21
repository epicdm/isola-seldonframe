// packages/crm/tests/unit/deployments/copy-template-connectors-guard.spec.ts
//
// Deploying a Studio template copies its connectors onto the client
// workspace's default agent as a TRUSTED blueprint write. A template's stored
// connectors are editable, so the copy must keep only bindings the hardened
// bind flow could have produced — never a binding that points at another
// secret name or at an internal/attacker host. Drives the real
// copyTemplateConnectorsToAgent with injected deps; positive controls prove a
// canonical vetted/byo/composio binding still copies.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  copyTemplateConnectorsToAgent,
  type CopyTemplateConnectorsDeps,
} from "../../../src/lib/deployments/provision-client-workspace";
import { getVettedConnector, type ConnectorBinding } from "../../../src/lib/agents/mcp/connectors";

const PUBLIC_IP = "93.184.216.34";
const ARGS = { builderOrgId: "builder-1", agentTemplateId: "tmpl-1", clientOrgId: "client-1" };
const POSTIZ_SECRET = getVettedConnector("postiz")!.secretService;

const CANONICAL_BYO: ConnectorBinding = {
  kind: "byo",
  id: "odoo-mcp-example-com-mcp",
  serviceName: "byo_odoo-mcp-example-com-mcp",
  endpoint: "https://odoo-mcp.example.com/mcp",
  enabledTools: ["search_records"],
};
const CANONICAL_VETTED: ConnectorBinding = { kind: "vetted", id: "postiz", serviceName: POSTIZ_SECRET, enabledTools: [] };
const COMPOSIO = { kind: "composio", id: "composio-gmail", toolkits: ["gmail"], enabledTools: [] } as unknown as ConnectorBinding;

function run(template: ConnectorBinding[], resolve = async (h: string) => [{ address: h.startsWith("internal") ? "10.0.0.7" : PUBLIC_IP, family: 4 }]) {
  const written: ConnectorBinding[][] = [];
  const deps: CopyTemplateConnectorsDeps = {
    loadTemplateConnectors: async () => template,
    findClientDefaultAgentId: async () => "client-agent-1",
    updateAgentConnectors: async ({ connectors }) => {
      written.push(connectors);
      return { ok: true };
    },
    resolve,
  };
  return copyTemplateConnectorsToAgent(deps, ARGS).then((result) => ({ result, written }));
}

describe("deploy-copy keeps only canonical template bindings", () => {
  test("control: canonical byo + vetted + composio bindings all copy", async () => {
    const { result, written } = await run([CANONICAL_BYO, CANONICAL_VETTED, COMPOSIO]);
    assert.deepEqual(result, { ok: true, copied: 3 });
    assert.deepEqual(written, [[CANONICAL_BYO, CANONICAL_VETTED, COMPOSIO]]);
  });

  test("a byo binding naming another secret is dropped", async () => {
    const { written } = await run([CANONICAL_BYO, { ...CANONICAL_BYO, id: "x", serviceName: "composio_api_key" } as ConnectorBinding]);
    assert.deepEqual(written, [[CANONICAL_BYO]]);
  });

  test("a byo binding whose name does not match its endpoint (repointed) is dropped", async () => {
    const { written } = await run([{ ...CANONICAL_BYO, endpoint: "https://attacker.example.net/mcp" } as ConnectorBinding]);
    assert.deepEqual(written, [], "nothing to copy → no write at all");
  });

  test("a byo binding on a private / internal host is dropped", async () => {
    const internal = { kind: "byo", id: "internal-svc-mcp", serviceName: "byo_internal-svc-mcp", endpoint: "https://internal-svc/mcp", enabledTools: [] } as ConnectorBinding;
    const literal = { kind: "byo", id: "10-0-0-5-mcp", serviceName: "byo_10-0-0-5-mcp", endpoint: "https://10.0.0.5/mcp", enabledTools: [] } as ConnectorBinding;
    const { written } = await run([internal, literal, CANONICAL_BYO]);
    assert.deepEqual(written, [[CANONICAL_BYO]]);
  });

  test("a vetted binding with a forged secret name or an injected endpoint is dropped", async () => {
    const forged = { ...CANONICAL_VETTED, serviceName: "composio_api_key" } as ConnectorBinding;
    const injected = { ...CANONICAL_VETTED, endpoint: "https://attacker.example.net/mcp" } as unknown as ConnectorBinding;
    const unknown = { ...CANONICAL_VETTED, id: "nope" } as ConnectorBinding;
    const { written } = await run([forged, injected, unknown, CANONICAL_VETTED]);
    assert.deepEqual(written, [[CANONICAL_VETTED]]);
  });

  test("a composio binding carrying a secret pointer is dropped", async () => {
    const { written } = await run([{ ...(COMPOSIO as object), serviceName: "postiz" } as unknown as ConnectorBinding, COMPOSIO]);
    assert.deepEqual(written, [[COMPOSIO]]);
  });
});
