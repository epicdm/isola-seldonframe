"use client";

import { useState } from "react";
import { createAgencySupportSession } from "@/lib/operator-portal/support-session";

export function PersonalLineContactLink({ workspaceId, contactId }: { workspaceId: string; contactId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openContact() {
    setBusy(true);
    setError(null);
    try {
      const result = await createAgencySupportSession({ workspaceId, contactId });
      if (!result.ok) {
        setError(result.reason === "contact_not_in_workspace" ? "The CRM record is not in this workspace." : "Audited support access could not be started.");
        setBusy(false);
        return;
      }
      window.location.assign(result.url);
    } catch {
      setError("Audited support access could not be started.");
      setBusy(false);
    }
  }

  return (
    <span className="mt-2 block">
      <button type="button" disabled={busy} onClick={openContact} className="text-xs underline disabled:opacity-50">
        {busy ? "Opening CRM record…" : "Open CRM record"}
      </button>
      {error ? <span role="alert" className="mt-1 block text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
