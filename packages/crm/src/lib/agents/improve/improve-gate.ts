// EPIC 2026-10-16 (owner: "allow uplink change", model: DeepSeek) - the gate for the IMPROVE loop only.
//
// The Studio build/test rule (studio-build-gate.ts) keeps the platform key for a reseller's first-workspace magic and makes
// agent BUILDING need the operator's own key. On EPIC's self-hosted deployment the "platform" IS the operator's own account:
// the mounted-file provider (MODEL_API_KEY_FILE + MODEL_BASE_URL, e.g. DeepSeek) that already runs the live agents and the
// eval suite. There, the improve loop may use the platform client. Everywhere else (ANTHROPIC_API_KEY platform, or no
// file provider) the Studio rule stands unchanged: BYOK only. A null client never passes.
import { resolveStudioBuildGate } from "@/lib/agent-templates/studio-build-gate";
import { isPlatformFileProvider } from "@/lib/ai/platform-client";
import type { AIClientMode } from "@/lib/ai/client";

export function resolveImproveGate(
  mode: AIClientMode,
  hasClient: boolean,
  env: Record<string, string | undefined> = process.env,
): { ok: true; via: "byok" | "platform-file-provider" } | { ok: false } {
  if (!hasClient) return { ok: false };
  if (resolveStudioBuildGate(mode).ok) return { ok: true, via: "byok" };
  return isPlatformFileProvider(env) ? { ok: true, via: "platform-file-provider" } : { ok: false };
}
