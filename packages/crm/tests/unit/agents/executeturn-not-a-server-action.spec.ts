// SECURITY regression guard — def-uplink-executeturn-exposed-as-server-action-2026-10-21.
//
// executeTurn (lib/agents/runtime.ts) authenticates no caller: it resolves
// conversation -> agent -> org purely from the caller-supplied conversationId.
// While runtime.ts carried the "use server" directive, Next registered
// executeTurn as a dispatchable Server Action on every dashboard page that
// transitively imports it; /agents/* is not in the proxy matcher, so an
// unauthenticated POST to /agents/<id> with that action id reached executeTurn
// (reproduced on tenantscope-ba9e57fe). The fix removes the directive so no
// action id is ever minted. This guard fails if the directive comes back.
//
// Run: node --import tsx --test tests/unit/agents/executeturn-not-a-server-action.spec.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// A module is a "use server" module when "use server" appears anywhere in the
// directive prologue — the leading run of string-literal statements, before the
// first non-directive statement. The scanner tolerates the real-world variants
// Codex flagged: no semicolon, a trailing line comment, single or double
// quotes, and a preceding directive such as "use strict".
function hasModuleLevelUseServerDirective(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^[ \t]*\/\/.*$/gm, ""); // whole-line comments
  for (const rawLine of withoutComments.split("\n")) {
    // strip a trailing line comment and surrounding whitespace / semicolon
    const line = rawLine.replace(/\/\/.*$/, "").trim().replace(/;+\s*$/, "").trim();
    if (line === "") continue;
    // A directive is a bare string literal. Keep consuming consecutive
    // directives (e.g. "use strict" then "use server"); stop at the first
    // statement that is not a string literal.
    const directive = line.match(/^(['"])((?:use [a-z-]+))\1$/);
    if (!directive) return false;
    if (directive[2] === "use server") return true;
    // else it was another directive (e.g. "use strict") — keep scanning.
  }
  return false;
}

describe("executeTurn is not exposed as a Server Action", () => {
  test("positive control: the detector recognises a genuine 'use server' module", () => {
    // test-actions.ts is a real "use server" module in this repo.
    assert.equal(hasModuleLevelUseServerDirective(read("src/lib/agent-templates/test-actions.ts")), true);
    // and recognises the directive even behind leading comments / blank lines
    assert.equal(hasModuleLevelUseServerDirective('// c\n\n"use server";\nimport x from "y";'), true);
    // variant directives Codex flagged must still be caught:
    assert.equal(hasModuleLevelUseServerDirective('"use server"\nimport x from "y";'), true, "no semicolon");
    assert.equal(hasModuleLevelUseServerDirective('"use server"; // re-enable\nimport x from "y";'), true, "trailing comment");
    assert.equal(hasModuleLevelUseServerDirective("'use server';\nimport x from 'y';"), true, "single quotes");
    assert.equal(hasModuleLevelUseServerDirective('"use strict";\n"use server";\nimport x from "y";'), true, "after use strict");
    // and does NOT fire on the word inside a comment or mid-file
    assert.equal(hasModuleLevelUseServerDirective('// mentions "use server" in prose\nimport x from "y";'), false);
    assert.equal(hasModuleLevelUseServerDirective('import x from "y";\n"use server";'), false);
    assert.equal(hasModuleLevelUseServerDirective('const x = "use server";\n'), false, "assignment, not a directive");
  });

  test("runtime.ts does NOT declare 'use server' (so executeTurn cannot be dispatched as an action)", () => {
    const runtime = read("src/lib/agents/runtime.ts");
    assert.equal(hasModuleLevelUseServerDirective(runtime), false);
    // executeTurn is still exported for server-internal callers.
    assert.match(runtime, /export async function executeTurn\(/);
  });
});
