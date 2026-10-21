// Per-tool tool-result cap (owner option B, 2026-10-21): ONLY the read-only
// Google Docs plain-text read gets a larger cap (80k) so a 72,097-char document
// arrives complete; every other tool keeps 20k; over-limit is NEVER silent.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  serializeToolResultCapped,
  toolResultCapFor,
  TOOL_RESULT_MAX_CHARS,
} from "../../../src/lib/agents/turn-token-economy";

const DOC_TOOL = "composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT";

/** A realistic plain-text document of exactly `len` chars ending in a known
 *  last section (newlines + quotes so JSON escaping grows the payload). */
export function docFixture(len: number): string {
  const tail = '\n## FINAL SECTION\nAction: ship it "today".\n';
  let body = "";
  let i = 0;
  while (body.length < len - tail.length) {
    body += `Section ${i}: "Item" line with some text.\n`;
    i += 1;
  }
  return body.slice(0, len - tail.length) + tail;
}

describe("toolResultCapFor", () => {
  test("the Docs plain-text read gets 80k", () => {
    assert.equal(toolResultCapFor(DOC_TOOL), 80_000);
  });
  test("every other name keeps the 20k default (incl. bare slug and prototype keys)", () => {
    for (const name of [
      "composio__GMAIL_FETCH_EMAILS",
      "composio__GOOGLEDRIVE_DOWNLOAD_FILE",
      "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT",
      "look_up_availability",
      "__proto__",
      "toString",
      "",
      undefined,
      null,
    ]) {
      assert.equal(toolResultCapFor(name as string | undefined | null), TOOL_RESULT_MAX_CHARS, String(name));
    }
    assert.equal(TOOL_RESULT_MAX_CHARS, 20_000);
  });
});

describe("serializeToolResultCapped with the per-tool cap", () => {
  const doc = docFixture(72_097);

  test("fixture is exactly 72,097 chars and its JSON exceeds 72,097 (escaping)", () => {
    assert.equal(doc.length, 72_097);
    assert.ok(JSON.stringify(doc).length > 72_097);
  });

  test("a 72,097-char document returns COMPLETE for the Docs tool (no marker, last section present)", () => {
    const out = serializeToolResultCapped(doc, toolResultCapFor(DOC_TOOL));
    assert.equal(out, JSON.stringify(doc));
    assert.ok(!out.includes("tool result truncated"));
    assert.ok(out.includes("## FINAL SECTION"));
  });

  test("an over-limit document carries the explicit notice with returned/total sizes", () => {
    const big = docFixture(95_000);
    const json = JSON.stringify(big);
    const out = serializeToolResultCapped(big, toolResultCapFor(DOC_TOOL));
    assert.ok(out.startsWith(json.slice(0, 80_000)));
    assert.ok(out.includes(`[tool result truncated: showing 80000 of ${json.length} chars.`));
    assert.ok(!out.includes("## FINAL SECTION"));
  });

  test("control: the same 72,097-char payload from any other tool is still capped at 20k with the notice", () => {
    const out = serializeToolResultCapped(doc, toolResultCapFor("composio__GMAIL_FETCH_EMAILS"));
    assert.ok(out.includes(`showing 20000 of ${JSON.stringify(doc).length} chars.`));
    assert.ok(!out.includes("## FINAL SECTION"));
  });
});
