// packages/crm/tests/unit/agents/agent-connectors-card.spec.tsx
//
// Workspace-agent Connectors (agents/[id]/settings). Proves the PATH, not just
// the piece: the settings client renders the Connectors form; the form's
// Connect calls the agent-scoped bind action with THIS agent's id, a BYO
// connector built from the typed endpoint and the typed key; the key field is
// a password input and is cleared after the call; and the card's default
// action is the agent-scoped bindMcpConnectorAction — NOT the Studio
// template's bindTemplateConnectorAction (control: the two are distinct).
//
// jsdom bootstrap MUST be the first import (see tests/setup-dom.ts).
import "../../setup-dom";

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import {
  AgentConnectorsCard,
  DEFAULT_AGENT_CONNECTOR_ACTIONS,
} from "../../../src/components/agents/agent-connectors-card";
import { SettingsClient } from "../../../src/app/(dashboard)/agents/[id]/settings/settings-client";
import {
  bindMcpConnectorAction,
  unbindMcpConnectorAction,
} from "../../../src/lib/agents/mcp/actions";
import { bindTemplateConnectorAction } from "../../../src/lib/agent-templates/template-mcp-server";
import type { ConnectorBinding } from "../../../src/lib/agents/mcp/connectors";

afterEach(() => cleanup());

const WAIT = { timeout: 5000 } as const;
const AGENT_ID = "265dcd92-0442-4b63-a68c-5235210c7c5a";
const ENDPOINT = "https://odoo-mcp.example.test/mcp";
const KEY = "test-key-not-a-secret-123";

let refreshes = 0;
const stubRouter = {
  back() {},
  forward() {},
  refresh() {
    refreshes += 1;
  },
  push() {},
  replace() {},
  prefetch() {},
};

function withRouter(node: React.ReactElement) {
  return React.createElement(
    AppRouterContext.Provider,
    { value: stubRouter as never },
    node,
  );
}

