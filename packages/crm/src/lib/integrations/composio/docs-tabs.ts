// Google Docs plain-text reads must never silently return a subset of a
// document (2026-10-21 acceptance finding): GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT
// with default args renders ONLY the first tab (3,530 of 70,435 chars on the
// acceptance doc) with `warnings: []` — nothing tells the model the rest is
// missing. Two pure rules, applied in the composio executor wrapper:
//   1. prepare: when the caller omits include_tabs_content, default it to true
//      (full document, all tabs).
//   2. annotate: when tabs are included, report which tabs were read (parsed
//      from the rendering's "--- TAB: <name> (<id>) ---" markers). When the
//      caller explicitly excluded tabs (include_tabs_content=false) or asked for
//      specific tab_ids, prepend an explicit PARTIAL notice. The response
//      carries no tab count when tabs are excluded, so the notice says the
//      other tabs (if any) were NOT read rather than inventing an "of M".
// Notices/metadata are placed FIRST in the object so a downstream size cap can
// never cut them off. Pure; never throws.

export const DOCS_PLAINTEXT_TOOL = "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT";

const TAB_MARKER = /^--- TAB: (.+) \(([^)]+)\) ---$/gm;

export function prepareComposioArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== DOCS_PLAINTEXT_TOOL) return args;
  if (args.include_tabs_content !== undefined) return args;
  return { ...args, include_tabs_content: true };
}

/** Apply annotateComposioResult to a raw Composio SDK envelope
 *  ({ data, successful, error }) — for callers that execute actions directly
 *  (e.g. the /api/v1/build/run endpoint) rather than through the agent
 *  wrapper. Non-envelope values pass through unchanged. */
export function annotateComposioEnvelope(
  toolName: string,
  args: Record<string, unknown>,
  envelope: unknown,
): unknown {
  if (toolName !== DOCS_PLAINTEXT_TOOL) return envelope;
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) return envelope;
  const env = envelope as Record<string, unknown>;
  return { ...env, data: annotateComposioResult(toolName, args, env.data) };
}

export function parseTabsRead(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(TAB_MARKER)) names.push(m[1]!);
  return names;
}

export function annotateComposioResult(
  toolName: string,
  args: Record<string, unknown>,
  output: unknown,
): unknown {
  if (toolName !== DOCS_PLAINTEXT_TOOL) return output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const text = (output as { plain_text?: unknown }).plain_text;
  if (typeof text !== "string") return output;

  if (args.include_tabs_content !== true) {
    return {
      partial_notice:
        "PARTIAL: include_tabs_content was not true, so only the document's first tab was read; any other tabs were NOT read. Tell the user this read is partial.",
      ...(output as Record<string, unknown>),
    };
  }
  const tabsRead = parseTabsRead(text);
  const tabIds = Array.isArray(args.tab_ids) ? args.tab_ids : [];
  if (tabIds.length > 0) {
    return {
      partial_notice: `PARTIAL: only the ${tabsRead.length} requested tab(s) were read (tab_ids); other tabs of this document were NOT read. Tell the user this read is partial.`,
      tabs_read: tabsRead,
      ...(output as Record<string, unknown>),
    };
  }
  return { tabs_read: tabsRead, ...(output as Record<string, unknown>) };
}
