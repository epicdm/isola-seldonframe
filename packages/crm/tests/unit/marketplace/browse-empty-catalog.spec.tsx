import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { BrowseClient } from "../../../src/components/marketplace/browse-client";

test("branded marketplace renders its native empty state when the catalog has no listings", () => {
  const html = renderToString(<BrowseClient agents={[]} platformName="Uplink" />);

  assert.match(html, /data-marketplace-empty-catalog/);
  assert.match(html, /No published agents are available yet/);
  assert.match(html, /Check back later for listings available on/);
  assert.doesNotMatch(html, /built by undefined/);
});
