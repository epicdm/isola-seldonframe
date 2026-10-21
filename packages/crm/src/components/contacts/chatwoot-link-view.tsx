import { ExternalLink, MessageSquare } from "lucide-react";

import type { Candidate } from "@/lib/chatwoot-link/service";

/**
 * Chatwoot customer link on /contacts/[id]. Read-only towards Chatwoot.
 *  - linked: "Open in Chatwoot" (new tab), from a person-confirmed, verified record.
 *  - candidates only: "Possible Chatwoot matches (unconfirmed)", each with a confirm action for an owner/admin.
 *  - nothing found / not configured: renders nothing. A failed lookup says it could not check, never "no conversation".
 */

export type ChatwootLinkViewState =
  | { kind: "linked"; url: string; conversationId: number; confirmedAt: string }
  | { kind: "checking" }
  | { kind: "candidates"; candidates: Candidate[]; incomplete?: boolean }
  | { kind: "none" }
  | { kind: "error" };

const fmtDate = (v: string | number | null) => {
  if (v === null) return null;
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function ChatwootLinkView({
  view,
  canConfirm,
  busyKey,
  confirmError,
  onConfirm,
}: {
  view: ChatwootLinkViewState;
  canConfirm: boolean;
  busyKey?: string | null;
  confirmError?: string | null;
  onConfirm?: (c: Candidate) => void;
}) {
  if (view.kind === "none" || view.kind === "checking") return null;
  return (
    <section data-testid="chatwoot-link" className="mx-4 mt-3 rounded-xl border bg-card p-4 sm:mx-6 lg:mx-8">
      <header className="flex items-center gap-2 text-sm font-semibold">
        <MessageSquare className="size-4" />
        Chatwoot
      </header>
      {view.kind === "linked" ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <a
            data-testid="chatwoot-open"
            href={view.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 font-medium hover:bg-muted"
          >
            Open in Chatwoot
            <ExternalLink className="size-3.5" />
          </a>
          <span className="text-xs text-muted-foreground">
            Conversation #{view.conversationId} · confirmed {fmtDate(view.confirmedAt) ?? ""}
          </span>
        </div>
      ) : view.kind === "error" ? (
        <p data-testid="chatwoot-error" className="mt-2 text-xs text-muted-foreground">
          Chatwoot could not be checked right now. No link has been made.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <h3 data-testid="chatwoot-candidates" className="text-xs font-medium text-muted-foreground">
            Possible Chatwoot matches (unconfirmed)
          </h3>
          <p className="text-xs text-muted-foreground">
            These match this contact&apos;s phone or email. They are not linked until a person confirms it is the same customer.
          </p>
          <ul className="space-y-1.5">
            {view.candidates.map((c) => {
              const key = `${c.chatwootContactId}:${c.conversationId}`;
              return (
                <li key={key} data-testid="chatwoot-candidate" className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>
                    {c.name ?? "Unnamed contact"} · conversation #{c.conversationId}
                    {c.status ? ` · ${c.status}` : ""}
                    {fmtDate(c.lastActivityAt) ? ` · last activity ${fmtDate(c.lastActivityAt)}` : ""}
                    <span className="ml-1 text-xs text-muted-foreground">(matched on {c.matchedOn.join(" and ")})</span>
                  </span>
                  {canConfirm ? (
                    <button
                      type="button"
                      data-testid="chatwoot-confirm"
                      disabled={!!busyKey}
                      onClick={() => onConfirm?.(c)}
                      className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {busyKey === key ? "Confirming…" : "Confirm same customer"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {view.incomplete ? (
            <p data-testid="chatwoot-incomplete" className="text-xs text-muted-foreground">
              More matching Chatwoot contacts or conversations may exist than are listed here; this list may be incomplete.
            </p>
          ) : null}
          {!canConfirm ? <p className="text-xs text-muted-foreground">A workspace owner or admin can confirm a match.</p> : null}
          {confirmError ? (
            <p data-testid="chatwoot-confirm-error" className="text-xs text-red-600">
              {confirmError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
