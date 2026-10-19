import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicFormPath, buildPublicFormUrl } from "../../src/lib/forms/public-url";

test("form editor path includes the workspace slug and uses encoded path segments", () => {
  assert.equal(buildPublicFormPath("uplink-demo", "contact-us"), "/forms/uplink-demo/contact-us");
  assert.equal(buildPublicFormPath("uplink demo", "contact us"), "/forms/uplink%20demo/contact%20us");
});

test("form API URL uses the configured Uplink origin instead of a vendor origin", () => {
  assert.equal(
    buildPublicFormUrl("uplink-demo", "contact-us", "https://uplink.epic.dm/"),
    "https://uplink.epic.dm/forms/uplink-demo/contact-us",
  );
});

test("form API URL remains null when there is no owning workspace slug", () => {
  assert.equal(buildPublicFormUrl(null, "contact-us", "https://uplink.epic.dm"), null);
});
