"use client";

// Connect a WhatsApp number (standard Meta onboarding). The browser only LAUNCHES Meta's flow and relays what Meta hands back; it decides
// nothing. The server verifies every claim with Meta and binds the number to the signed-in workspace. Connecting is NOT the same as calling
// working: the text below says what is still to do. Nothing here ever shows a code, token or PIN.
import { useCallback, useEffect, useRef, useState } from "react";

import { embeddedSignupLoginOptions, hintsFromSessionMessage, type LaunchFlow } from "@/lib/phone-whatsapp/connect/launch";

type Phase = "idle" | "starting" | "meta" | "finishing" | "done" | "error";
type StartOk = { ok: true; nonce: string; appId: string; configId: string; testMode: boolean };
type Hints = { wabaId?: string; phoneNumberId?: string };
export type ConnectionState = {
  phoneNumberId: string;
  status: "pending" | "registering" | "registered" | "active" | "failed" | "coex_linking" | "connected_coexistence" | "disconnected";
  reason: string | null;
  syncs?: Partial<Record<"smb_app_state_sync" | "history", "requested" | "rejected" | "unknown">>;
};

declare global {
  interface Window {
    FB?: { init(o: Record<string, unknown>): void; login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void };
    fbAsyncInit?: () => void;
  }
}

/** Scenarios offered ONLY when the server says it is in test mode (fictional assets, fake Meta). */
const TEST_SCENARIOS: Array<{ code: string; label: string; waba: string; phone: string }> = [
  { code: "fixture:happy", label: "Fictional number, correct (should connect)", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:happy", label: "Forged hint: phone not on the authorised account", waba: "900000000000001", phone: "900000000000099" },
  { code: "fixture:other-app", label: "Authorisation issued for a different app", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:coexistence", label: "Number also used in the WhatsApp Business app", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:epic-waba", label: "EPIC's own WhatsApp account", waba: "900000000000777", phone: "900000000000002" },
  { code: "fixture:expired", label: "Expired / invalid code", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:outage", label: "Meta unavailable", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:register-rejected", label: "Meta refuses the number registration (nothing registered)", waba: "900000000000001", phone: "900000000000002" },
  { code: "fixture:register-timeout", label: "Registration outcome unknown (Meta error 500)", waba: "900000000000001", phone: "900000000000002" },
];

const PARTIAL_TEXT: Record<string, string> = {
  pending: "A connection was started for this number but registration had not begun. Connect again to continue.",
  registering: "Registration of this number was started but Meta did not confirm the outcome. Nothing has been repeated and nothing has been undone. EPIC will check this number before anything else happens.",
  registered: "This number is registered with Meta, but the connection to this workspace was not finished. Connect again to finish; the number will not be registered a second time.",
  failed: "The last connection attempt for this number did not finish, so nothing was registered. You can connect again.",
  coex_linking: "A WhatsApp Business app connection was started for this number but did not finish. Your app keeps working. Connect again to finish.",
  disconnected: "This number was disconnected from EPIC in the WhatsApp Business app (or by Meta). Nothing is received or sent through EPIC for it now. EPIC will check before anything else happens.",
};

const SYNC_TEXT: Record<string, string> = {
  requested: "requested from Meta (it arrives over the next hours)",
  rejected: "refused by Meta (Meta allows it only once, within 24 hours of connecting)",
  unknown: "requested, but Meta did not confirm (it is not repeated automatically; EPIC will check)",
};

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: j };
}

