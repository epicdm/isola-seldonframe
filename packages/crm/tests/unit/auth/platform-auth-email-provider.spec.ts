import assert from "node:assert/strict";
import { it } from "node:test";

it("routes the configured Auth.js verification callback through SMTP2GO", async () => {
  const names = [
    "SMTP2GO_API_KEY",
    "PORTAL_EMAIL_FROM",
    "AUTH_RESEND_KEY",
    "RESEND_API_KEY",
    "PLATFORM_NAME",
    "PLATFORM_OPERATOR_NAME",
    "PLATFORM_APP_URL",
    "PLATFORM_HOME_URL",
    "PLATFORM_SUPPORT_EMAIL",
    "PLATFORM_EMAIL_FROM_NAME",
    "PLATFORM_EMAIL_FOOTER",
    "NEXTAUTH_URL",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    SMTP2GO_API_KEY: "synthetic-smtp-key",
    PORTAL_EMAIL_FROM: "info@epic.dm",
    AUTH_RESEND_KEY: "stale-resend-placeholder",
    RESEND_API_KEY: "stale-resend-placeholder",
    PLATFORM_NAME: "Uplink",
    PLATFORM_OPERATOR_NAME: "EPIC",
    PLATFORM_APP_URL: "https://uplink.epic.dm",
    PLATFORM_HOME_URL: "https://uplink.epic.dm",
    PLATFORM_SUPPORT_EMAIL: "uplink@epic.dm",
    PLATFORM_EMAIL_FROM_NAME: "Uplink by EPIC",
    PLATFORM_EMAIL_FOOTER: "Uplink is operated by EPIC",
    NEXTAUTH_URL: "https://uplink.epic.dm",
  });

  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ data: { succeeded: 1, email_id: "synthetic-auth-message" } }), { status: 200 });
  };

  try {
    const { authConfig } = await import("../../../src/lib/auth/config");
    const provider = authConfig.providers.find((item) => typeof item === "object" && item.id === "resend");
    assert.ok(provider && "sendVerificationRequest" in provider);

    await provider.sendVerificationRequest({
      identifier: "synthetic-owner@example.test",
      url: "https://uplink.epic.dm/api/auth/callback/resend?token=synthetic-token",
      expires: new Date("2026-10-07T12:00:00.000Z"),
      token: "synthetic-token",
      provider,
      request: new Request("https://uplink.epic.dm/api/auth/signin/resend"),
      theme: { brandColor: "#ffffff", buttonText: "#000000" },
    });

    assert.equal(requestUrl, "https://api.smtp2go.com/v3/email/send");
    assert.equal(new Headers(requestInit?.headers).get("X-Smtp2go-Api-Key"), "synthetic-smtp-key");
    const payload = JSON.parse(String(requestInit?.body)) as { sender: string; to: string[]; subject: string; html_body: string };
    assert.equal(payload.sender, "Uplink by EPIC <info@epic.dm>");
    assert.deepEqual(payload.to, ["synthetic-owner@example.test"]);
    assert.match(payload.subject, /Uplink/);
    assert.match(payload.html_body, /https:\/\/uplink\.epic\.dm\/license/);
    assert.doesNotMatch(JSON.stringify(payload), /stale-resend-placeholder|synthetic-smtp-key/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
