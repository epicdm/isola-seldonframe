"use client";

// Connect a WhatsApp number (standard Meta onboarding). The browser only LAUNCHES Meta's flow and relays what Meta hands back; it decides
// nothing. The server verifies every claim with Meta and binds the number to the signed-in workspace. Connecting is NOT the same as calling
// working: the text below says what is still to do. Nothing here ever shows a code, token or PIN.
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "starting" | "meta" | "finishing" | "done" | "error";
type StartOk = { ok: true; nonce: string; appId: string; configId: string; testMode: boolean };
type Hints = { wabaId?: string; phoneNumberId?: string };
export type ConnectionState = { phoneNumberId: string; status: "pending" | "registering" | "registered" | "active" | "failed"; reason: string | null };

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
  failed: "Meta did not accept the registration of this number, so nothing was registered. You can connect again.",
};

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: j };
}

export function ConnectPanel({ states = [] }: { states?: ConnectionState[] }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [scenario, setScenario] = useState(0);
  const hints = useRef<Hints>({});
  const nonce = useRef<string>("");
  const code = useRef<string>("");
  const partial = states.filter((s) => s.status !== "active");

  // Collect Meta's session-info message (hints only). The origin check is Meta's documented requirement.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      let host = "";
      try { host = new URL(ev.origin).hostname; } catch { return; }
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      try {
        const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (d?.type === "WA_EMBEDDED_SIGNUP" && d.event === "FINISH" && d.data) {
          hints.current = { wabaId: String(d.data.waba_id ?? ""), phoneNumberId: String(d.data.phone_number_id ?? "") };
          void maybeFinish();
        }
      } catch { /* not ours */ }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maybeFinish = useCallback(async () => {
    if (!code.current || !hints.current.wabaId || !hints.current.phoneNumberId) return;
    setPhase("finishing");
    const r = await post("/api/phone-whatsapp/connect/finalize", { nonce: nonce.current, code: code.current, ...hints.current });
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
      { config_id: start.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "", sessionInfoVersion: "3" } },
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
        A workspace owner or admin signs in to Meta here and chooses one WhatsApp Business number on the standard WhatsApp Cloud API. The number is checked with Meta
        before it is attached to this workspace. This connects the number to your workspace only: <strong>it does not turn on calling, messaging or AI replies.</strong>{" "}
        Using the WhatsApp Business app and this connection on the same number (Coexistence) is not part of this step.
      </p>

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
          <li>Connecting <strong>registers this number</strong> with WhatsApp&apos;s Cloud API under EPIC&apos;s Meta application, using a PIN EPIC generates and keeps encrypted.</li>
          <li>If the number is in use in the WhatsApp Business app, or with another provider, it can stop working there. Do not connect a number you still need elsewhere. Numbers in the Business app are refused.</li>
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
