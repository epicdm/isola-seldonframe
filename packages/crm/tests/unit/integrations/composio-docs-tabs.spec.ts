// Path test (Law 20): the composio executor wrapper (resolveComposioBinding ->
// wrapped AgentTool.execute -> deps.executeTool) never lets a Google Docs
// plain-text read silently return a subset: omitted include_tabs_content
// defaults to true; explicit exclusion / tab_ids carry an explicit PARTIAL
// notice placed first; other tools are untouched (control).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveComposioBinding, type ComposioBinding } from "../../../src/lib/integrations/composio/connector";
import { parseTabsRead } from "../../../src/lib/integrations/composio/docs-tabs";

const ALL_TABS_TEXT = [
  "--- TAB: Quick notes (t.a1) ---",
  "Summary line",
  "--- TAB: Full notes (t.b2) ---",
  "Details",
  "---",
  "--- TAB: Transcript (t.c3) ---",
  "Transcription ended after 01:26:15",
].join("\n");
const FIRST_TAB_TEXT = "Summary line";

function binding(): ComposioBinding {
  return {
    id: "composio",
    kind: "composio",
    enabledToolkits: ["gmail", "googledocs"],
    enabledTools: ["GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", "GMAIL_FETCH_EMAILS"],
    tools: [],
    discoveredAt: "2026-10-21T00:00:00.000Z",
  };
}

function harness() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tools = resolveComposioBinding(binding(), {
    executeTool: async (_orgId: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT") {
        return {
          document_id: "d1",
          title: "Doc",
          plain_text: args.include_tabs_content === true ? ALL_TABS_TEXT : FIRST_TAB_TEXT,
          warnings: [],
        };
      }
      return { messages: [{ messageId: "m1" }] };
    },
  });
  const byName = (n: string) => tools.find((t) => t.name === `composio__${n}`)!;
  const ctx = { orgId: "org-1", agentId: "a", conversationId: "c", testMode: true } as never;
  return { calls, byName, ctx };
}

describe("Docs plain-text read: never a silent subset", () => {
  test("omitted include_tabs_content defaults to true; result lists the tabs read; no partial notice", async () => {
    const h = harness();
    const out = (await h.byName("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT").execute({ document_id: "d1" }, h.ctx)) as Record<string, unknown>;
    assert.deepEqual(h.calls, [{ tool: "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", args: { document_id: "d1", include_tabs_content: true } }]);
    assert.deepEqual(out.tabs_read, ["Quick notes", "Full notes", "Transcript"]);
    assert.equal(out.partial_notice, undefined);
    assert.equal(out.plain_text, ALL_TABS_TEXT);
  });

  test("explicit include_tabs_content=false is honoured but carries a PARTIAL notice placed first", async () => {
    const h = harness();
    const out = (await h.byName("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT").execute({ document_id: "d1", include_tabs_content: false }, h.ctx)) as Record<string, unknown>;
    assert.equal(h.calls[0].args.include_tabs_content, false);
    assert.equal(Object.keys(out)[0], "partial_notice");
    assert.match(String(out.partial_notice), /^PARTIAL: .*first tab.*NOT read/);
    assert.equal(out.plain_text, FIRST_TAB_TEXT);
  });

  test("tab_ids subset carries a PARTIAL notice naming the count read", async () => {
    const h = harness();
    const out = (await h.byName("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT").execute(
      { document_id: "d1", include_tabs_content: true, tab_ids: ["t.a1"] },
      h.ctx,
    )) as Record<string, unknown>;
    assert.equal(Object.keys(out)[0], "partial_notice");
    assert.match(String(out.partial_notice), /only the 3 requested tab\(s\) were read/);
  });

  test("control: other composio tools are untouched (args and result identical)", async () => {
    const h = harness();
    const out = await h.byName("GMAIL_FETCH_EMAILS").execute({ max_results: 5 }, h.ctx);
    assert.deepEqual(h.calls, [{ tool: "GMAIL_FETCH_EMAILS", args: { max_results: 5 } }]);
    assert.deepEqual(out, { messages: [{ messageId: "m1" }] });
  });

  test("parseTabsRead ignores bare '---' separators", () => {
    assert.deepEqual(parseTabsRead(ALL_TABS_TEXT), ["Quick notes", "Full notes", "Transcript"]);
    assert.deepEqual(parseTabsRead("no markers\n---\n"), []);
  });
});
