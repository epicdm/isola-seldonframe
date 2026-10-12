import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolvePlatformBranding } from "../../../src/lib/branding/platform";
import {
  DEFAULT_PERSONAL_LINE_URL,
  isPersonalLineSignupOpen,
  resolveStorefront,
} from "../../../src/lib/branding/storefront";
import { PlatformStorefront } from "../../../src/components/branding/platform-storefront";

const uplinkEnv = {
  PLATFORM_NAME: "Uplink",
  PLATFORM_OPERATOR_NAME: "EPIC",
  PLATFORM_APP_URL: "https://uplink.epic.dm",
  PLATFORM_HOME_URL: "https://uplink.epic.dm",
  PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
};

function render(extra: Record<string, string | undefined> = {}) {
  const env = { ...uplinkEnv, ...extra };
  const brand = resolvePlatformBranding(env);
  return renderToStaticMarkup(<PlatformStorefront brand={brand} config={resolveStorefront(brand, env)} />);
}

// Words the page must never carry while these capabilities are out of scope.
const FORBIDDEN = /coming soon|incoming|fiserv|unlimited|seldonframe|voice ai|stay tuned/i;

describe("platform storefront: Personal Line sign-up switch", () => {
  it("POSITIVE CONTROL: with the switch set to open, the real sign-up CTA is rendered and points at the workspace page", () => {
    const html = render({ PLATFORM_PERSONAL_LINE_SIGNUP: "open" });
    assert.match(html, /data-signup-state="open"/);
    assert.match(html, new RegExp(`href="${DEFAULT_PERSONAL_LINE_URL.replace(/[.]/g, "\\.")}"`));
    assert.match(html, /Start your free trial/);
    assert.doesNotMatch(html, /temporarily unavailable/);
    assert.doesNotMatch(html, /data-signup-state="unavailable"/);
  });

  it("is case/space tolerant for the open value", () => {
    assert.equal(isPersonalLineSignupOpen({ PLATFORM_PERSONAL_LINE_SIGNUP: " OPEN " }), true);
  });

  for (const [label, value] of [["unset", undefined], ["paused", "paused"], ["empty", ""], ["true (not the documented value)", "true"], ["1", "1"]] as const) {
    it(`OUTAGE MODE (${label}): no sign-up link, an honest unavailable notice, a contact route`, () => {
      const html = render({ PLATFORM_PERSONAL_LINE_SIGNUP: value });
      assert.match(html, /data-signup-state="unavailable"/);
      assert.match(html, /Sign-up temporarily unavailable/);
      assert.match(html, /We do not have a date to announce yet/);
      assert.match(html, /role="status"/);
      assert.doesNotMatch(html, /data-signup-state="open"/);
      assert.doesNotMatch(html, /Start your free trial/);
      // No dead button: nothing in the Personal Line card links to the workspace page.
      assert.equal(html.includes(DEFAULT_PERSONAL_LINE_URL), false);
      assert.match(html, /mailto:uplink@epic\.dm\?subject=Personal%20Line/);
    });
  }

  it("ignores a non-https or credentialed workspace URL and falls back to the default", () => {
    const brand = resolvePlatformBranding(uplinkEnv);
    for (const bad of ["http://evil.example", "javascript:alert(1)", "https://user:pw@evil.example", "not a url"]) {
      const cfg = resolveStorefront(brand, { PLATFORM_PERSONAL_LINE_SIGNUP: "open", PLATFORM_PERSONAL_LINE_URL: bad });
      assert.equal(cfg.personalLine.ctaHref, DEFAULT_PERSONAL_LINE_URL, bad);
    }
    const ok = resolveStorefront(brand, { PLATFORM_PERSONAL_LINE_SIGNUP: "open", PLATFORM_PERSONAL_LINE_URL: "https://pl.example.test/" });
    assert.equal(ok.personalLine.ctaHref, "https://pl.example.test");
  });
});

describe("platform storefront: content and claims", () => {
  for (const mode of ["open", "paused"]) {
    it(`renders the three entry points and EPIC branding in ${mode} mode`, () => {
      const html = render({ PLATFORM_PERSONAL_LINE_SIGNUP: mode });
      assert.match(html, /data-entry="personal-line"/);
      assert.match(html, /data-entry="business-services"/);
      assert.match(html, /data-entry="workspace-sign-in"/);
      assert.match(html, /href="https:\/\/uplink\.epic\.dm\/login"/);
      assert.match(html, /Uplink by EPIC|Uplink<\/span>|by EPIC/);
      assert.match(html, /href="\/license"/);
      assert.match(html, /Open-source notices/);
    });

    it(`carries no out-of-scope claims in ${mode} mode (scope: free trial, outgoing calling only)`, () => {
      const html = render({ PLATFORM_PERSONAL_LINE_SIGNUP: mode });
      assert.doesNotMatch(html, FORBIDDEN);
      assert.match(html, /outgoing calling/);
      assert.match(html, /no SMS and no emergency calling/);
    });
  }

  it("CONTROL: the forbidden-claims pattern does fire on text that contains them", () => {
    for (const bad of ["Coming soon", "receive incoming calls", "Pay with Fiserv", "unlimited minutes", "Powered by SeldonFrame", "Stay tuned"]) {
      assert.match(bad, FORBIDDEN, bad);
    }
  });
});
