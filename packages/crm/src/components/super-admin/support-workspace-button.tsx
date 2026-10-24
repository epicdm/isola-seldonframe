"use client";

import { useState } from "react";
import { createAgencySupportSession } from "@/lib/operator-portal/support-session";

export function SupportWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function enter() {
    setBusy(true);
    setError(null);
    try {
      const result = await createAgencySupportSession({ workspaceId });
      if (!result.ok) {
        setError(result.reason);
        setBusy(false);
        return;
      }
      window.location.assign(result.url);
    } catch {
      setError("Support session could not be started.");
      setBusy(false);
    }
  }
  return <div className="space-y-2"><button type="button" disabled={busy} onClick={enter} className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Opening workspace…" : "Open workspace in support mode"}</button>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}</div>;
}
