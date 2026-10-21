"use client";

import { useEffect, useState, useTransition } from "react";

import { confirmChatwootLinkAction, findChatwootCandidatesAction } from "@/lib/chatwoot-link/actions";
import type { Candidate, LinkState } from "@/lib/chatwoot-link/service";

import { ChatwootLinkView, type ChatwootLinkViewState } from "./chatwoot-link-view";

// Chatwoot customer link card (container): fetches candidates once for an unlinked contact and confirms one. Presentation: chatwoot-link-view.tsx.

const CONFIRM_ERRORS: Record<string, string> = {
  not_a_candidate: "That conversation is no longer a match for this contact. Nothing was linked.",
  forbidden: "Only a workspace owner or admin can confirm a match.",
  chatwoot_unreachable: "Chatwoot could not be checked right now. Nothing was linked.",
};

export function ChatwootLinkCard({ contactId, initial, canConfirm }: { contactId: string; initial: LinkState; canConfirm: boolean }) {
  const [view, setView] = useState<ChatwootLinkViewState>(
    initial.state === "linked" ? { kind: "linked", url: initial.url, conversationId: initial.conversationId, confirmedAt: initial.confirmedAt } : initial.state === "unlinked" ? { kind: "checking" } : { kind: "none" },
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (initial.state !== "unlinked") return;
    let live = true;
    findChatwootCandidatesAction(contactId)
      .then((r) => {
        if (!live) return;
        if (!r.ok) setView(r.code === "chatwoot_unreachable" ? { kind: "error" } : { kind: "none" });
        else setView(r.candidates.length ? { kind: "candidates", candidates: r.candidates } : { kind: "none" });
      })
      .catch(() => live && setView({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [contactId, initial.state]);

  const onConfirm = (c: Candidate) => {
    setBusyKey(`${c.chatwootContactId}:${c.conversationId}`);
    setConfirmError(null);
    startTransition(async () => {
      try {
        const r = await confirmChatwootLinkAction({ contactId, chatwootContactId: c.chatwootContactId, conversationId: c.conversationId });
        if (r.ok) setView({ kind: "linked", url: r.link.url, conversationId: r.link.conversationId, confirmedAt: r.link.confirmedAt });
        else setConfirmError(CONFIRM_ERRORS[r.code] ?? "Nothing was linked.");
      } catch {
        setConfirmError("Nothing was linked.");
      } finally {
        setBusyKey(null);
      }
    });
  };

  return <ChatwootLinkView view={view} canConfirm={canConfirm} busyKey={busyKey} confirmError={confirmError} onConfirm={onConfirm} />;
}
