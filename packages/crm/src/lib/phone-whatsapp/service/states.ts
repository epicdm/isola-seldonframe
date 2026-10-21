// EPIC-managed calling, increment 2: FOUR separate states, never collapsed. "Connected to Meta" says nothing about whether calls will be answered.
//   connection  the number is Meta-connected and bound to this workspace          (the PR #16 connection record)
//   setup       the service account, DID and destination exist and read back      (the attach ledger)
//   routing     the voice platform currently routes the number to the destination (read-only adapter evidence)
//   acceptance  a real call worked in both directions and an admin said so         (acceptance.ts)
// The service is READY only when all four are in their good state; the next step is always the earliest state that is not.
import type { AttachLedgerRecord } from "./attach";
import type { AcceptanceState } from "./acceptance";

// linked_by_staff / unknown: a number EPIC staff linked to the workspace (settings.phoneWhatsapp.lines) with no connect-flow record. Read from Meta's own
// evidence, the same source as the detailed cards; "unknown" when Meta could not be read, never "not connected".
export type ConnectionState = "not_connected" | "in_progress" | "needs_review" | "connected" | "linked_by_staff" | "unknown";
export type SetupState = "not_started" | "in_progress" | "step_failed" | "needs_review" | "set_up" | "staff_managed";
// routed_by_staff: the voice platform routes the number, but no destination was chosen on this page, so there is nothing to compare it with.
export type RoutingState = "unknown" | "not_routed" | "routed_other_destination" | "routed_by_staff" | "verified";

export type ServiceStates = {
  connection: ConnectionState;
  setup: SetupState;
  routing: RoutingState;
  acceptance: AcceptanceState | "not_applicable";
  ready: boolean;
  next: "connect" | "resolve_connection" | "choose_destination_and_set_up" | "retry_setup" | "staff_review_setup" | "wait_for_routing" | "make_acceptance_call" | "confirm_acceptance" | "staff_managed" | "recheck" | "none";
};

export function deriveServiceStates(i: {
  connectionStatus: "pending" | "registering" | "registered" | "active" | "failed" | null;
  ledger: AttachLedgerRecord | null;
  /** From the read-only adapter. null = the adapter could not answer (never read as "not routed"). */
  routing: { didActive: boolean; destinationActive: boolean; destinationTarget: string | null } | null;
  expectedTarget: string | null;
  acceptance: AcceptanceState | null;
  /** Present only for a staff-linked line: Meta's own status for the number, or null when Meta could not be read. Used ONLY when there is no
   *  connect-flow record; a record always wins. Presentation only: the attach precondition still reads the record and is unchanged. */
  staffLine?: { metaStatus: string | null } | null;
}): ServiceStates {
  const connection: ConnectionState =
    i.connectionStatus === "active" ? "connected"
    : i.connectionStatus === "registering" ? "needs_review"
    : i.connectionStatus === "pending" || i.connectionStatus === "registered" ? "in_progress"
    : i.connectionStatus === null && i.staffLine ? (i.staffLine.metaStatus === null ? "unknown" : i.staffLine.metaStatus === "CONNECTED" ? "linked_by_staff" : "not_connected")
    : "not_connected"; // null and failed

  const setup: SetupState =
    connection === "linked_by_staff" || connection === "unknown" ? "staff_managed"
    : connection !== "connected" || !i.ledger ? "not_started"
    : i.ledger.status === "attached" ? "set_up"
    : i.ledger.status === "needs_review" ? "needs_review"
    : i.ledger.status === "step_failed" ? "step_failed"
    : "in_progress";

  let routing: RoutingState = "unknown";
  if (i.routing) {
    if (!i.routing.didActive || !i.routing.destinationActive) routing = "not_routed";
    // Only for a staff-linked line (no connect-flow record) with nothing chosen here; an unreadable target is unknown, never "routed" (Codex review).
    else if (!i.expectedTarget && !i.ledger && (connection === "linked_by_staff" || connection === "unknown")) routing = i.routing.destinationTarget ? "routed_by_staff" : "unknown";
    else if (i.expectedTarget && i.routing.destinationTarget === i.expectedTarget) routing = "verified";
    else routing = "routed_other_destination";
  }

  const acceptance: ServiceStates["acceptance"] = routing === "verified" && setup === "set_up" ? (i.acceptance ?? "not_recorded") : "not_applicable";
  const ready = connection === "connected" && setup === "set_up" && routing === "verified" && acceptance === "accepted";

  let next: ServiceStates["next"];
  if (connection === "unknown") next = "recheck";
  else if (connection === "linked_by_staff") next = "staff_managed";
  else if (connection === "not_connected") next = "connect";
  else if (connection !== "connected") next = "resolve_connection";
  else if (setup === "not_started") next = "choose_destination_and_set_up";
  else if (setup === "step_failed" || setup === "in_progress") next = "retry_setup";
  else if (setup === "needs_review") next = "staff_review_setup";
  else if (routing !== "verified") next = "wait_for_routing";
  else if (acceptance === "call_seen_unconfirmed") next = "confirm_acceptance";
  else if (acceptance !== "accepted") next = "make_acceptance_call";
  else next = "none";
  return { connection, setup, routing, acceptance, ready, next };
}
