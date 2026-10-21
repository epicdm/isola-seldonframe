// Token economy for the agentic turn loops (2026-07-16).
//
// WHY this exists: a live incident burned a $20 Anthropic top-up in 34 minutes.
// Three compounding causes in the runtime loops (runtime.ts executeTurn and
// stateless-turn.ts runStatelessAgentTurn):
//   1. Tool outputs (e.g. composio GMAIL_FETCH_EMAILS — full message payloads)
//      were JSON.stringify'd into the conversation UNTRUNCATED,
//   2. then re-sent on EVERY loop iteration (and, for the live runtime, on every
//      later turn of the conversation via the history rebuild) with NO prompt
//      caching,
//   3. on the premium model (write tools bump the adaptive selector every turn).
// This module is the shared fix for 1 and 2: hard caps on what a tool result may
// feed back to the model, and cache_control helpers so the static prefix
// (system + tools) and the growing message prefix are billed at cache-read
// price instead of full input price on every call.
//
// Everything here is PURE and never throws — a turn must never break (or
// silently get pricier) because of token accounting.

/** Max chars of a single serialized tool result fed back to the model.
 *  ~5k tokens. Matches the order of magnitude of the web-onboarding
 *  CANDIDATE_MD_MAX_CHARS precedent (supplementary context, not the primary
 *  document). A tool that genuinely needs to hand the model more should
 *  return a tighter shape, not a bigger blob. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

/** Per-tool overrides of TOOL_RESULT_MAX_CHARS, keyed by the WRAPPED tool name
 *  the model calls. Deliberately minimal: ONE read-only Doc-text tool whose
 *  whole value is the full text (owner decision 2026-10-21, "option B"). The
 *  acceptance document's plain text is 72,097 bytes; 80,000 chars leaves ~10%
 *  headroom for JSON escaping (newlines/quotes) and the result envelope. Every
 *  other tool keeps the 20k default. Over-limit results are still truncated
 *  WITH the explicit marker — never silently. */
export const TOOL_RESULT_CAP_OVERRIDES: Readonly<Record<string, number>> = {
  composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT: 80_000,
};

/** The result cap for a given (wrapped) tool name: its override, else the
 *  20k default. Unknown/absent names get the default. */
export function toolResultCapFor(toolName: string | undefined | null): number {
  if (toolName && Object.prototype.hasOwnProperty.call(TOOL_RESULT_CAP_OVERRIDES, toolName)) {
    return TOOL_RESULT_CAP_OVERRIDES[toolName]!;
  }
  return TOOL_RESULT_MAX_CHARS;
}

/** The default over-cap guidance (unchanged wording for every tool that has
 *  no specific hint). */
export const DEFAULT_TRUNCATION_HINT =
  "Ask for a narrower query (fewer items / specific ids) if you need more.";

/** Per-tool over-cap guidance. The Docs plain-text read has NO paging/range
 *  argument, so suggesting a "narrower query" would be false; it tells the
 *  model the read is partial and must be reported as such. The marker prefix
 *  ("[tool result truncated: showing X of Y chars.") is identical for every
 *  tool - the agent instructions key on it. */
export const TOOL_TRUNCATION_HINTS: Readonly<Record<string, string>> = {
  composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT:
    "This document is longer than the per-read limit and this tool cannot read further; tell the user the read is PARTIAL (only the first part was read).",
};

/** Serialize ONE tool output for the model with that tool's cap + hint. The
 *  single entry point every model-facing tool_result site uses (stateless
 *  loop, live loop, live history rebuild). */
export function toolResultContentFor(
  toolName: string | undefined | null,
  output: unknown,
): string {
  const hint =
    toolName && Object.prototype.hasOwnProperty.call(TOOL_TRUNCATION_HINTS, toolName)
      ? TOOL_TRUNCATION_HINTS[toolName]!
      : DEFAULT_TRUNCATION_HINT;
  return serializeToolResultCapped(output, toolResultCapFor(toolName), hint);
}

/** Rebuild a past turn's tool_result blocks for the history replay. Results
 *  carry only the call id, so the tool NAME (which selects the per-tool cap)
 *  is mapped from that turn's tool calls; an unmatched id gets the default.
 *  Failed results keep the capped error text. Pure. */
export function historyToolResultBlocks(
  toolCalls: ReadonlyArray<{ id: string; name: string }> | null | undefined,
  toolResults: ReadonlyArray<{ toolCallId: string; ok: boolean; output?: unknown; error?: string }>,
): Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }> {
  const nameById = new Map((toolCalls ?? []).map((tc) => [tc.id, tc.name] as const));
  return toolResults.map((tr) => ({
    type: "tool_result" as const,
    tool_use_id: tr.toolCallId,
    content: tr.ok
      ? toolResultContentFor(nameById.get(tr.toolCallId), tr.output)
      : `Error: ${capErrorText(tr.error ?? "unknown")}`,
    is_error: !tr.ok,
  }));
}