export function ConnectPanel({ states = [], coexistenceAvailable = false }: { states?: ConnectionState[]; coexistenceAvailable?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [scenario, setScenario] = useState(0);
  const hints = useRef<Hints>({});
  const nonce = useRef<string>("");
  const code = useRef<string>("");
  // Owner decision 2026-10-19: keeping the WhatsApp Business app (Coexistence) is the first option when it is available here.
  const [flow, setFlow] = useState<LaunchFlow>(coexistenceAvailable ? "coexistence" : "standard");
  const flowRef = useRef<LaunchFlow>(flow);
  flowRef.current = flow;
  const partial = states.filter((s) => s.status !== "active" && s.status !== "connected_coexistence");
  const coexConnected = states.filter((s) => s.status === "connected_coexistence");

  // Collect Meta's session-info message (hints only). The origin check is Meta's documented requirement.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const h = hintsFromSessionMessage(ev.origin, ev.data, flowRef.current);
      if (h) { hints.current = h; void maybeFinish(); }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maybeFinish = useCallback(async () => {
    // The Business-app completion may omit the phone id (the server resolves it from Meta); the standard flow always needs it.
    if (!code.current || !hints.current.wabaId || (!hints.current.phoneNumberId && flowRef.current !== "coexistence")) return;
    setPhase("finishing");
    const r = await post("/api/phone-whatsapp/connect/finalize", { nonce: nonce.current, code: code.current, flow: flowRef.current, ...hints.current });
    code.current = ""; // the one-time code is dropped as soon as it has been sent
    if (r.body.ok === true) {
      setPhase("done");
      setMessage("Connected. Loading your number…");
      window.setTimeout(() => window.location.reload(), 900);
    } else {
      setPhase("error");
      setMessage(typeof r.body.message === "string" ? r.body.message : "The connection could not be completed. Nothing was connected.");
      if (r.body.code === "needs_review" || r.body.code === "persist_failed") window.setTimeout(() => window.location.reload(), 2500);
    }
  }, []);

  async function begin() {
    setMessage(null);
    setPhase("starting");
    const s = await post("/api/phone-whatsapp/connect/start", { consent });
    if (s.body.ok !== true) {
      setPhase("error");
      setMessage(s.body.code === "consent_required" ? "Please accept the connection terms first." : "Connecting is not available right now.");
      return;
    }
    const start = s.body as unknown as StartOk;
    nonce.current = start.nonce;
    hints.current = {};
    code.current = "";
    setTestMode(start.testMode);
    setPhase("meta");

    if (start.testMode) return; // test mode waits for the simulated popup buttons below

    try {
      await loadSdk(start.appId);
    } catch {
      setPhase("error");
      setMessage("Meta's sign-in could not be loaded. Nothing was connected.");
      return;
    }
    window.FB!.login(
      (resp) => {
        const c = resp.authResponse?.code;
        if (!c) { setPhase("error"); setMessage("The connection was cancelled. Nothing was connected."); return; }
        code.current = c;
        void maybeFinish();
      },
      embeddedSignupLoginOptions(start.configId, flowRef.current),
    );
  }

  async function simulate() {
    const sc = TEST_SCENARIOS[scenario];
    hints.current = { wabaId: sc.waba, phoneNumberId: sc.phone };
    code.current = sc.code;
    await maybeFinish();
  }

  const busy = phase === "starting" || phase === "finishing" || phase === "done";
  return (
    <section aria-labelledby="connect-h" className="rounded-xl border bg-card p-5" data-testid="connect-panel">
      <h2 id="connect-h" className="text-base font-semibold">Connect your WhatsApp number</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A workspace owner or admin signs in to Meta here and chooses one WhatsApp Business number. The number is checked with Meta before it is attached to this
        workspace. Connecting does not turn on AI replies.
      </p>

      {coexConnected.length > 0 ? (
        <ul className="mt-3 space-y-2" data-testid="connect-coexistence">
          {coexConnected.map((s) => (
            <li key={s.phoneNumberId} className="rounded-md border p-3 text-sm">
              <span className="font-medium">Number {s.phoneNumberId}: connected, WhatsApp Business app kept.</span> Messages arrive in your EPIC inbox and your app keeps
              working. WhatsApp calls to this number still ring only in the app: calling through EPIC needs the API-only setup.
              <span className="block text-muted-foreground">
                Contacts from the app: {SYNC_TEXT[s.syncs?.smb_app_state_sync ?? ""] ?? "not requested yet"}. Chat history from the app:{" "}
                {SYNC_TEXT[s.syncs?.history ?? ""] ?? "not requested yet"}.
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <fieldset className="mt-3 space-y-2 text-sm" data-testid="connect-flow">
        <legend className="font-medium">How is this number used today?</legend>
        {coexistenceAvailable ? (
          <label className="flex items-start gap-2">
            <input type="radio" name="flow" checked={flow === "coexistence"} onChange={() => setFlow("coexistence")} disabled={busy || phase === "meta"} />
            <span>
              <strong>I use the WhatsApp Business app on this number and want to keep it.</strong> Your app keeps working and your chats stay on your phone. Limits while
              you keep the app: WhatsApp calls are not available through EPIC; sending is limited to 20 messages per second; group chats are not synced; the contacts
              and up to 6 months of chat history can be copied in once, only within 24 hours of connecting.
            </span>
          </label>
        ) : null}
        <label className="flex items-start gap-2">
          <input type="radio" name="flow" checked={flow === "standard"} onChange={() => setFlow("standard")} disabled={busy || phase === "meta"} />
          <span>
            <strong>A new number, or one not in the WhatsApp Business app (API only).</strong> The number is registered on the WhatsApp Cloud API and then works only through
            EPIC, not in a WhatsApp app on a phone.
          </span>
        </label>
      </fieldset>

      {partial.length > 0 ? (
        <ul className="mt-3 space-y-2" data-testid="connect-partial">
          {partial.map((s) => (
            <li key={s.phoneNumberId} className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <span className="font-medium">Number {s.phoneNumberId}: connection not finished.</span> {PARTIAL_TEXT[s.status]}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 rounded-md border p-3 text-sm" data-testid="connect-consent-text">
        <p className="font-medium">Before you connect, please confirm:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          {flow === "coexistence" ? (
            <li>Keeping the app: the number is <strong>not registered again</strong>. Meta shares it with EPIC&apos;s application; you can disconnect it later in the app (Settings, Account, Business Platform).</li>
          ) : (
            <li>Connecting <strong>registers this number</strong> with WhatsApp&apos;s Cloud API under EPIC&apos;s Meta application, using a PIN EPIC generates and keeps encrypted.</li>
          )}
          <li>If the number is in use with another provider, it can stop working there. Do not connect a number you still need elsewhere. A number in the WhatsApp Business app is never registered by this step.</li>
          <li>EPIC keeps an encrypted Meta authorisation for this number so it can configure calling later. Nothing is sent to your customers by connecting.</li>
          <li>Still to do after connecting: EPIC sets where calls are delivered, Meta calling is checked for the number, and an acceptance call is made. Until then calling does not work.</li>
          <li>Disconnecting is not available here yet; EPIC staff can help.</li>
        </ul>
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy || phase === "meta"} />
        <span>I am authorised to connect this WhatsApp Business number, and I understand and accept the points above.</span>
      </label>
      <button type="button" onClick={begin} disabled={!consent || busy || phase === "meta"} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {phase === "starting" ? "Starting…" : partial.length > 0 ? "Connect again with Meta" : "Connect with Meta"}
      </button>

      {phase === "meta" && testMode ? (
        <div className="mt-4 rounded-md border border-dashed p-3 text-sm" data-testid="test-launcher">
          <p className="font-medium">Test mode: simulated Meta window (fictional assets)</p>
          <select className="mt-2 w-full rounded border bg-background p-2" value={scenario} onChange={(e) => setScenario(Number(e.target.value))}>
            {TEST_SCENARIOS.map((s, i) => (<option key={i} value={i}>{s.label}</option>))}
          </select>
          <button type="button" onClick={simulate} className="mt-2 rounded-md border px-3 py-1.5">Finish in simulated Meta window</button>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className={`mt-3 text-sm ${phase === "error" ? "text-red-600" : "text-muted-foreground"}`} data-testid="connect-status">
        {phase === "finishing" ? "Checking with Meta…" : message}
      </p>
    </section>
  );
}

let sdkPromise: Promise<void> | null = null;
function loadSdk(appId: string): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: false, xfbml: false, version: "v25.0" }); resolve(); };
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.onerror = () => { sdkPromise = null; reject(new Error("sdk")); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}
