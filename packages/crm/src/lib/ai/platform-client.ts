import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

type SecretFileReader = (filePath: string) => Promise<string>;
const readSecretFile: SecretFileReader = (filePath) => readFile(filePath, "utf8");

export async function readPlatformApiKeyFile(
  filePath: string,
  readFileValue: SecretFileReader = readSecretFile,
): Promise<string> {
  let value: string;
  try {
    value = await readFileValue(filePath);
  } catch {
    throw new Error("Platform model credential file is unavailable.");
  }
  const apiKey = value.trim();
  if (!apiKey) throw new Error("Platform model credential file is empty.");
  return apiKey;
}

/**
 * Wizard (client-workspace build) keys. The wizard pipeline hands an API key STRING to several stages that each construct their own SDK client.
 * On a deployment whose managed AI is the mounted-file provider (MODEL_API_KEY_FILE + MODEL_BASE_URL, no ANTHROPIC_API_KEY) the platform key must be
 * resolved from that file AND its clients must target MODEL_BASE_URL; any other key (operator BYOK, ANTHROPIC_API_KEY) keeps the SDK defaults.
 */
const platformFileWizardKeys = new Set<string>();

/** True when the managed AI on this deployment is the mounted-file provider (MODEL_API_KEY_FILE) and ANTHROPIC_API_KEY is NOT set (the same precedence getAIClient uses). */
export function isPlatformFileProvider(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.MODEL_API_KEY_FILE?.trim()) && !env.ANTHROPIC_API_KEY?.trim();
}

/** Default model for a wizard stage: on the file provider the provider's own MODEL_NAME (the stage env override still wins at the call site); otherwise the stage's historical Claude default. */
export function wizardModelDefault(fallback: string, env: Record<string, string | undefined> = process.env): string {
  return (isPlatformFileProvider(env) && env.MODEL_NAME?.trim()) || fallback;
}

/** Status the wizard gives its auto-created chatbot. SF_WIZARD_CHATBOT_STATUS=test|live is explicit; unset: "test" on the file-provider deployment (public chat is not funded/authorised there, so the new agent must not be publicly served), "live" elsewhere (historical behaviour). */
export function wizardChatbotStatus(env: Record<string, string | undefined> = process.env): "test" | "live" {
  const v = env.SF_WIZARD_CHATBOT_STATUS?.trim();
  if (v === "test" || v === "live") return v;
  return isPlatformFileProvider(env) ? "test" : "live";
}

export async function resolvePlatformWizardKey(
  env: Record<string, string | undefined> = process.env,
  readFileValue: SecretFileReader = readSecretFile,
): Promise<string | null> {
  const filePath = env.MODEL_API_KEY_FILE?.trim();
  if (!filePath) return null;
  try {
    const key = await readPlatformApiKeyFile(filePath, readFileValue);
    platformFileWizardKeys.add(key);
    return key;
  } catch {
    return null;
  }
}

export function createWizardAnthropic(apiKey: string, env: Record<string, string | undefined> = process.env): Anthropic {
  if (platformFileWizardKeys.has(apiKey)) {
    // maxRetries 0: every wizard stage is ONE physical provider call, so a build's worst-case spend is exactly the sum of the stage output caps (same discipline as the public pilot path).
    return new Anthropic({ apiKey, baseURL: requirePlatformModelBaseUrl(env.MODEL_BASE_URL), maxRetries: 0 });
  }
  return new Anthropic({ apiKey });
}

export function requirePlatformModelBaseUrl(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) throw new Error("Platform model endpoint is not configured.");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Platform model endpoint must be an HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Platform model endpoint must be an HTTPS URL without embedded credentials.");
  }
  return configured;
}

/** Resolve the file on each client creation, then give the SDK a plain string key. */
export async function createPlatformFileBackedClient(
  filePath: string,
  baseURL: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<Anthropic> {
  const apiKey = await readPlatformApiKeyFile(filePath);
  return new Anthropic({
    apiKey,
    baseURL: requirePlatformModelBaseUrl(baseURL),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export async function createPlatformFileBackedClientOrNull(
  filePath: string,
  baseURL: string | undefined,
  fetchImpl?: typeof fetch,
  readFileValue: SecretFileReader = readSecretFile,
): Promise<Anthropic | null> {
  try {
    const apiKey = await readPlatformApiKeyFile(filePath, readFileValue);
    return new Anthropic({
      apiKey,
      baseURL: requirePlatformModelBaseUrl(baseURL),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  } catch {
    return null;
  }
}

/** Keep workspace BYOK on its existing SDK defaults and endpoint selection. */
export function createAnthropicByokClient(apiKey: string, fetchImpl?: typeof fetch): Anthropic {
  return new Anthropic({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
