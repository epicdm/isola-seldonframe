"use client";

// 2026-10-21 — select the business calendar the public booking page checks
// for busy time. Separate from the booking-hours
// form on purpose: it saves its own settings key, so it can never change the
// approved hours, and saving the hours can never clear it. Empty = no
// calendar selected = the workspace's previous behaviour.

import { useEffect, useState, useTransition } from "react";
import {
  getBookingCalendarSelectionAction,
  updateBookingCalendarAction,
} from "@/lib/bookings/actions";

export function BusinessCalendarSelector() {
  const [calendarId, setCalendarId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void getBookingCalendarSelectionAction()
      .then((r) => {
        if (!cancelled) setCalendarId(r.calendarId ?? "");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function save() {
    setState("idle");
    startTransition(async () => {
      try {
        const r = await updateBookingCalendarAction({ calendarId: calendarId.trim() || null });
        if (!r.ok) {
          setState("error");
          return;
        }
        setCalendarId(r.calendarId ?? "");
        setState("saved");
      } catch {
        setState("error");
      }
    });
  }

  return (
    <div className="space-y-2 border-t pt-3" aria-labelledby="business-calendar-heading">
      <p id="business-calendar-heading" className="text-sm font-medium">
        Business calendar
      </p>
      <p className="text-xs text-muted-foreground">
        The Google calendar (from your connected calendar account) that booking times are checked against. Leave
        empty to not check a calendar. If the calendar can&apos;t be read, the booking page shows no times rather than
        unchecked ones.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          className="crm-input h-9 min-w-0 flex-1 text-sm"
          placeholder="e.g. you@yourbusiness.com"
          value={calendarId}
          disabled={!loaded || pending}
          onChange={(e) => setCalendarId(e.target.value)}
          aria-label="Business calendar ID"
        />
        <button
          type="button"
          className="crm-button-secondary h-9 px-4 text-sm"
          disabled={!loaded || pending}
          onClick={save}
        >
          {pending ? "Saving…" : "Save calendar"}
        </button>
      </div>
      {state === "saved" ? (
        <span className="text-xs text-positive" role="status">
          {calendarId ? `Booking times are checked against ${calendarId}.` : "No business calendar is checked."}
        </span>
      ) : null}
      {state === "error" ? (
        <span className="text-xs text-negative" role="status">
          Couldn&apos;t save. Try again.
        </span>
      ) : null}
    </div>
  );
}
