import Link from "next/link";
import type { PersonalLineRecord } from "@/lib/personal-lines/tenant-data";

/** Personal Line is a service on this existing customer record, not a second customer shell. */
export function PersonalLineContactCard({ line }: { line: PersonalLineRecord }) {
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
        <div><dt className="text-xs text-muted-foreground">Account</dt><dd className="mt-1 font-medium">{line.accountAssigned ? "Assigned" : "Pending assignment"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Personal Line number</dt><dd className="mt-1 font-medium">{line.facts.did_masked ?? "Not yet recorded"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">SIP registration</dt><dd className="mt-1 font-medium">{line.facts.registered_at ? `Registered ${line.facts.registered_at}` : "No registration event recorded"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">First answered call</dt><dd className="mt-1 font-medium">{line.facts.first_call_at ?? "No first-call event recorded"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Updated</dt><dd className="mt-1 font-medium">{new Date(line.updatedAt).toLocaleString()}</dd></div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">Payment, plan, and voice-resource details require the verified shared service association. They are not inferred from lifecycle events.</p>
    </section>
  );
}
