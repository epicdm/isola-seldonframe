import test from "node:test";
import assert from "node:assert/strict";
import { findNodePgBrowserMarkers } from "../../scripts/assert-browser-pg-boundary.mjs";

test("browser bundle guard accepts ordinary client code and the fail-closed stub", () => {
  assert.deepEqual(findNodePgBrowserMarkers([
    "client code",
    "PostgreSQL is unavailable in browser builds",
  ]), []);
});

test("browser bundle guard rejects node-postgres networking/runtime modules", () => {
  assert.deepEqual(
    findNodePgBrowserMarkers(["chunk with pg-protocol and ConnectionParameters"]),
    ["ConnectionParameters", "pg-protocol"],
  );
});
