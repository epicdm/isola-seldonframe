import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlatformVerificationEmailSender, formatBrandedSender, hasPlatformSignInEmailTransport, renderPlatformSignInEmail } from "../../../src/lib/auth/signin-email";
import { resolvePlatformBranding } from "../../../src/lib/branding/platform";

describe("platform sign-in email branding", () => {
  it("uses configured Uplink identity, canonical links and contact without vendor marketing links", () => {
    const branding = resolvePlatformBranding({
      PLATFORM_NAME: "Uplink",
      PLATFORM_APP_URL: "https://uplink.epic.dm",
      PLATFORM_HOME_URL: "https://uplink.epic.dm",
      PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
      PLATFORM_EMAIL_FROM_NAME: "Uplink by EPIC",
      PLATFORM_EMAIL_FOOTER: "Uplink is operated by EPIC",
      PLATFORM_LOGO_URL: "/brand/uplink.svg",
      SHOW_VENDOR_BRANDING: "false",
    });
    const rendered = renderPlatformSignInEmail({
      url: "https://uplink.epic.dm/api/auth/callback/resend?token=synthetic",
      baseUrl: "https://uplink.epic.dm",
      branding,
    });
    assert.match(rendered.subject, /Uplink/);
    assert.match(rendered.html, /Sign in to Uplink/);
    assert.match(rendered.html, /uplink@epic\.dm/);
    assert.match(rendered.html, /https:\/\/uplink\.epic\.dm\/license/);
    assert.doesNotMatch(rendered.html, /seldonframe\.com/);
    assert.equal(formatBrandedSender("info@epic.dm", branding.emailFromName), "Uplink by EPIC <info@epic.dm>");
  });

  it("escapes the platform name and retains upstream identity by default", () => {
    const branding = resolvePlatformBranding({});
    const rendered = renderPlatformSignInEmail({ url: "https://app.seldonframe.com/login", baseUrl: branding.appUrl, branding });
    assert.match(rendered.html, /Sign in to SeldonFrame/);
    assert.match(rendered.text, /The SeldonFrame team/);
    assert.equal(formatBrandedSender("not-an-email", "Uplink"), "not-an-email");
  });

  it("sends the Auth.js verification email through configured SMTP2GO with the Uplink template", async () => {
    const env = {
      SMTP2GO_API_KEY: "synthetic-smtp-key",
      PORTAL_EMAIL_FROM: "info@epic.dm",
      PLATFORM_NAME: "Uplink",
      PLATFORM_OPERATOR_NAME: "EPIC",
      PLATFORM_APP_URL: "https://uplink.epic.dm",
      PLATFORM_HOME_URL: "https://uplink.epic.dm",
      PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
      PLATFORM_EMAIL_FROM_NAME: "Uplink by EPIC",
      PLATFORM_EMAIL_FOOTER: "Uplink is operated by EPIC",
      NEXTAUTH_URL: "https://uplink.epic.dm",
    };
    assert.equal(hasPlatformSignInEmailTransport(env), true);

    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const sendVerificationRequest = createPlatformVerificationEmailSender({
      env,
      fetcher: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ data: { succeeded: 1, email_id: "synthetic-message" } }), { status: 200 });
      },
    });
    await sendVerificationRequest(
      {
        identifier: "synthetic-owner@example.test",
        url: "https://uplink.epic.dm/api/auth/callback/resend?token=synthetic-token",
        provider: { apiKey: "unused-placeholder", from: "Uplink by EPIC <info@epic.dm>" },
      },
    );

    assert.equal(requestUrl, "https://api.smtp2go.com/v3/email/send");
    assert.equal(new Headers(requestInit?.headers).get("X-Smtp2go-Api-Key"), "synthetic-smtp-key");
    const payload = JSON.parse(String(requestInit?.body)) as { sender: string; to: string[]; subject: string; html_body: string; text_body: string };
    assert.equal(payload.sender, "Uplink by EPIC <info@epic.dm>");
    assert.deepEqual(payload.to, ["synthetic-owner@example.test"]);
    assert.match(payload.subject, /Uplink/);
    assert.match(payload.html_body, /Sign in to Uplink/);
    assert.match(payload.html_body, /https:\/\/uplink\.epic\.dm\/license/);
    assert.doesNotMatch(payload.html_body, /seldonframe\.com/);
    assert.match(payload.text_body, /Uplink is operated by EPIC/);
  });

  it("enables email sign-in only when a usable send transport is configured", () => {
    assert.equal(hasPlatformSignInEmailTransport({}), false);
    assert.equal(hasPlatformSignInEmailTransport({ SMTP2GO_API_KEY: "synthetic-key" }), false);
    assert.equal(hasPlatformSignInEmailTransport({ SMTP2GO_API_KEY: "synthetic-key", PORTAL_EMAIL_FROM: "info@epic.dm" }), true);
    assert.equal(hasPlatformSignInEmailTransport({ AUTH_RESEND_KEY: "synthetic-resend-key" }), true);
  });

  it("uses the configured Resend sender when SMTP2GO is not selected", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const sendVerificationRequest = createPlatformVerificationEmailSender({
      env: {
        AUTH_RESEND_KEY: "synthetic-resend-key",
        AUTH_RESEND_FROM: "Uplink <mailer@epic.dm>",
        PLATFORM_NAME: "Uplink",
        PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
        PLATFORM_APP_URL: "https://uplink.epic.dm",
      },
      fetcher: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ id: "synthetic-message" }), { status: 200 });
      },
    });

    await sendVerificationRequest({
      identifier: "synthetic-owner@example.test",
      url: "https://uplink.epic.dm/api/auth/callback/resend?token=synthetic-token",
      provider: { apiKey: "synthetic-resend-key", from: "Uplink <mailer@epic.dm>" },
    });

    assert.equal(requestUrl, "https://api.resend.com/emails");
    assert.equal(new Headers(requestInit?.headers).get("Authorization"), "Bearer synthetic-resend-key");
    const payload = JSON.parse(String(requestInit?.body)) as { from: string; subject: string; html: string };
    assert.equal(payload.from, "Uplink <mailer@epic.dm>");
    assert.match(payload.subject, /Uplink/);
    assert.match(payload.html, /https:\/\/uplink\.epic\.dm\/license/);
  });
});
