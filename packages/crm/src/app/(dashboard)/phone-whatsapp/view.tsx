// Presentational half of the Phone & WhatsApp page: pure rendering of a PageView. No server imports, no data access, no
// input elements. Kept separate so every state (unlinked, conflict, unknown, attention, ok) can be rendered and tested.
import { formatUtc } from "@/lib/phone-whatsapp/view-model";
import type { Fact, LineView, PageView, Tone } from "@/lib/phone-whatsapp/types";

const TONE: Record<Tone, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "text-positive" },
  attention: { label: "Needs attention", cls: "text-caution" },
  unknown: { label: "Unknown", cls: "text-muted-foreground" },
};

function Badge({ tone }: { tone: Tone }) {
  return <span className={`text-xs font-semibold uppercase tracking-wide ${TONE[tone].cls}`}>{TONE[tone].label}</span>;
}

function Row({ title, fact }: { title: string; fact: Fact }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 first:border-t-0 sm:grid-cols-[200px_1fr]" data-testid={`row-${title}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {title}
        <Badge tone={fact.tone} />
      </div>
      <div className="space-y-1 text-sm">
        <p>{fact.headline}</p>
        <p className="text-xs text-muted-foreground">{fact.detail}</p>
        <p className="text-xs text-muted-foreground">
          {fact.observedAt ? `As of ${formatUtc(fact.observedAt)}` : "No evidence time"} · {fact.source}
        </p>
      </div>
    </div>
  );
}

function StaffAction({ waNumber, what }: { waNumber: string | null; what: string }) {
  const text = encodeURIComponent(`Hi EPIC, I need help with: ${what}`);
  return waNumber ? (
    <a href={`https://wa.me/${waNumber}?text=${text}`} target="_blank" rel="noopener noreferrer" className="crm-button-primary inline-flex h-9 items-center px-4 text-sm" data-testid="staff-action">
      Message EPIC staff on WhatsApp
    </a>
  ) : (
    <span className="text-xs text-muted-foreground" data-testid="staff-action-missing">
      The EPIC staff contact is not configured on this server.
    </span>
  );
}

function Line({ line, waNumber }: { line: LineView; waNumber: string | null }) {
  return (
    <section className="crm-card p-4" data-testid="line-card">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{line.displayNumber ?? "Number not confirmed"}</h2>
          <p className="text-xs text-muted-foreground">
            {[line.verifiedName, line.label].filter(Boolean).join(" · ") || "No name available"} · Meta phone id {line.phoneNumberId}
          </p>
        </div>
      </div>
      <Row title="WhatsApp connection" fact={line.connection} />
      <div className="grid gap-1 border-t border-border py-3 sm:grid-cols-[200px_1fr]" data-testid="row-Calling eligibility">
        <div className="flex items-center gap-2 text-sm font-medium">
          Calling eligibility
          <Badge tone={line.eligibility.tone} />
        </div>
        <div className="space-y-2 text-sm">
          <p>{line.eligibility.headline}</p>
          <p className="text-xs text-muted-foreground">{line.eligibility.detail}</p>
          {line.eligibility.checks.length > 0 && (
            <ul className="space-y-1">
              {line.eligibility.checks.map((c) => (
                <li key={c.name} className="flex gap-2 text-xs">
                  <span className={`w-28 shrink-0 font-semibold uppercase ${TONE[c.tone].cls}`}>{TONE[c.tone].label}</span>
                  <span>
                    {c.name}
                    <span className="block text-muted-foreground">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {line.eligibility.observedAt ? `As of ${formatUtc(line.eligibility.observedAt)}` : "No evidence time"} · {line.eligibility.source}
          </p>
        </div>
      </div>
      <Row title="Call destination" fact={line.destination} />
      <Row title="Routing readiness" fact={line.routing} />
      <Row title="Last call" fact={line.lastCall} />
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <StaffAction waNumber={waNumber} what={`WhatsApp number ${line.displayNumber ?? line.phoneNumberId}: setup or change`} />
        <button type="button" disabled className="crm-button-secondary h-9 cursor-not-allowed px-4 text-sm opacity-60" title="Changing where calls go is done by EPIC staff." data-testid="change-destination-disabled">
          Change call destination (staff only)
        </button>
      </div>
    </section>
  );
}

const STEPS = [
  { n: 1, title: "Connect WhatsApp account", state: "Staff-assisted today. Meta sign-in happens with EPIC staff." },
  { n: 2, title: "Select number", state: "Staff-assisted today. This page lists the numbers linked to your workspace." },
  { n: 3, title: "Configure destination", state: "Staff-assisted today. This page shows the configured destination; it cannot change it." },
  { n: 4, title: "Verify routing", state: "Shown below as evidence: configured, or proven by an answered call." },
  { n: 5, title: "Acceptance call", state: "Staff-assisted today. Your last call record appears below once a call is made." },
];

export function PhoneWhatsappView({ view, waNumber }: { view: PageView; waNumber: string | null }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Phone &amp; WhatsApp</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your WhatsApp business number, whether it can take calls, where calls are sent and what the last call was. This is a read-only view: EPIC staff make the changes.
        </p>
      </div>

      <ol className="grid gap-2 sm:grid-cols-5" data-testid="journey">
        {STEPS.map((s) => (
          <li key={s.n} className="crm-card p-3 text-xs">
            <p className="font-semibold">
              {s.n}. {s.title}
            </p>
            <p className="mt-1 text-muted-foreground">{s.state}</p>
          </li>
        ))}
      </ol>

      {view.kind === "no_link" && (
        <section className="crm-card space-y-3 p-4" data-testid="no-link">
          <h2 className="text-lg font-semibold">No WhatsApp business number is linked to this workspace</h2>
          <p className="text-sm text-muted-foreground">Linking a number is a staff-assisted step. Nothing is shown here until EPIC staff link a number to this workspace.</p>
          <StaffAction waNumber={waNumber} what="link a WhatsApp business number to my workspace" />
        </section>
      )}

      {view.kind === "link_conflict" && (
        <section className="crm-card space-y-3 p-4" data-testid="link-conflict">
          <h2 className="text-lg font-semibold">This number cannot be shown</h2>
          <p className="text-sm text-muted-foreground">The number linked to this workspace is also claimed elsewhere, so nothing about it is displayed. EPIC staff must resolve the ownership first.</p>
          <StaffAction waNumber={waNumber} what="resolve the ownership of my WhatsApp number" />
        </section>
      )}

      {view.kind === "lines" && view.lines.map((l) => <Line key={l.phoneNumberId} line={l} waNumber={waNumber} />)}
    </div>
  );
}
