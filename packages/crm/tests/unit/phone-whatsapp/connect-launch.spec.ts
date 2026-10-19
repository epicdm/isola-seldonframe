// Embedded Signup launcher (Codex review finding 3): the documented v4 launch shape, and only the standard completion is accepted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { embeddedSignupLoginOptions, hintsFromSessionMessage } from "../../../src/lib/phone-whatsapp/connect/launch";

const FB = "https://www.facebook.com";
const msg = (event: string, data: Record<string, unknown> | undefined = { waba_id: "900000000000001", phone_number_id: "900000000000002" }) =>
  JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, ...(data ? { data } : {}) });

test("launch options are the documented v4 shape: extras carries only setup {}; no v2 sessionInfoVersion/featureType, no version pin", () => {
  assert.deepEqual(embeddedSignupLoginOptions("cfg-1"), { config_id: "cfg-1", response_type: "code", override_default_response_type: true, extras: { setup: {} } });
});

test("standard Cloud API completion (FINISH) from facebook.com yields the hints", () => {
  assert.deepEqual(hintsFromSessionMessage(FB, msg("FINISH")), { wabaId: "900000000000001", phoneNumberId: "900000000000002" });
  assert.deepEqual(hintsFromSessionMessage("https://business.facebook.com", JSON.parse(msg("FINISH"))), { wabaId: "900000000000001", phoneNumberId: "900000000000002" });
});

test("other finish types, cancel/error, foreign origins and junk yield nothing (twin above)", () => {
  for (const e of ["FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_OBO_MIGRATION", "FINISH_GRANT_ONLY_API_ACCESS", "CANCEL", "ERROR"]) {
    assert.equal(hintsFromSessionMessage(FB, msg(e)), null, e);
  }
  assert.equal(hintsFromSessionMessage("https://facebook.com.evil.test", msg("FINISH")), null);
  assert.equal(hintsFromSessionMessage("https://notfacebook.com", msg("FINISH")), null);
  assert.equal(hintsFromSessionMessage("not a url", msg("FINISH")), null);
  assert.equal(hintsFromSessionMessage(FB, "{not json"), null);
  assert.equal(hintsFromSessionMessage(FB, JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH" })), null); // FINISH without data
});

test("coexistence launch: the documented Business-app onboarding extras; the standard options are unchanged (twin)", () => {
  assert.deepEqual(embeddedSignupLoginOptions("cfg-1", "coexistence"), {
    config_id: "cfg-1", response_type: "code", override_default_response_type: true,
    extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
  });
  assert.deepEqual(embeddedSignupLoginOptions("cfg-1", "standard"), embeddedSignupLoginOptions("cfg-1"));
});

test("coexistence flow accepts FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (phone id may be empty); the standard flow still refuses it (twin)", () => {
  const ev = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "900000000000001" } });
  assert.deepEqual(hintsFromSessionMessage(FB, ev, "coexistence"), { wabaId: "900000000000001", phoneNumberId: "" });
  assert.equal(hintsFromSessionMessage(FB, ev), null);
  assert.equal(hintsFromSessionMessage("https://facebook.com.evil.test", ev, "coexistence"), null);
  assert.equal(hintsFromSessionMessage(FB, JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: {} }), "coexistence"), null);
  for (const e of ["FINISH_ONLY_WABA", "CANCEL", "ERROR"]) assert.equal(hintsFromSessionMessage(FB, msg(e), "coexistence"), null, e);
});
