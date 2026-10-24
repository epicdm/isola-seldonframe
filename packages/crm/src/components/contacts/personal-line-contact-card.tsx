import Link from "next/link";
import type { PersonalLineRecord } from "@/lib/personal-lines/tenant-data";

/** Personal Line is a service on this existing customer record, not a second customer shell. */
export function PersonalLineContactCard({ line }: { line: PersonalLineRecord }) {
  const evidence = line.serviceEvidence;
  return (
    <section className="mx-4 mt-3 rounded-xl border bg-card p-4 sm:mx-6 lg:mx-8" aria-label="Personal Line service">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Service</p>
          <h2 className="mt-1 text-base font-semibold">Personal Line</h2>
        </div>
        <Link href="/personal-lines" className="text-sm font-medium underline-offset-4 hover:underline">All Personal Lines</Link>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Onboarding stage</dt><dd className="mt-1 font-medium">{line.stage}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Service association</dt><dd className="mt-1 font-medium">{line.serviceAssociationStatus === "verified" ? "Verified from signed service event" : line.serviceAssociationStatus === "unverified" ? "Needs operator review" : "Pending account assignment"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Personal Line number</dt><dd className="mt-1 font-medium">{line.facts.did_masked ?? "Not yet recorded"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Registration event</dt><dd className="mt-1 font-medium">{line.facts.registered_at ? `Recorded ${line.facts.registered_at}` : "No registration event recorded"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">First answered call</dt><dd className="mt-1 font-medium">{line.facts.first_call_at ?? "No first-call event recorded"}</dd></div>
        {evidence.status === "verified" ? <>
          <div><dt className="text-xs text-muted-foreground">Voice resource</dt><dd className="mt-1 font-medium">{evidence.voice.magnusUserAssigned ? "Assigned" : "Not assigned"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Live SIP registration</dt><dd className="mt-1 font-medium">{evidence.voice.sipRegistered === true ? "Registered" : evidence.voice.sipRegistered === false ? "Not registered" : "Unknown"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Registration check</dt><dd className="mt-1 font-medium">{evidence.registration.peerStatus ?? evidence.registration.status ?? "Unknown"}{evidence.registration.registeredAt ? ` · ${evidence.registration.registeredAt}` : ""}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Wallet balance</dt><dd className="mt-1 font-medium">{evidence.wallet.balanceEc === null ? "Unknown" : `${evidence.wallet.currency ?? "EC$"} ${evidence.wallet.balanceEc.toFixed(2)}`}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Plan</dt><dd className="mt-1 font-medium">{evidence.plan.state === "none" ? "No plan subscription" : evidence.plan.status === "query_failed" ? "Unavailable" : evidence.plan.name ? `${evidence.plan.name} (${evidence.plan.state ?? evidence.plan.status})` : "Unknown"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Wallet credit evidence</dt><dd className="mt-1 font-medium">{evidence.wallet.creditsStatus === "ok" ? evidence.wallet.credits.length ? evidence.wallet.credits.map((credit) => `${credit.amountEc === null ? "Amount unknown" : `${evidence.wallet.currency ?? "EC$"} ${credit.amountEc.toFixed(2)}`}${credit.currencyPaid ? ` paid in ${credit.currencyPaid}` : ""} · ${credit.state}`).join("; ") : "No confirmed credit events returned" : `Unavailable (${evidence.wallet.creditsStatus})`}</dd></div>
        </> : <div><dt className="text-xs text-muted-foreground">Live service data</dt><dd className="mt-1 font-medium">{evidence.status === "not_linked" ? "Service association not available" : evidence.status === "association_mismatch" ? "Service association needs review" : "Temporarily unavailable"}</dd></div>}
        <div><dt className="text-xs text-muted-foreground">Updated</dt><dd className="mt-1 font-medium">{new Date(line.updatedAt).toLocaleString()}</dd></div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">Live status is read from the configured Personal Line service and checked against its recorded service number. Recorded credits are wallet events and are not a payment settlement report.</p>
    </section>
  );
}
