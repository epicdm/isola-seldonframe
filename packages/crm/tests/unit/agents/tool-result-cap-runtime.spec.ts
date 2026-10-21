// Review follow-ups on the per-tool cap (2026-10-21):
//  (1) completeness at the MEASURED size: the acceptance doc's worst-case model
//      payload (Drive CRLF export wrapped as {document_id,title,plain_text})
//      measured 74,549 JSON chars read-only; a quote/CRLF-heavy envelope of
//      exactly that size must arrive complete under the Docs cap.
//  (2) the live loop + the live history rebuild (turn 2) use the SAME helpers
//      runtime.ts calls (toolResultContentFor / historyToolResultBlocks) and
//      keep the 80k Docs cap; other tools / unmatched ids keep 20k.
//  (3) the Docs over-limit notice never suggests a "narrower query" (the tool
//      cannot page); other tools keep the default hint.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRUNCATION_HINT,
  historyToolResultBlocks,
  toolResultContentFor,
} from "../../../src/lib/agents/turn-token-economy";

const DOC = "composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT";
const GMAIL = "composio__GMAIL_FETCH_EMAILS";
const MEASURED_ENVELOPE_JSON_LEN = 74_549;

/** A {document_id,title,plain_text} envelope whose JSON is EXACTLY `target`
 *  chars, with CRLF + double-quote heavy text (worst case for escaping) and a
 *  known final section. */
function envelopeOfJsonLength(target: number) {
  const tail = "\r\n## FINAL SECTION\r\nAction: confirm \"go-live\" date.\r\n";
  const base = { document_id: "1DYj-3priOo6du7ydzPyQAjZQ_IVnoFZNqW88Pm6GDQk", title: "t".repeat(58) };
  const len = (text: string) => JSON.stringify({ ...base, plain_text: text }).length;
  let body = "";
  let i = 0;
  const line = (n: number) => `Item ${n}: "Owner" said "done"\r\n`;
  while (len(body + line(i) + tail) <= target) {
    body += line(i);
    i += 1;
  }
  const pad = target - len(body + tail);
  const text = body + "x".repeat(pad) + tail;
  return { ...base, plain_text: text };
}

describe("(1) completeness at the measured envelope size", () => {
  const env = envelopeOfJsonLength(MEASURED_ENVELOPE_JSON_LEN);

  test("fixture is exactly the measured size and escape-heavy", () => {
    assert.equal(JSON.stringify(env).length, MEASURED_ENVELOPE_JSON_LEN);
    assert.ok((env.plain_text.match(/"/g) ?? []).length > 3_000);
    assert.ok((env.plain_text.match(/\r\n/g) ?? []).length > 1_500);
  });

  test("the Docs read of a 74,549-char envelope reaches the model complete", () => {
    const out = toolResultContentFor(DOC, env);
    assert.equal(out, JSON.stringify(env));
    assert.ok(out.includes("FINAL SECTION"));
    assert.ok(!out.includes("tool result truncated"));
  });

  test("control: the same envelope from Gmail is truncated at 20k with the notice", () => {
    const out = toolResultContentFor(GMAIL, env);
    assert.ok(out.includes(`showing 20000 of ${MEASURED_ENVELOPE_JSON_LEN} chars.`));
  });
});

describe("(2) live loop + history rebuild keep the Docs cap on turn 2", () => {
  const env = envelopeOfJsonLength(MEASURED_ENVELOPE_JSON_LEN);
  const big = { messages: [{ messageId: "m1", messageText: "y".repeat(30_000) }] };

  test("live loop (toolResultContentFor, as runtime.ts/stateless-turn.ts call it)", () => {
    assert.equal(toolResultContentFor(DOC, env), JSON.stringify(env));
    assert.ok(toolResultContentFor(GMAIL, big).includes("showing 20000 of"));
  });

  test("history rebuild maps call id -> tool name: Docs stays complete on turn 2; others/unmatched capped", () => {
    const blocks = historyToolResultBlocks(
      [
        { id: "t1", name: DOC },
        { id: "t2", name: GMAIL },
      ],
      [
        { toolCallId: "t1", ok: true, output: env },
        { toolCallId: "t2", ok: true, output: big },
        { toolCallId: "t3", ok: true, output: env }, // no matching call -> default cap
        { toolCallId: "t4", ok: false, error: "E".repeat(5_000) },
      ],
    );
    assert.equal(blocks.length, 4);
    assert.deepEqual(blocks.map((b) => b.tool_use_id), ["t1", "t2", "t3", "t4"]);
    assert.equal(blocks[0].content, JSON.stringify(env));
    assert.equal(blocks[0].is_error, false);
    assert.ok(blocks[1].content.includes("showing 20000 of"));
    assert.ok(blocks[2].content.includes(`showing 20000 of ${MEASURED_ENVELOPE_JSON_LEN} chars.`));
    assert.ok(blocks[3].content.startsWith("Error: "));
    assert.ok(blocks[3].content.includes("[error truncated at 2000 chars]"));
    assert.equal(blocks[3].is_error, true);
  });

  test("history rebuild with no tool calls recorded falls back to 20k (never larger)", () => {
    const [b] = historyToolResultBlocks(undefined, [{ toolCallId: "t1", ok: true, output: env }]);
    assert.ok(b.content.includes("showing 20000 of"));
  });
});

describe("(3) truncation notice wording", () => {
  test("Docs over-limit: explicit sizes, PARTIAL, no 'narrower query' suggestion", () => {
    const env = envelopeOfJsonLength(95_000);
    const out = toolResultContentFor(DOC, env);
    assert.ok(out.includes("[tool result truncated: showing 80000 of 95000 chars."));
    assert.ok(out.includes("PARTIAL"));
    assert.ok(!out.includes("narrower query"));
    assert.ok(!out.includes("FINAL SECTION"));
  });

  test("control: other tools keep the default hint", () => {
    const out = toolResultContentFor(GMAIL, { s: "z".repeat(25_000) });
    assert.ok(out.includes(DEFAULT_TRUNCATION_HINT));
  });
});