describe("workspace agent Connectors", () => {
  test("default actions are the agent-scoped ones, distinct from the template action (control)", () => {
    assert.equal(DEFAULT_AGENT_CONNECTOR_ACTIONS.bind, bindMcpConnectorAction);
    assert.equal(DEFAULT_AGENT_CONNECTOR_ACTIONS.unbind, unbindMcpConnectorAction);
    assert.notEqual(
      bindMcpConnectorAction as unknown,
      bindTemplateConnectorAction as unknown,
      "control: agent and template bind actions must be different functions",
    );
  });

  test("settings page client renders the Connectors form with a password key field", () => {
    render(
      withRouter(
        <SettingsClient
          agentId={AGENT_ID}
          currentVersion={3}
          initialBlueprint={{
            greeting: "",
            capabilities: [],
            faq: [],
            pricingFacts: [],
            customSkillMd: "",
          }}
          defaultSkillMd="# skill"
          allCapabilities={[]}
          initialConnectors={[]}
        />,
      ),
    );
    assert.ok(screen.getByRole("heading", { name: /^connectors$/i }));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    assert.ok(screen.getByLabelText(/mcp endpoint/i));
    const key = screen.getByLabelText(/api key/i) as HTMLInputElement;
    assert.equal(key.type, "password");
    assert.ok(screen.getByRole("button", { name: /^connect$/i }));
  });

  test("Connect calls bind with this agent's id, a BYO connector and the key; key is cleared", async () => {
    const calls: Array<Parameters<typeof bindMcpConnectorAction>[0]> = [];
    const bind: typeof bindMcpConnectorAction = async (input) => {
      calls.push(input);
      return { ok: true, version: 4, connectorId: input.connector.id, toolCount: 9 };
    };
    refreshes = 0;
    render(
      withRouter(
        <AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    const connectBtn = screen.getByRole("button", { name: /^connect$/i }) as HTMLButtonElement;
    assert.equal(connectBtn.disabled, true, "Connect is disabled until endpoint + key are filled");

    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: ENDPOINT } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => assert.equal(calls.length, 1), WAIT);
    const call = calls[0];
    assert.equal(call.agentId, AGENT_ID);
    assert.equal(call.apiKey, KEY);
    assert.equal(call.connector.kind, "byo");
    assert.equal((call.connector as { endpoint: string }).endpoint, ENDPOINT);
    assert.equal(call.connector.serviceName, `byo_${call.connector.id}`);
    await waitFor(() => assert.ok(screen.getByText(/connected — 9 tools available/i)), WAIT);
    assert.equal(refreshes, 1);
    assert.equal(document.body.innerHTML.includes(KEY), false, "the key is never rendered");
  });

  test("a non-https endpoint cannot be submitted (bind never called)", () => {
    let called = 0;
    const bind: typeof bindMcpConnectorAction = async () => {
      called += 1;
      return { ok: false, error: "x" };
    };
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: "http://plain.example.test/mcp" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    const btn = screen.getByRole("button", { name: /^connect$/i }) as HTMLButtonElement;
    assert.equal(btn.disabled, true);
    fireEvent.click(btn);
    assert.equal(called, 0);
  });

  test("a failed bind shows the error and clears the key", async () => {
    const bind: typeof bindMcpConnectorAction = async () => ({ ok: false, error: "agent_not_found" });
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: ENDPOINT } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => assert.ok(screen.getByText(/agent not found/i)), WAIT);
    assert.equal((screen.getByLabelText(/api key/i) as HTMLInputElement).value, "");
  });

  test("item 4: an upstream error text is never shown — only fixed copy / a short code", async () => {
    const upstream = `MCP server returned HTTP 500: Bearer ${KEY} <html>internal</html>`;
    const bind: typeof bindMcpConnectorAction = async () => ({ ok: false, error: upstream });
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: ENDPOINT } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => assert.ok(screen.getByText(/couldn't connect \(code: error\)/i)), WAIT);
    const html = document.body.innerHTML;
    assert.equal(html.includes("HTTP 500"), false);
    assert.equal(html.includes("internal"), false);
    assert.equal(html.includes(KEY), false);
  });

  test("item 4 control: a known code maps to its fixed message", async () => {
    const bind: typeof bindMcpConnectorAction = async () => ({ ok: false, error: "endpoint_not_allowed" });
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: ENDPOINT } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => assert.ok(screen.getByText(/isn't allowed\. use a public https/i)), WAIT);
  });

  test("item 5: the key is cleared even when the action throws", async () => {
    const bind: typeof bindMcpConnectorAction = async () => {
      throw new Error(`network down ${KEY}`);
    };
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={[]} bindAction={bind} />));
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    fireEvent.change(screen.getByLabelText(/mcp endpoint/i), { target: { value: ENDPOINT } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(
      () => assert.equal((screen.getByLabelText(/api key/i) as HTMLInputElement).value, ""),
      WAIT,
    );
    assert.equal(document.body.innerHTML.includes(KEY), false);
  });

  test("bound connectors are listed and Remove calls unbind with agent + connector id", async () => {
    const bound: ConnectorBinding[] = [
      {
        kind: "byo",
        id: "odoo-mcp-example-test-mcp",
        serviceName: "byo_odoo-mcp-example-test-mcp",
        endpoint: ENDPOINT,
        enabledTools: ["search_records"],
        tools: [{ name: "search_records", description: "", inputSchema: { type: "object" } }],
      },
    ];
    const calls: Array<{ agentId: string; connectorId: string }> = [];
    const unbind: typeof unbindMcpConnectorAction = async (input) => {
      calls.push(input);
      return { ok: true, version: 5 };
    };
    render(withRouter(<AgentConnectorsCard agentId={AGENT_ID} initialConnectors={bound} unbindAction={unbind} />));
    assert.ok(screen.getByText("Custom: odoo-mcp.example.test"));
    assert.ok(screen.getByText("1/1 tools"));
    fireEvent.click(screen.getByRole("button", { name: /remove odoo-mcp-example-test-mcp/i }));
    await waitFor(() => assert.equal(calls.length, 1), WAIT);
    assert.deepEqual(calls[0], { agentId: AGENT_ID, connectorId: "odoo-mcp-example-test-mcp" });
  });
});
