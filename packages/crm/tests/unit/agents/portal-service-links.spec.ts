// EPIC 2026-10-04 -- portal "Your services" links: only https links are ever rendered (positive twins included).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseServiceLinks, serviceLinksFromSettings, MAX_SERVICE_LINKS } from "../../../src/lib/portal/service-links";

describe("parseServiceLinks", () => {
  test("a valid https link is kept, trimmed and normalised", () => {
    assert.deepEqual(parseServiceLinks([{ label: "  Personal Line app  ", url: " https://app.example.test " }]), [
      { label: "Personal Line app", url: "https://app.example.test/" },
    ]);
  });
  test("javascript:, data:, http:, credentials-in-url, junk and oversize are all dropped", () => {
    const bad = [
      { label: "x", url: "javascript:alert(1)" },
      { label: "x", url: "data:text/html,<script>1</script>" },
      { label: "x", url: "http://app.example.test" },
      { label: "x", url: "https://user:pw@evil.example/" },
      { label: "x", url: "not a url" },
      { label: "", url: "https://ok.example/" },
      { label: "x".repeat(61), url: "https://ok.example/" },
      { label: "x", url: "https://ok.example/" + "a".repeat(300) },
      null,
      42,
      "https://ok.example/",
    ];
    assert.deepEqual(parseServiceLinks(bad), []);
  });
  test("control: mixed input keeps only the good entries, capped at the maximum", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, url: `https://ok${i}.example/` }));
    assert.equal(parseServiceLinks([{ label: "x", url: "javascript:1" }, ...many]).length, MAX_SERVICE_LINKS);
  });
  test("settings reader tolerates missing or wrong shapes", () => {
    for (const s of [null, undefined, {}, { portal: null }, { portal: { serviceLinks: "x" } }]) assert.deepEqual(serviceLinksFromSettings(s), []);
    assert.equal(serviceLinksFromSettings({ portal: { serviceLinks: [{ label: "A", url: "https://a.example/" }] } }).length, 1);
  });
});

describe("wiring", () => {
  const src = path.resolve(__dirname, "../../../src");
  test("portal home renders the validated links and settings saves through the validator", () => {
    const home = readFileSync(path.join(src, "app/customer/[orgSlug]/(client)/page.tsx"), "utf8");
    assert.match(home, /serviceLinksFromSettings\(orgRow\?\.settings\)/);
    assert.match(home, /rel="noopener noreferrer"/);
    const action = readFileSync(path.join(src, "lib/portal/service-links-actions.ts"), "utf8");
    assert.match(action, /parseServiceLinks\(wanted\)/);
    assert.match(action, /getOrgId\(\)/);
    const settings = readFileSync(path.join(src, "app/(dashboard)/settings/client-portal/page.tsx"), "utf8");
    assert.match(settings, /<PortalServiceLinksForm/);
  });
});
