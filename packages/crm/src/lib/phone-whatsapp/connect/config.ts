// Standard Meta connection: configuration with fail-closed guards. Pure (takes an env-like object) so it is testable without process state.
//
// - Connect is OFF unless the workspace is listed in PHONE_CONNECT_ENABLED_ORGS (same one-function-one-field rule as the panel).
// - It is also unavailable unless META_APP_ID, META_APP_SECRET and META_ES_CONFIG_ID are all present: a half-configured connect page
//   would show a Connect button that cannot work, which is the failure this increment exists to avoid.
// - EPIC's own WhatsApp account ids and protected phone-number ids are NOT in this (public) repository. They come from
//   PHONE_CONNECT_EPIC_WABA_IDS / PHONE_CONNECT_PROTECTED_PHONE_IDS and are REQUIRED outside test mode: an empty deny-list would silently
//   allow a customer connect to bind EPIC's own assets, so connect refuses to configure without them (reason "missing_denylist").
// - The Graph base URL and the simulated launcher are TEST seams. They are honoured only when PHONE_CONNECT_TEST_MODE is set; a
//   production process with a custom base and no test mode refuses to configure rather than sending a customer token somewhere else.
import { isPhoneWhatsappEnabled } from "../exposure";

export const REAL_GRAPH_BASE = "https://graph.facebook.com/v25.0";

export type EnvLike = Record<string, string | undefined>;

export type ConnectConfig =
  | { ok: false; reason: "disabled" | "unconfigured" | "unsafe_graph_base" | "missing_denylist" }
  | {
      ok: true;
      appId: string;
      appSecret: string;
      configId: string;
      graphBase: string;
      testMode: boolean;
      protectedPhoneIds: ReadonlySet<string>;
      epicWabaIds: ReadonlySet<string>;
    };

export function isConnectEnabled(orgId: string | null | undefined, env: EnvLike): boolean {
  return isPhoneWhatsappEnabled(orgId, env.PHONE_CONNECT_ENABLED_ORGS);
}

const idList = (v: string | undefined) => new Set((v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5,20}$/.test(x)));

export function loadConnectConfig(orgId: string | null | undefined, env: EnvLike): ConnectConfig {
  if (!isConnectEnabled(orgId, env)) return { ok: false, reason: "disabled" };
  const appId = (env.META_APP_ID ?? "").trim();
  const appSecret = (env.META_APP_SECRET ?? "").trim();
  const configId = (env.META_ES_CONFIG_ID ?? "").trim();
  if (!/^\d{5,20}$/.test(appId) || !appSecret || !/^\d{5,20}$/.test(configId)) return { ok: false, reason: "unconfigured" };
  const testMode = (env.PHONE_CONNECT_TEST_MODE ?? "").trim() === "1";
  const override = (env.META_GRAPH_BASE ?? "").trim();
  if (override && !testMode) return { ok: false, reason: "unsafe_graph_base" };
  const protectedPhoneIds = idList(env.PHONE_CONNECT_PROTECTED_PHONE_IDS);
  const epicWabaIds = idList(env.PHONE_CONNECT_EPIC_WABA_IDS);
  if (!testMode && (protectedPhoneIds.size === 0 || epicWabaIds.size === 0)) return { ok: false, reason: "missing_denylist" };
  return {
    ok: true,
    appId,
    appSecret,
    configId,
    graphBase: testMode && override ? override.replace(/\/+$/, "") : REAL_GRAPH_BASE,
    testMode,
    protectedPhoneIds,
    epicWabaIds,
  };
}
