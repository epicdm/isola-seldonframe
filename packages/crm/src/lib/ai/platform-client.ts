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
