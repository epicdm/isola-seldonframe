"use client";

// EPIC 2026-10-04 -- minimal staff form for the portal "Your services" links.

import { useState, useTransition } from "react";
import { savePortalServiceLinksAction } from "@/lib/portal/service-links-actions";

type Row = { label: string; url: string };

export function PortalServiceLinksForm({ initial }: { initial: Row[] }) {
  const padded: Row[] = [...initial];
  while (padded.length < 3) padded.push({ label: "", url: "" });
  const [rows, setRows] = useState<Row[]>(padded.slice(0, 5));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await savePortalServiceLinksAction({ links: rows });
      setMessage(res.ok ? `Saved ${res.saved} link${res.saved === 1 ? "" : "s"}.` : res.error);
    });
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Your services (links shown to signed-in customers)</h2>
        <p className="text-sm text-muted-foreground">
          Shown on the customer portal home. Use full https:// addresses. A service with its own sign-in (for example the
          Personal Line app) should say so in the label.
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm"
              placeholder="Label (e.g. Personal Line app - separate sign-in)"
              value={row.label}
              maxLength={60}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm"
              placeholder="https://..."
              value={row.url}
              onChange={(e) => update(i, { url: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="crm-button-primary h-9 px-6" disabled={pending} onClick={save}>
          {pending ? "Saving..." : "Save links"}
        </button>
        {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
      </div>
    </section>
  );
}
