// Unit tests for sessionCoversToolkits — the reuse-or-recreate predicate for a
// cached Composio session (toolkit drift after a catalog addition).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { sessionCoversToolkits } from "../../../src/lib/integrations/composio/client";

const session = (slugs: string[]) => ({
  toolkits: async () => ({ items: slugs.map((slug) => ({ slug })) }),
});

describe("sessionCoversToolkits", () => {
  test("false when a requested toolkit is missing (drift → recreate)", async () => {
    assert.equal(await sessionCoversToolkits(session(["gmail", "googledrive"]), ["gmail", "googledocs"]), false);
  });
  test("true when every requested toolkit is present (case-insensitive)", async () => {
    assert.equal(await sessionCoversToolkits(session(["Gmail", "googledocs", "slack"]), ["gmail", "GOOGLEDOCS"]), true);
  });
  test("false when listing toolkits throws (recreate rather than trust)", async () => {
    const broken = { toolkits: async () => { throw new Error("boom"); } };
    assert.equal(await sessionCoversToolkits(broken, ["gmail"]), false);
  });
  test("false when items is absent", async () => {
    assert.equal(await sessionCoversToolkits({ toolkits: async () => ({}) }, ["gmail"]), false);
  });
});
