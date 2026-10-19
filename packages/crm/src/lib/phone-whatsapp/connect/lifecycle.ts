// account_update lifecycle for connected numbers (pure). Meta never sends account_update to a callback override, so it reaches the BFF app
// callback, whose WABA guard forwards it here signed (same x-prov-ts / x-prov-sig scheme and secret as the calls forward).
//   PARTNER_REMOVED, ACCOUNT_OFFBOARDED  -> 'disconnected' (remembering the status to restore), audited
//   ACCOUNT_RECONNECTED                  -> back to the remembered status, only from 'disconnected'
//   anything else                        -> audited only, no state change
// Idempotent: a repeated event is a no-op (compare-and-set from the expected status). The workspace is derived from OUR records of the WABA,
// never from the forwarded body.

export const DISCONNECT_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"]);
export const RECONNECT_EVENTS = new Set(["ACCOUNT_RECONNECTED"]);
const RESTORABLE = new Set(["active", "connected_coexistence"]);

export type LifecycleConn = { orgId: string; phoneNumberId: string; status: string; disconnectedFrom: string | null };
export type LifecycleEvent = { wabaId: string; event: string; reason: string | null; at: string };
export type Transition = { orgId: string; phoneNumberId: string; from: string; to: "disconnected" | "active" | "connected_coexistence"; disconnectedFrom: string | null; reason: string | null };

export function parseLifecycleEvent(raw: unknown): LifecycleEvent | null {
  const b = raw as { wabaId?: unknown; event?: unknown; reason?: unknown; at?: unknown } | null;
  if (!b || typeof b.wabaId !== "string" || !/^\d{5,20}$/.test(b.wabaId)) return null;
  if (typeof b.event !== "string" || !b.event || b.event.length > 100) return null;
  const at = typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) ? b.at : new Date().toISOString();
  return { wabaId: b.wabaId, event: b.event, reason: typeof b.reason === "string" ? b.reason.slice(0, 100) : null, at };
}

/** The transitions an event implies for the connections on its WABA (empty = audit only). */
export function planLifecycle(ev: LifecycleEvent, conns: LifecycleConn[]): Transition[] {
  const out: Transition[] = [];
  for (const c of conns) {
    if (DISCONNECT_EVENTS.has(ev.event) && RESTORABLE.has(c.status)) {
      out.push({ orgId: c.orgId, phoneNumberId: c.phoneNumberId, from: c.status, to: "disconnected", disconnectedFrom: c.status, reason: ev.reason ?? ev.event });
    } else if (RECONNECT_EVENTS.has(ev.event) && c.status === "disconnected" && c.disconnectedFrom && RESTORABLE.has(c.disconnectedFrom)) {
      out.push({ orgId: c.orgId, phoneNumberId: c.phoneNumberId, from: "disconnected", to: c.disconnectedFrom as "active" | "connected_coexistence", disconnectedFrom: null, reason: ev.event });
    }
  }
  return out;
}
