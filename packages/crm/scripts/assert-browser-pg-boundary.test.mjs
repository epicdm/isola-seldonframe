import assert from "node:assert/strict";
import test from "node:test";
import { findNodePgBrowserMarkers, NODE_PG_BROWSER_MARKERS } from "./assert-browser-pg-boundary.mjs";

test("browser boundary guard catches seeded PostgreSQL runtime signatures", () => {
  const seededRuntime = `class ConnectionParameters {} import { Pool } from "pg-pool";`;
  assert.deepEqual(findNodePgBrowserMarkers([seededRuntime]), ["ConnectionParameters", "pg-pool"]);
});

test("browser boundary guard accepts ordinary UI code without driver signatures", () => {
  const ordinaryUi = `export function ContactBadge({ name }) { return name; }`;
  assert.deepEqual(findNodePgBrowserMarkers([ordinaryUi]), []);
});

test("all checked markers are unique and non-empty", () => {
  assert.equal(new Set(NODE_PG_BROWSER_MARKERS).size, NODE_PG_BROWSER_MARKERS.length);
  assert.ok(NODE_PG_BROWSER_MARKERS.every((marker) => marker.length > 0));
});
