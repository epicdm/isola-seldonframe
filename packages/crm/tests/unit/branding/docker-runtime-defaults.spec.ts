import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const dockerfilePath = fileURLToPath(new URL("../../../../../Dockerfile", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../../../../.github/workflows/build-isola-seldonframe.yml", import.meta.url));

it("passes non-secret Uplink brand defaults into the runner while preserving Docker runtime overrides", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const runner = dockerfile.split("# ---------- runner ----------")[1];
  assert.ok(runner, "runner stage exists");
  for (const [name, defaultValue] of [
    ["PLATFORM_NAME", "SeldonFrame"],
    ["PLATFORM_OPERATOR_NAME", "SeldonFrame"],
    ["PLATFORM_APP_URL", "https://app.seldonframe.com"],
    ["PLATFORM_HOME_URL", "https://www.seldonframe.com"],
    ["PLATFORM_SUPPORT_EMAIL", "support@seldonframe.com"],
    ["PLATFORM_EMAIL_FROM_NAME", "SeldonFrame"],
    ["PLATFORM_EMAIL_FOOTER", "The SeldonFrame team"],
    ["WORKSPACE_BASE_DOMAIN", "app.seldonframe.com"],
    ["APP_HOSTS", ""],
    ["SHOW_VENDOR_BRANDING", "true"],
  ]) {
    assert.ok(runner.includes(`ARG ${name}=${defaultValue}`), `runner default exists for ${name}`);
    assert.ok(runner.includes(name + "=${" + name + "}"), `runner ENV forwards ${name}`);
  }
  assert.match(runner, /ARG NEXT_PUBLIC_APP_URL=http:\/\/localhost:3000/);
  assert.match(runner, /ARG PLATFORM_SOURCE_URL=\n/);
  assert.match(runner, /ARG PLATFORM_LOGO_URL=\n/);
  assert.match(runner, /ARG PLATFORM_FAVICON_URL=\n/);
});

it("validates and supplies the Uplink app-host list through the existing image workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /app_hosts:[\s\S]*?default: uplink\.epic\.dm/);
  assert.match(workflow, /test "\$public_host" = "\$APP_HOSTS"/);
  assert.match(workflow, /APP_HOSTS=\$\{\{ inputs\.app_hosts \}\}/);
});
