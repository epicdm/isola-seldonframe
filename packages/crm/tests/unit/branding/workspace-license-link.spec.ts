import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "node:test";
import { LicenseNoticeLink } from "../../../src/components/legal/license-notice-link";

it("keeps the legal notice link on the customer's current workspace host", () => {
  const html = renderToStaticMarkup(createElement(LicenseNoticeLink));
  assert.match(html, /href="\/license"/);
  assert.match(html, /AGPL-3\.0/);
});
