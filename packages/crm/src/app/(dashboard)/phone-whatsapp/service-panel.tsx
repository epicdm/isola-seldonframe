"use client";

// Calling service for a connected number: choose where calls are answered, set it up, place the acceptance call, and say whether it worked. The browser holds no
// authority: workspace and role come from the session on the server, the number's details from verified evidence, and every write is re-validated server-side.
import { useCallback, useEffect, useState } from "react";

import type { ServiceView } from "@/lib/phone-whatsapp/service/orchestrate";
import { ServiceStatesCard } from "./service-states";

async function api(url: string, body?: unknown) {
  const res = await fetch(url, body === undefined ? { credentials: "same-origin" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function Line({ phoneNumberId, canWrite }: { phoneNumberId: string; canWrite: boolean }) {
  const [view, setView] = useState<ServiceView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dest, setDest] = useState("");
  const [audio, setAudio] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api(`/api/phone-whatsapp/service/state?phoneNumberId=${phoneNumberId}`);
    if (r.body.ok) { setView(r.body.view as ServiceView); setErr(null); } else setErr("The calling service status could not be loaded.");
  }, [phoneNumberId]);
  useEffect(() => { void load(); }, [load]);

  async function attach() {
    setBusy(true); setMsg(null);
    const r = await api("/api/phone-whatsapp/service/attach", { phoneNumberId, destinationId: dest });
    setMsg(r.body.ok ? "Calling service set up." : String(r.body.message ?? "Setup could not be completed."));
    setBusy(false); await load();
  }
  async function accept(twoWay: boolean) {
    setBusy(true); setMsg(null);
    const r = await api("/api/phone-whatsapp/service/accept", { phoneNumberId, twoWayAudio: twoWay });
    if (r.body.ok) setMsg(twoWay ? "Acceptance recorded." : "Recorded: the audio did not work. Place another call after it is fixed.");
    else setMsg(r.body.code === "evidence_missing" ? `Not recorded yet. Still needed: ${(r.body.missing as string[]).join("; ")}.` : "The statement could not be recorded.");
    setBusy(false); setAudio(false); await load();
  }

  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">Loading calling service status…</p>;
  const s = view.states;
  const canSetUp = canWrite && (s.next === "choose_destination_and_set_up" || s.next === "retry_setup");
  const canAccept = canWrite && (s.next === "make_acceptance_call" || s.next === "confirm_acceptance");
  return (
    <div className="space-y-3" data-testid="service-line">
      <p className="text-sm font-medium">Number {phoneNumberId}</p>
      <ServiceStatesCard states={s} observedAt={view.observedAt} eligibility={view.eligibility} routingHealth={view.routingHealth} />
      {view.current ? <p className="text-sm">Calls go to: <strong>{view.current.label}</strong></p> : null}
      {canSetUp ? (
        <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="service-setup">
          <label className="block font-medium" htmlFor={`dest-${phoneNumberId}`}>Where should calls be answered?</label>
          <select id={`dest-${phoneNumberId}`} className="w-full rounded border bg-background p-2" value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Choose a destination…</option>
            {view.selectable.map((d) => (<option key={d.id} value={d.id}>{d.label} ({d.kind.replace("_", " ")})</option>))}
          </select>
          {view.selectable.length === 0 ? <p className="text-muted-foreground">No destination is available yet. EPIC staff add the places calls can go for your workspace.</p> : null}
          <button type="button" disabled={!dest || busy} onClick={attach} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">{s.next === "retry_setup" ? "Retry setup" : "Set up calling service"}</button>
        </div>
      ) : null}
      {canAccept ? (
        <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="service-accept">
          <p>Call this number from WhatsApp now and talk for a few seconds. Then say how it went.</p>
          <label className="flex items-start gap-2"><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /><span>I made the call and could hear and be heard (two-way audio worked).</span></label>
          <div className="flex gap-2">
            <button type="button" disabled={!audio || busy} onClick={() => accept(true)} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">Record acceptance</button>
            <button type="button" disabled={busy} onClick={() => accept(false)} className="rounded-md border px-4 py-2">The audio did not work</button>
          </div>
        </div>
      ) : null}
      {msg ? <p role="status" className="text-sm" data-testid="service-msg">{msg}</p> : null}
      {view.acceptance.current.length + view.acceptance.historical.length > 0 ? (
        <div className="text-sm" data-testid="service-history">
          <p className="font-medium">Acceptance record</p>
          <ul className="list-disc pl-5">
            {view.acceptance.current.map((a, i) => (<li key={`c${i}`}>{a.twoWayAudio ? "Accepted" : "Audio failed"} {a.at.slice(0, 16).replace("T", " ")} UTC for the current route.</li>))}
            {view.acceptance.historical.map((a, i) => (<li key={`h${i}`} className="text-muted-foreground">Historical: {a.twoWayAudio ? "accepted" : "audio failed"} {a.at.slice(0, 16).replace("T", " ")} UTC for {a.evidence.routedTarget}. {a.why}.</li>))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ServicePanel({ phoneNumberIds, canWrite }: { phoneNumberIds: string[]; canWrite: boolean }) {
  return (
    <section className="rounded-xl border bg-card p-5 space-y-4" data-testid="service-panel" aria-labelledby="svc-h">
      <h2 id="svc-h" className="text-base font-semibold">Calling service</h2>
      <p className="text-sm text-muted-foreground">Connecting your number to Meta is one step. This shows the rest, separately: setting up where calls are answered, whether calls are routed there, and an acceptance call that proves it works.</p>
      {phoneNumberIds.map((id) => (<Line key={id} phoneNumberId={id} canWrite={canWrite} />))}
    </section>
  );
}