/** Max chars of a tool ERROR message fed back to the model. Connector errors
 *  can embed whole upstream response bodies; the model only needs the head to
 *  recover. */
export const TOOL_ERROR_MAX_CHARS = 2_000;

/**
 * JSON.stringify a tool output for a tool_result block, hard-capped.
 * - `undefined`/`null` → "null" (same as the previous inline behavior).
 * - Unserializable (circular, BigInt, throwing getter) → a fixed marker string
 *   instead of a thrown error.
 * - Over `cap` chars → truncated with an explicit marker telling the model
 *   what happened, so it can narrow its query instead of hallucinating the
 *   missing tail.
 */
export function serializeToolResultCapped(
  output: unknown,
  cap: number = TOOL_RESULT_MAX_CHARS,
  hint: string = DEFAULT_TRUNCATION_HINT,
): string {
  let json: string;
  try {
    json = JSON.stringify(output ?? null) ?? "null";
  } catch {
    return "[tool result was not serializable]";
  }
  if (json.length <= cap) return json;
  return (
    json.slice(0, cap) +
    `\n…[tool result truncated: showing ${cap} of ${json.length} chars. ` +
    `${hint}]`
  );
}

/** Cap a tool error message (kept as plain text, head is the useful part). */
export function capErrorText(
  message: string,
  cap: number = TOOL_ERROR_MAX_CHARS,
): string {
  if (typeof message !== "string") return String(message);
  if (message.length <= cap) return message;
  return message.slice(0, cap) + `…[error truncated at ${cap} chars]`;
}

/** The one cache marker shape the Messages API accepts. */
type CacheControl = { type: "ephemeral" };

/**
 * Wrap a plain system prompt string as a cache-marked system block array.
 * The system prompt is static across every call of a run (and every turn of a
 * conversation), so it is always worth a breakpoint. An empty/blank prompt is
 * returned verbatim (the API rejects empty text blocks; the caller's existing
 * behavior for a blank prompt is preserved).
 */
export function cachedSystemBlocks(
  systemPrompt: string,
): string | Array<{ type: "text"; text: string; cache_control: CacheControl }> {
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    return systemPrompt;
  }
  return [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];
}

/**
 * Add a cache breakpoint to the LAST tool of a tools array (a breakpoint
 * caches everything up to and including its block, so one marker on the last
 * tool caches the whole tool-schema prefix). Returns a NEW array with a copied
 * last element — never mutates the input. Empty array → returned as-is.
 */
export function cachedToolParams<T extends object>(
  tools: T[],
): Array<T | (T & { cache_control: CacheControl })> {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [
    ...tools.slice(0, -1),
    { ...last, cache_control: { type: "ephemeral" } },
  ];
}

/** The loose message shape both runtime loops use (string content on seeded
 *  turns; block arrays mid-loop). Structural on purpose — each loop has its own
 *  local AnthropicMessage type and casts to the SDK param type at the call
 *  site. */
export type LooseMessage = {
  role: string;
  content: string | Array<Record<string, unknown>>;
};

/**
 * Return a NEW messages array where the last content block of the last message
 * carries a cache breakpoint — the "moving breakpoint" pattern for an agentic
 * loop: iteration N+1's prefix (everything through iteration N's tool results)
 * is then a cache hit instead of full-price input.
 *
 * Copy-on-write: only the last message (and its last block) are copied; the
 * caller's working array and every other message object are untouched, so
 * markers never accumulate across iterations (each call re-derives from the
 * clean working array).
 *
 * Edge handling (all preserve existing behavior rather than "fixing" it):
 * - empty array → returned as-is;
 * - last message with a non-empty string content → converted (in the copy) to
 *   a single text block carrying the marker;
 * - last message with an EMPTY string content or an empty block array →
 *   returned as-is (no marker; the API call behaves exactly as before).
 */
export function withMovingCacheBreakpoint(
  messages: LooseMessage[],
): LooseMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") {
    if (last.content === "") return messages;
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        content: [
          {
            type: "text",
            text: last.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ];
  }
  if (!Array.isArray(last.content) || last.content.length === 0) {
    return messages;
  }
  const lastBlock = last.content[last.content.length - 1];
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [
        ...last.content.slice(0, -1),
        { ...lastBlock, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
}
