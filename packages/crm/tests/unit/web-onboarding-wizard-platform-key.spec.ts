import assert from "node:assert/strict";
import test from "node:test";
import { createWizardAnthropic, isPlatformFileProvider, resolvePlatformWizardKey, wizardChatbotStatus, wizardModelDefault } from "../../src/lib/ai/platform-client";

const base = "https://api.deepseek.com/anthropic";
const read = (value: string) => async () => `${value}\n`;

test("no MODEL_API_KEY_FILE configured -> no platform wizard key (the wizard must keep failing closed rather than guessing)", async () => {
  assert.equal(await resolvePlatformWizardKey({}, read("x")), null);
  assert.equal(await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "  " }, read("x")), null);
});

test("unreadable or empty key file -> null (never a throw, never an empty key)", async () => {
  assert.equal(await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "/nope" }, async () => { throw new Error("ENOENT"); }), null);
  assert.equal(await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "/empty" }, read("   ")), null);
});

test("the platform FILE key is read (trimmed) and its client targets MODEL_BASE_URL", async () => {
  const key = await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "/run/key" }, read("synthetic-platform-key-1"));
  assert.equal(key, "synthetic-platform-key-1");
  const c = createWizardAnthropic(key!, { MODEL_BASE_URL: base });
  assert.equal(c.baseURL, base);
  assert.equal(c.maxRetries, 0, "no hidden physical retries on the managed provider (bounded spend)");
});

test("a BYOK / ANTHROPIC_API_KEY style key is NEVER sent to the managed provider endpoint (SDK default base is kept)", async () => {
  await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "/run/key" }, read("synthetic-platform-key-2"));
  const byok = createWizardAnthropic("sk-ant-synthetic-customer-key", { MODEL_BASE_URL: base });
  assert.notEqual(byok.baseURL, base);
  assert.match(byok.baseURL, /api\.anthropic\.com/);
  assert.equal(byok.maxRetries, 2, "BYOK clients keep the SDK default retry behaviour");
});

test("a platform key with a missing/non-HTTPS MODEL_BASE_URL fails closed at construction", async () => {
  const key = await resolvePlatformWizardKey({ MODEL_API_KEY_FILE: "/run/key" }, read("synthetic-platform-key-3"));
  assert.throws(() => createWizardAnthropic(key!, {}), /endpoint/i);
  assert.throws(() => createWizardAnthropic(key!, { MODEL_BASE_URL: "http://insecure.example" }), /HTTPS/i);
});

test("wizardModelDefault: the file provider's MODEL_NAME replaces the Claude default; any other deployment keeps the stage default", () => {
  assert.equal(wizardModelDefault("claude-haiku-4-5", {}), "claude-haiku-4-5");
  assert.equal(wizardModelDefault("claude-haiku-4-5", { MODEL_API_KEY_FILE: "/k", MODEL_NAME: "deepseek-flash" }), "deepseek-flash");
  assert.equal(wizardModelDefault("claude-haiku-4-5", { MODEL_API_KEY_FILE: "/k" }), "claude-haiku-4-5");
  assert.equal(wizardModelDefault("claude-haiku-4-5", { MODEL_API_KEY_FILE: "/k", MODEL_NAME: "deepseek-flash", ANTHROPIC_API_KEY: "sk-ant-x" }), "claude-haiku-4-5");
});

test("isPlatformFileProvider / wizardChatbotStatus follow the getAIClient precedence", () => {
  assert.equal(isPlatformFileProvider({}), false);
  assert.equal(isPlatformFileProvider({ MODEL_API_KEY_FILE: "/k" }), true);
  assert.equal(isPlatformFileProvider({ MODEL_API_KEY_FILE: "/k", ANTHROPIC_API_KEY: "x" }), false);
  assert.equal(wizardChatbotStatus({ MODEL_API_KEY_FILE: "/k" }), "test");
  assert.equal(wizardChatbotStatus({}), "live");
});
