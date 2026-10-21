// Path test (Law 20): Studio "Google Docs" chip -> saved composio binding ->
// runtime tool list -> executor. Proves a Doc-text tool reaches the model ONLY
// through the existing chip/binding/runtime seams, read-only, and that the
// other toolkits' curated defaults are unchanged (positive control).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  setTemplateComposioToolkits,
  type TemplateConnectorDeps,
} from "../../../src/lib/agent-templates/mcp-actions";
import type { ConnectorBinding } from "../../../src/lib/agents/mcp/connectors";
import type { AgentBlueprint } from "../../../src/db/schema/agents";
import {
  defaultToolsForToolkits,
  isCatalogToolkit,
} from "../../../src/lib/integrations/composio/catalog";
import { toolCatalogForUi } from "../../../src/lib/agents/generate/tool-catalog";
import { getToolsForCapabilities } from "../../../src/lib/agents/tools";

const DOC_TOOL = "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT";
const SEARCH_TOOL = "GOOGLEDOCS_SEARCH_DOCUMENTS";

function harness() {
  let blueprint: AgentBlueprint = { capabilities: [], connectors: [] };
  const deps: Pick<TemplateConnectorDeps, "loadBlueprint" | "saveConnectors"> = {
    loadBlueprint: async () => blueprint,
    saveConnectors: async (connectors: ConnectorBinding[]) => {
      blueprint = { ...blueprint, connectors };
    },
  };
  return {
    deps,
    get blueprint() {
      return blueprint;
    },
  };
}

describe("Google Docs chip -> binding -> runtime (read-only doc text)", () => {
  test("googledocs is a catalog toolkit with a 'Google Docs' Apps & tools chip", () => {
    assert.equal(isCatalogToolkit("googledocs"), true);
    const chip = toolCatalogForUi().find((e) => e.toolkitSlug === "googledocs");
    assert.ok(chip, "a chip keyed on the googledocs toolkit exists");
    assert.equal(chip!.label, "Google Docs");
    assert.equal(chip!.connectorKind, "composio");
  });

  test("googledocs defaults are exactly the read-only search + plaintext tools", () => {
    const tools = defaultToolsForToolkits(["googledocs"]);
    assert.deepEqual(tools, [SEARCH_TOOL, DOC_TOOL]);
    for (const t of tools) {
      assert.ok(
        !/(CREATE|UPDATE|INSERT|DELETE|REPLACE|COPY|SHARE|WRITE)/.test(t),
        `${t} must not be a write action`,
      );
    }
  });

  test("positive control: gmail and googledrive defaults are unchanged", () => {
    assert.deepEqual(defaultToolsForToolkits(["gmail"]), [
      "GMAIL_SEND_EMAIL",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_ADD_LABEL_TO_EMAIL",
      "GMAIL_MODIFY_THREAD_LABELS",
      "GMAIL_LIST_LABELS",
      "GMAIL_CREATE_LABEL",
    ]);
    assert.deepEqual(defaultToolsForToolkits(["googledrive"]), [
      "GOOGLEDRIVE_FIND_FILE",
      "GOOGLEDRIVE_CREATE_FILE",
      "GOOGLEDRIVE_DOWNLOAD_FILE",
    ]);
  });

  test("selecting the chip binds googledocs and the runtime exposes + executes the doc-text tool", async () => {
    const h = harness();
    const res = await setTemplateComposioToolkits(
      { orgId: "org-1", templateId: "tmpl-1", toolkits: ["gmail", "googledrive", "googledocs"] },
      h.deps,
    );
    assert.equal(res.ok, true);
    const binding = (h.blueprint.connectors ?? [])[0];
    assert.equal(binding?.kind, "composio");
    if (binding?.kind !== "composio") return;
    assert.deepEqual(binding.enabledToolkits, ["gmail", "googledrive", "googledocs"]);
    assert.ok(binding.enabledTools.includes(DOC_TOOL));

    const calls: Array<{ orgId: string; tool: string; args: Record<string, unknown> }> = [];
    const tools = await getToolsForCapabilities([], {
      orgId: "org-1",
      connectors: h.blueprint.connectors,
      hasComposioKey: async () => true,
      composioDeps: {
        executeTool: async (orgId: string, tool: string, args: Record<string, unknown>) => {
          calls.push({ orgId, tool, args });
          return "doc text";
        },
      },
    });
    const docTool = tools.find((t) => t.name === `composio__${DOC_TOOL}`);
    assert.ok(docTool, "runtime exposes composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT");
    const out = await docTool!.execute({ document_id: "doc-123" }, {
      orgId: "org-1",
      agentId: "a",
      conversationId: "c",
      testMode: true,
    } as never);
    assert.equal(out, "doc text");
    assert.deepEqual(calls, [
      // Docs reads default to ALL tabs (docs-tabs.ts) — the executor receives include_tabs_content=true.
      { orgId: "org-1", tool: DOC_TOOL, args: { document_id: "doc-123", include_tabs_content: true } },
    ]);
  });

  test("control: without the googledocs chip the runtime does NOT expose the doc-text tool", async () => {
    const h = harness();
    await setTemplateComposioToolkits(
      { orgId: "org-1", templateId: "tmpl-1", toolkits: ["gmail", "googledrive"] },
      h.deps,
    );
    const tools = await getToolsForCapabilities([], {
      orgId: "org-1",
      connectors: h.blueprint.connectors,
      hasComposioKey: async () => true,
      composioDeps: { executeTool: async () => null },
    });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("composio__GMAIL_FETCH_EMAILS"), "positive control: gmail tool present");
    assert.ok(!names.includes(`composio__${DOC_TOOL}`));
  });
});
