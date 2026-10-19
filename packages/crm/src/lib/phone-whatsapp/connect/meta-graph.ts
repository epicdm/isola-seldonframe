// Standard Meta connection: the only module that talks to the Meta Graph API. Server-only. The customer's token is passed in and used;
// it is never returned, logged, or placed in an error message. fetch is injectable so tests (and the UAT sink) never reach Meta.
import type { DebugToken, GraphClient, WabaPhone } from "./verify-assets";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export class GraphError extends Error {
  constructor(public readonly status: number, label: string) {
    super(`graph ${label} failed (${status})`); // never includes the response body or any token
  }
}

export function makeGraphClient(opts: { base: string; appId: string; appSecret: string; fetch?: Fetch; timeoutMs?: number }) {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeout = opts.timeoutMs ?? 10_000;
  const sig = () => AbortSignal.timeout(timeout);

  async function json(label: string, res: Response): Promise<Record<string, unknown>> {
    if (!res.ok) throw new GraphError(res.status, label);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new GraphError(502, label);
    return body;
  }

  /** Server-to-server exchange of the one-time Embedded Signup code. Returns the business token, or throws. */
  async function exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({ client_id: opts.appId, client_secret: opts.appSecret, code });
    const res = await f(`${opts.base}/oauth/access_token`, { method: "POST", body, signal: sig() });
    const j = await json("code exchange", res);
    const t = j.access_token;
    if (typeof t !== "string" || !t) throw new GraphError(502, "code exchange");
    return t;
  }

  const client: GraphClient = {
    async debugToken(token: string): Promise<DebugToken> {
      const url = `${opts.base}/debug_token?input_token=${encodeURIComponent(token)}`;
      const res = await f(url, { headers: { Authorization: `Bearer ${opts.appId}|${opts.appSecret}` }, signal: sig() });
      const d = ((await json("debug_token", res)).data ?? {}) as Record<string, unknown>;
      const granular = Array.isArray(d.granular_scopes) ? (d.granular_scopes as Array<Record<string, unknown>>) : [];
      const wabaTargets = new Set<string>();
      for (const g of granular) {
        if (g.scope === "whatsapp_business_management" || g.scope === "whatsapp_business_messaging") {
          for (const id of Array.isArray(g.target_ids) ? g.target_ids : []) if (typeof id === "string") wabaTargets.add(id);
        }
      }
      return {
        isValid: d.is_valid === true,
        appId: typeof d.app_id === "string" ? d.app_id : null,
        scopes: Array.isArray(d.scopes) ? (d.scopes as unknown[]).filter((s): s is string => typeof s === "string") : [],
        wabaTargets: [...wabaTargets],
      };
    },
    async listWabaPhones(token: string, wabaId: string): Promise<WabaPhone[]> {
      const fields = "id,display_phone_number,verified_name,platform_type,is_on_biz_app";
      const res = await f(`${opts.base}/${encodeURIComponent(wabaId)}/phone_numbers?fields=${fields}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: sig(),
      });
      const rows = ((await json("phone list", res)).data ?? []) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id ?? ""),
        displayNumber: typeof r.display_phone_number === "string" ? r.display_phone_number : null,
        verifiedName: typeof r.verified_name === "string" ? r.verified_name : null,
        platformType: typeof r.platform_type === "string" ? r.platform_type : null,
        isOnBizApp: typeof r.is_on_biz_app === "boolean" ? r.is_on_biz_app : null,
      }));
    },
  };

  /** Registers the number for Cloud API with a per-number PIN. Cloud API (non-coexistence) numbers only. */
  async function register(token: string, phoneNumberId: string, pin: string): Promise<void> {
    const res = await f(`${opts.base}/${encodeURIComponent(phoneNumberId)}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      signal: sig(),
    });
    const j = await json("register", res);
    if (j.success !== true) throw new GraphError(502, "register");
  }

  /**
   * Subscribes our app to the customer's WABA (POST /{waba}/subscribed_apps, no body). Meta requires it before any webhook reaches us and
   * before a callback override; it was missing from the standard path. Idempotent at Meta. The webhook FIELDS are the app-level subscription
   * (app dashboard), not set here.
   */
  async function subscribeApp(token: string, wabaId: string): Promise<void> {
    const res = await f(`${opts.base}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: sig(),
    });
    const j = await json("subscribe app", res);
    if (j.success !== true) throw new GraphError(502, "subscribe app");
  }

  /** Phone-level webhook override (POST /{phone} webhook_configuration). Coexistence only: points the number's override-eligible fields at our receiver. */
  async function setPhoneOverride(token: string, phoneNumberId: string, callbackUri: string, verifyToken: string): Promise<void> {
    const res = await f(`${opts.base}/${encodeURIComponent(phoneNumberId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_configuration: { override_callback_uri: callbackUri, verify_token: verifyToken } }),
      signal: sig(),
    });
    const j = await json("phone override", res);
    if (j.success !== true) throw new GraphError(502, "phone override");
  }

  /** Coexistence one-time sync request (POST /{phone}/smb_app_data). Meta answers with a request id; the data arrives later as webhooks. */
  async function requestSmbSync(token: string, phoneNumberId: string, syncType: "smb_app_state_sync" | "history"): Promise<string | null> {
    const res = await f(`${opts.base}/${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
      signal: sig(),
    });
    const j = await json(`smb sync ${syncType}`, res);
    return typeof j.request_id === "string" ? j.request_id : null;
  }

  return { client, exchangeCode, register, subscribeApp, setPhoneOverride, requestSmbSync };
}
