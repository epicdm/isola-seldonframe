// Path test (Law 20): the composio executor wrapper (resolveComposioBinding ->
// wrapped AgentTool.execute -> deps.executeTool) never lets a Google Docs
// plain-text read silently return a subset: omitted include_tabs_content
// defaults to true; explicit exclusion / tab_ids carry an explicit PARTIAL
// notice placed first; other tools are untouched (control).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveComposioBinding, type ComposioBinding } from "../../../src/lib/integrations/composio/connector";
import {
  annotateComposioEnvelope,
  parseTabsRead,
  prepareComposioArgs,
} from "../../../src/lib/integrations/composio/docs-tabs";

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
const TABS = [
  { id: "t.a1", name: "Quick notes", body: "Summary line" },
  { id: "t.b2", name: "Full notes", body: "Details" },
  { id: "t.c3", name: "Transcript", body: "Transcription ended after 01:26:15" },
];

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
        const ids = Array.isArray(args.tab_ids) ? (args.tab_ids as string[]) : null;
        const text =
          args.include_tabs_content !== true
            ? FIRST_TAB_TEXT
            : ids
              ? ids.map((id) => TABS.find((t) => t.id === id)!).map((t) => `--- TAB: ${t.name} (${t.id}) ---\n${t.body}`).join("\n")
              : ALL_TABS_TEXT;
        return { document_id: "d1", title: "Doc", plain_text: text, warnings: [] };
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
    assert.deepEqual(h.calls[0].args, { document_id: "d1", include_tabs_content: true, tab_ids: ["t.a1"] });
    assert.equal(Object.keys(out)[0], "partial_notice");
    assert.match(String(out.partial_notice), /only the 1 requested tab\(s\) were read/);
    assert.deepEqual(out.tabs_read, ["Quick notes"]);
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

describe("build/run envelope path (annotateComposioEnvelope + prepareComposioArgs)", () => {
  test("Docs envelope: args default to all tabs; data annotated; envelope fields kept", () => {
    const args = prepareComposioArgs("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", { document_id: "d1" });
    assert.deepEqual(args, { document_id: "d1", include_tabs_content: true });
    const env = { successful: true, error: null, data: { document_id: "d1", plain_text: ALL_TABS_TEXT } };
    const out = annotateComposioEnvelope("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", args, env) as {
      successful: boolean;
      data: Record<string, unknown>;
    };
    assert.equal(out.successful, true);
    assert.deepEqual(out.data.tabs_read, ["Quick notes", "Full notes", "Transcript"]);
  });
  test("Docs envelope with tabs excluded carries the PARTIAL notice inside data", () => {
    const args = prepareComposioArgs("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", { document_id: "d1", include_tabs_content: false });
    const env = { successful: true, data: { plain_text: FIRST_TAB_TEXT } };
    const out = annotateComposioEnvelope("GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", args, env) as { data: Record<string, unknown> };
    assert.equal(Object.keys(out.data)[0], "partial_notice");
  });
  test("control: other actions' envelopes and args pass through identically", () => {
    const args = { max_results: 5 };
    assert.equal(prepareComposioArgs("GMAIL_FETCH_EMAILS", args), args);
    const env = { successful: true, data: { messages: [] } };
    assert.equal(annotateComposioEnvelope("GMAIL_FETCH_EMAILS", args, env), env);
  });
});
