"use server";

// EPIC 2026-10-11 — settings/integrations "Personal Line" card actions. Same shape as the Twilio/Resend actions in
// lib/integrations/actions.ts: assertWritable() -> getOrgId() -> that org's integrations only; secrets via
// storeSecret (encrypted, fingerprinted, audited updatedBy) and NEVER echoed back; test-connection redirects with a flag.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";
import { listSecrets, storeSecret } from "@/lib/secrets";
import {
  PL_SECRET_EVENTS,
  PL_SECRET_SUMMARY,
  productionConfigDeps,
  resolvePersonalLine,
  validatePersonalLineSettings,
  validSigningKey,
  writePersonalLineRecord,
} from "./integration";
import { makeSummaryFetcher } from "./card";

export type PersonalLineSettingsView = {
  orgId: string;
  connected: boolean;
  baseUrl: string;
  eventsKeyId: string;
  summaryKeyId: string;
  hasEventsKey: boolean;
  hasSummaryKey: boolean;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckDetail: string | null;
};

export async function getPersonalLineSettings(): Promise<PersonalLineSettingsView | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const user = await getCurrentUser();
  const deps = await productionConfigDeps();
  const rec = await deps.readRecord(orgId);
  let names: string[] = [];
  try {
    names = (await listSecrets({ workspaceId: orgId, actorUserId: user?.id ?? null })).map((s) => s.serviceName);
  } catch {
    names = [];
  }
  return {
    orgId,
    connected: rec?.connected === true,
    baseUrl: rec?.baseUrl ?? "",
    eventsKeyId: rec?.eventsKeyId ?? "",
    summaryKeyId: rec?.summaryKeyId ?? "",
    hasEventsKey: names.includes(PL_SECRET_EVENTS),
    hasSummaryKey: names.includes(PL_SECRET_SUMMARY),
    lastCheckedAt: rec?.lastCheckedAt ?? null,
    lastCheckOk: typeof rec?.lastCheckOk === "boolean" ? rec.lastCheckOk : null,
    lastCheckDetail: rec?.lastCheckDetail ?? null,
  };
}

export async function savePersonalLineIntegrationAction(formData: FormData) {
  assertWritable();
  const orgId = await getOrgId();
  const user = await getCurrentUser();
  if (!orgId || !user?.id) throw new Error("Unauthorized");

  const baseUrl = String(formData.get("baseUrl") ?? "").trim().replace(/\/+$/, "");
  const eventsKeyId = String(formData.get("eventsKeyId") ?? "").trim();
  const summaryKeyId = String(formData.get("summaryKeyId") ?? "").trim();
  const eventsKey = String(formData.get("eventsKey") ?? "").trim();
  const summaryKey = String(formData.get("summaryKey") ?? "").trim();
  const normalisedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const invalid = validatePersonalLineSettings({ baseUrl: normalisedBase, eventsKeyId, summaryKeyId });
  if (invalid) redirect(`/settings/integrations?plSaved=0&plError=${invalid}`);
  if ((eventsKey && !validSigningKey(eventsKey)) || (summaryKey && !validSigningKey(summaryKey))) {
    redirect("/settings/integrations?plSaved=0&plError=weak_key");
  }
  // Keys are write-only: blank = keep the stored one.
  if (eventsKey) await storeSecret({ workspaceId: orgId, serviceName: PL_SECRET_EVENTS, value: eventsKey, actorUserId: user.id });
  if (summaryKey) await storeSecret({ workspaceId: orgId, serviceName: PL_SECRET_SUMMARY, value: summaryKey, actorUserId: user.id });
  const names = (await listSecrets({ workspaceId: orgId, actorUserId: user.id })).map((s) => s.serviceName);
  const connected = names.includes(PL_SECRET_EVENTS) && names.includes(PL_SECRET_SUMMARY);
  await writePersonalLineRecord(orgId, { connected, baseUrl: normalisedBase, eventsKeyId, summaryKeyId });
  revalidatePath("/settings/integrations");
  redirect(`/settings/integrations?saved=1&service=Personal%20Line`);
}

/** Connection check: a SIGNED summary read for an account that cannot exist. 404 summary_not_found proves the service
 *  is reachable AND accepted this workspace's summary key; 401 means the keys disagree; anything else is unreachable. */
export async function testPersonalLineConnectionAction() {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Unauthorized");
  const cfg = await resolvePersonalLine(orgId, await productionConfigDeps());
  let ok = false;
  let detail = "not_connected";
  if (cfg?.summary) {
    const fetchImpl = (async (url: string, init: RequestInit) => fetch(url, init)) as typeof fetch;
    try {
      await makeSummaryFetcher({ baseUrl: cfg.baseUrl, key: cfg.summary, fetchImpl })("connection-check");
      detail = "unexpected_200";
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      ok = m === "pl_summary_http_404";
      detail = ok ? "reachable_key_accepted" : m === "pl_summary_http_401" ? "key_rejected" : m.startsWith("pl_summary_http_") ? m.slice(11) : "unreachable";
    }
  }
  await writePersonalLineRecord(orgId, { lastCheckedAt: new Date().toISOString(), lastCheckOk: ok, lastCheckDetail: detail });
  redirect(`/settings/integrations?plTest=${ok ? "1" : "0"}`);
}
