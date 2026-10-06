import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getPlatformBranding } from "../../../src/lib/platform/branding";

describe("platform branding", () => {
  test("custom Uplink branding does not fall back to SeldonFrame assets or support claims", () => {
    const branding = getPlatformBranding({
      PLATFORM_NAME: "Uplink",
      PLATFORM_APP_URL: "https://uplink.epic.dm",
      NEXT_PUBLIC_APP_URL: "https://uplink.epic.dm",
      AUTH_URL: "https://uplink.epic.dm",
      SHOW_VENDOR_BRANDING: "false",
    });

    assert.equal(branding.name, "Uplink");
    assert.equal(branding.appUrl, "https://uplink.epic.dm");
    assert.equal(branding.homeUrl, "https://uplink.epic.dm");
    assert.equal(branding.logoUrl, "");
    assert.equal(branding.faviconUrl, "");
    assert.equal(branding.supportEmail, "");
    assert.equal(branding.showVendorBranding, false);
  });

  test("SeldonFrame defaults remain intact when no Uplink values are supplied", () => {
    const branding = getPlatformBranding({});
    assert.equal(branding.name, "SeldonFrame");
    assert.equal(branding.appUrl, "https://app.seldonframe.com");
    assert.equal(branding.homeUrl, "https://www.seldonframe.com");
    assert.equal(branding.showVendorBranding, true);
    assert.equal(branding.supportEmail, "support@seldonframe.com");
  });
});
