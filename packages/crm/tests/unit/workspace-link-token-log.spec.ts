import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("claim-link mint failures log a fixed reason, never exception details", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../src/app/api/v1/workspace/[id]/link-owner/route.ts"),
    "utf8",
  );
  const blocks = [...source.matchAll(/catch\s*\{\s*logEvent\(\s*"magic_link_mint_failed(?:_on_relink)?"([\s\S]*?)\);/g)];
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.match(block[1], /reason:\s*"verification_token_mint_failed"/);
    assert.doesNotMatch(block[1], /error|exception|token_value|url/i);
  }
});
