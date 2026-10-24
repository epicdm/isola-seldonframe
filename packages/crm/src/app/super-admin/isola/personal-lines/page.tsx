"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Account = {
  did: string | null;
  ownerPhone: string | null;
  createdAt: string;
  registration: {
    state?: string;
    reason?: string | null;
    handoffAt?: string | null;
    registeredAt?: string | null;
    checkedAt?: string | null;
    activationLink?: { state?: string; createdAt?: string; expiresAt?: string | null; usedAt?: string | null } | null;
  };
  evidence: { paidPayments?: number; completedWalletMovements?: number; unresolvedClaims?: number } | null;
  identity: string;
  isFixture: boolean;
  lifecycle: { stage: string; updatedAt: string; contactUrl: string } | null;
};
type ResetStep = { step: string; status: string; detail: string };
type Preview = { phone: string; previewReceipt: string; steps: ResetStep[] };
type ResetResult = { ok: boolean; steps: ResetStep[] };

function stage(account: Account) {
  if (account.identity === "retired") return "Line retired";
  if (account.lifecycle?.stage) return account.lifecycle.stage;
  if (account.registration?.state === "activated") return "App activated";
  if (account.registration?.state === "pending" || account.registration?.state === "stalled") return "App setup in progress";
  if (account.registration?.state === "unknown") return "Registration needs review";
  if ((account.evidence?.paidPayments ?? 0) > 0) return "Payment recorded · no lifecycle event";
  return "Line created · no later event recorded";
}

function StageBadge({ account }: { account: Account }) {
  const value = stage(account);
  return <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{value}</span>;
}

