import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { parseLifecycleEvent, PL_LIFECYCLE_TYPES } from "../../../src/lib/personal-line/lifecycle";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/personal-line-lifecycle-events.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, string>;

describe("Personal Line lifecycle protocol fixture", () => {
  test("contains one valid payload for every supported lifecycle type", () => {
    assert.deepEqual(Object.keys(fixture).sort(), [...PL_LIFECYCLE_TYPES].sort());
    for (const [type, raw] of Object.entries(fixture)) {
      const event = parseLifecycleEvent(raw);
      assert.ok(event, `${type} should satisfy the signed lifecycle contract`);
      assert.equal(event.type, type);
    }
  });
});
