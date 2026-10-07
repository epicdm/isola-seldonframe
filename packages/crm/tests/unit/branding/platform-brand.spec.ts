import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPlatformOrganizationWebsiteGraph,
  resolvePlatformBranding,
  resolveWorkspaceBaseDomain,
  shouldServeBrandedRootPublicly,
  shouldHideVendorMarketingPath,
  shouldShowVendorAttribution,
} from "../../../src/lib/branding/platform";

describe("platform branding", () => {
  it("keeps safe upstream defaults when no platform branding is configured", () => {
    const branding = resolvePlatformBranding({});
    assert.equal(branding.name, "SeldonFrame");
    assert.equal(branding.appUrl, "https://app.seldonframe.com");
    assert.equal(branding.homeUrl, "https://www.seldonframe.com");
    assert.equal(branding.showVendorBranding, true);
    assert.equal(resolveWorkspaceBaseDomain({}), "app.seldonframe.com");
  });

  it("resolves Uplink identity and canonical workspace host from configuration", () => {
    const env = {
      PLATFORM_NAME: "Uplink",
      PLATFORM_OPERATOR_NAME: "EPIC",
      PLATFORM_APP_URL: "https://uplink.epic.dm",
      PLATFORM_HOME_URL: "https://uplink.epic.dm",
      PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
      PLATFORM_EMAIL_FROM_NAME: "Uplink by EPIC",
      PLATFORM_EMAIL_FOOTER: "Uplink is operated by EPIC",
      PLATFORM_LOGO_URL: "/brand/uplink.svg",
      PLATFORM_FAVICON_URL: "/brand/uplink-favicon.svg",
      PLATFORM_SOURCE_URL: "https://github.com/epicdm/isola-seldonframe",
      WORKSPACE_BASE_DOMAIN: "uplink.epic.dm",
      SHOW_VENDOR_BRANDING: "false",
    };
    const branding = resolvePlatformBranding(env);
    assert.equal(branding.name, "Uplink");
    assert.equal(branding.operatorName, "EPIC");
    assert.equal(branding.appUrl, "https://uplink.epic.dm");
    assert.equal(branding.homeUrl, "https://uplink.epic.dm");
    assert.equal(branding.supportEmail, "uplink@epic.dm");
    assert.equal(branding.logoUrl, "/brand/uplink.svg");
    assert.equal(branding.sourceUrl, "https://github.com/epicdm/isola-seldonframe");
    assert.equal(branding.showVendorBranding, false);
    assert.equal(resolveWorkspaceBaseDomain(env), "uplink.epic.dm");
  });

  it("refuses platform branding overrides that would bypass a commercial entitlement", () => {
    assert.equal(shouldShowVendorAttribution({
      configuredVisible: false,
      entitledToRemove: false,
      workspaceRequestsRemoval: true,
    }), true);
    assert.equal(shouldShowVendorAttribution({
      configuredVisible: false,
      entitledToRemove: true,
      workspaceRequestsRemoval: null,
    }), false);
    assert.equal(shouldShowVendorAttribution({
      configuredVisible: true,
      entitledToRemove: true,
      workspaceRequestsRemoval: true,
    }), false);
  });

  it("makes only a configured non-default platform root public", () => {
    assert.equal(shouldServeBrandedRootPublicly("/", "Uplink"), true);
    assert.equal(shouldServeBrandedRootPublicly("/", "SeldonFrame"), false);
    assert.equal(shouldServeBrandedRootPublicly("/login", "Uplink"), false);
    assert.equal(shouldServeBrandedRootPublicly("/", ""), false);
  });

  it("hides vendor marketing paths only on branded hosts and preserves native operations", () => {
    for (const path of [
      "/pricing",
      "/pricing-public",
      "/agencies",
      "/alternative-to-gohighlevel",
      "/gohighlevel-pricing.md",
      "/docs/mcp",
      "/.well-known/openai-apps-challenge",
      "/marketplace/build",
    ]) {
      assert.equal(shouldHideVendorMarketingPath(path, "Uplink"), true, path);
      assert.equal(shouldHideVendorMarketingPath(path, "SeldonFrame"), false, path);
    }

    for (const path of [
      "/",
      "/login",
      "/dashboard",
      "/contacts",
      "/forms",
      "/book",
      "/marketplace",
      "/marketplace/example-agent",
      "/studio/agents",
      "/api/v1/forms",
      "/api/v1/marketplace/listings",
      "/license",
    ]) {
      assert.equal(shouldHideVendorMarketingPath(path, "Uplink"), false, path);
    }
  });

  it("builds white-label structured metadata from configured platform identity", () => {
    const brand = resolvePlatformBranding({
      PLATFORM_NAME: "Uplink",
      PLATFORM_APP_URL: "https://uplink.epic.dm",
      PLATFORM_HOME_URL: "https://uplink.epic.dm",
      PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
    });
    const graph = buildPlatformOrganizationWebsiteGraph(brand, "EPIC ISP-native front office.");
    assert.equal(graph[0].name, "Uplink");
    assert.equal(graph[0].url, "https://uplink.epic.dm");
    assert.equal(graph[0].email, "uplink@epic.dm");
    const website = graph[1] as { publisher: { "@id": string } };
    assert.equal(website.publisher["@id"], "https://uplink.epic.dm/#organization");
    assert.equal(JSON.stringify(graph).includes("seldonframe"), false);
  });
});