export default function PersonalLinesPage() {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading live Personal Line estate…");
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (q = "") => {
    setStatus("Loading live Personal Line estate…");
    try {
      const search = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const response = await fetch(`/api/super-admin/isola/personal-lines${search}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.accounts)) throw new Error(data.error === "search_requires_four_digits" ? "Enter at least four digits to search." : "The live estate could not be read; no complete list is shown.");
      setAccounts(data.accounts as Account[]);
      setSupportUrl(typeof data.supportUrl === "string" ? data.supportUrl : null);
      setLoaded(true);
      setStatus(`${data.total} matching line${data.total === 1 ? "" : "s"} · live BFF read`);
    } catch (error) {
      setAccounts([]);
      const shortSearch = error instanceof Error && error.message === "Enter at least four digits to search.";
      setLoaded(shortSearch);
      setStatus(error instanceof Error ? error.message : "The live estate could not be read.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    total: accounts.length,
    setup: accounts.filter((a) => ["pending", "stalled"].includes(a.registration?.state ?? "")).length,
    payment: accounts.filter((a) => (a.evidence?.paidPayments ?? 0) > 0).length,
    fixtures: accounts.filter((a) => a.isFixture).length,
  }), [accounts]);

  async function resetAction(action: "preview" | "confirm", phone: string, receipt?: string) {
    setBusy(true);
    setResult(null);
    setStatus(action === "preview" ? "Requesting a fresh reset preview…" : "Submitting the receipt-bound reset…");
    try {
      const response = await fetch("/api/super-admin/isola/personal-lines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, phone, magnusUser: "deactivate", ...(receipt ? { previewReceipt: receipt, operatorReason: reason } : {}) }),
      });
      const data = await response.json();
      if (!response.ok && response.status !== 207) throw new Error(typeof data.error === "string" ? data.error : `Reset request refused (${response.status}).`);
      if (action === "preview" && data.dryRun === true && typeof data.previewReceipt === "string" && Array.isArray(data.steps)) {
        setPreview({ phone, previewReceipt: data.previewReceipt, steps: data.steps });
        setStatus("Preview only: inspect every listed effect before confirming.");
      } else {
        if (action === "preview") throw new Error("Reset preview did not match the supported contract; nothing was confirmed.");
        setPreview(null);
        if (typeof data.ok !== "boolean" || !Array.isArray(data.steps)) throw new Error("Reset result could not be verified; inspect the live estate before proceeding.");
        setResult({ ok: data.ok, steps: data.steps });
        setStatus(data.ok ? "Reset reported complete. Refreshing the live estate…" : "Reset returned partial effects; inspect each step and the refreshed estate.");
        await load(query);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reset service unavailable.");
    } finally { setBusy(false); }
  }

  function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreview(null);
    void load(query);
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-7 px-6 py-8 sm:px-10 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">SeldonFrame · Uplink operations</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Personal Line onboarding</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">See the verified line, app-registration evidence, payment records, and the latest Uplink lifecycle stage in one place. Statuses come from their source records.</p>
        </div>
        {supportUrl && <a href={supportUrl} target="_blank" rel="noreferrer" className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent">Open WhatsApp support ↗</a>}
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Personal Line overview">
        {[['Visible lines', counts.total], ['App setup pending', counts.setup], ['Paid records found', counts.payment], ['Known fixtures', counts.fixtures]].map(([label, value]) =>
          <div key={label} className="rounded-xl border p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>
        )}
      </section>

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 text-sm">
        <strong>Operator workflow</strong><span className="text-muted-foreground"> — use the WhatsApp support inbox to take over or resume the customer conversation. Lifecycle stage advances from signed Uplink events. Payment is shown only from payment records; wallet movements are listed separately.</span>
      </div>

      <form onSubmit={search} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="line-search">Search phone number</label>
        <input id="line-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search phone number (4+ digits)" className="w-full max-w-md rounded-md border bg-background px-3 py-2 text-sm" />
        <button className="rounded-md border px-4 py-2 text-sm hover:bg-accent" type="submit">Search</button>
        <button className="rounded-md border px-4 py-2 text-sm hover:bg-accent" type="button" onClick={() => { setQuery(""); setPreview(null); void load(); }}>Show all</button>
      </form>

      <p role="status" className="text-sm text-muted-foreground">{status}</p>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[1150px] text-left text-sm">
          <thead className="border-b bg-muted/30 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-4 py-3">Line / owner</th><th className="px-4 py-3">Current stage</th><th className="px-4 py-3">App / registration</th><th className="px-4 py-3">Payment evidence</th><th className="px-4 py-3">Lifecycle event</th><th className="px-4 py-3">Created</th><th className="px-4 py-3">Operator actions</th>
          </tr></thead>
          <tbody>
            {accounts.map((account, index) => <tr key={`${account.did}-${account.ownerPhone}-${index}`} className="border-b last:border-0">
              <td className="px-4 py-3"><div className="font-mono">{account.did ?? "—"}</div><div className="mt-1 text-xs text-muted-foreground">{account.ownerPhone ?? "Owner not recorded"}{account.isFixture ? " · fixture" : ""}</div><div className="mt-1 text-xs text-muted-foreground">Identity: {account.identity}</div></td>
              <td className="px-4 py-3"><StageBadge account={account} />{account.lifecycle && <a className="mt-2 block text-xs underline" href={account.lifecycle.contactUrl}>Open CRM record</a>}</td>
              <td className="px-4 py-3"><div>{account.registration?.state ?? "unknown"}</div><div className="mt-1 text-xs text-muted-foreground">Activation link: {account.registration?.activationLink?.state ?? "not recorded"}</div>{account.registration?.reason && <div className="mt-1 max-w-64 text-xs text-muted-foreground">{account.registration.reason}</div>}</td>
              <td className="px-4 py-3"><div>Settled payment records: {account.evidence?.paidPayments ?? "unavailable"}</div><div className="mt-1 text-xs text-muted-foreground">Completed wallet movements: {account.evidence?.completedWalletMovements ?? "unavailable"}</div>{(account.evidence?.unresolvedClaims ?? 0) > 0 && <div className="mt-1 text-xs text-amber-700">Unresolved claims: {account.evidence?.unresolvedClaims}</div>}</td>
              <td className="px-4 py-3">{account.lifecycle ? <><div>{account.lifecycle.stage}</div><div className="mt-1 text-xs text-muted-foreground">{new Date(account.lifecycle.updatedAt).toLocaleString()}</div></> : <span className="text-xs text-muted-foreground">No matching signed lifecycle event</span>}</td>
              <td className="px-4 py-3">{new Date(account.createdAt).toLocaleString()}</td>
              <td className="px-4 py-3">{account.isFixture && account.identity !== "retired" && account.ownerPhone && account.evidence?.paidPayments === 0 ? <button type="button" disabled={busy} onClick={() => void resetAction("preview", account.ownerPhone!)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">Preview fixture reset</button> : <span className="text-xs text-muted-foreground">{account.isFixture && (account.evidence?.paidPayments ?? 0) > 0 ? "Protected: settled payment record" : account.isFixture && !account.evidence ? "Protected: payment evidence unavailable" : account.isFixture && account.identity !== "retired" ? "Fixture owner phone missing" : "—"}</span>}</td>
            </tr>)}
            {!accounts.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{loaded ? "No matching Personal Lines." : "Estate data unavailable. See status above; no empty-estate conclusion is available."}</td></tr>}
          </tbody>
        </table>
      </div>

      {preview && <section className="space-y-4 rounded-xl border border-amber-500/40 p-5" aria-label="Fixture reset preview">
        <div><p className="font-mono text-xs uppercase text-amber-700">Dry run · no changes made</p><h2 className="mt-1 text-lg font-semibold">Reset {preview.phone}</h2><p className="text-sm text-muted-foreground">Magnus mode: deactivate. Review every listed effect; the confirmation is bound to this fresh receipt.</p></div>
        <ul className="space-y-2">{preview.steps.map((step, index) => <li key={`${step.step}-${index}`} className="rounded-md bg-muted/30 p-3 text-sm"><strong>{step.step}: {step.status}</strong><div className="text-muted-foreground">{step.detail}</div></li>)}</ul>
        <label className="block space-y-1 text-sm"><span>Audit reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} className="min-h-20 w-full rounded-md border bg-background p-3" /></label>
        <div className="flex gap-2"><button type="button" disabled={busy || !reason.trim()} onClick={() => void resetAction("confirm", preview.phone, preview.previewReceipt)} className="rounded-md bg-destructive px-4 py-2 text-sm text-destructive-foreground disabled:opacity-50">Confirm this reset</button><button type="button" disabled={busy} onClick={() => setPreview(null)} className="rounded-md border px-4 py-2 text-sm">Cancel</button></div>
      </section>}

      {result && <section className="space-y-3 rounded-xl border p-5" aria-label="Fixture reset result">
        <h2 className="font-semibold">Reset result · {result.ok ? "all steps reported successful" : "one or more steps need attention"}</h2>
        <ul className="space-y-2">{result.steps.map((step, index) => <li key={`${step.step}-${index}`} className="rounded-md bg-muted/30 p-3 text-sm"><strong>{step.step}: {step.status}</strong><div className="text-muted-foreground">{step.detail}</div></li>)}</ul>
      </section>}
    </div>
  );
}
