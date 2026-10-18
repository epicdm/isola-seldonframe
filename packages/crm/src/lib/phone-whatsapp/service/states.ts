// EPIC-managed calling, increment 2: FOUR separate states, never collapsed. "Connected to Meta" says nothing about whether calls will be answered.
//   connection  the number is Meta-connected and bound to this workspace          (the PR #16 connection record)
//   setup       the service account, DID and destination exist and read back      (the attach ledger)
//   routing     the voice platform currently routes the number to the destination (read-only adapter evidence)
//   acceptance  a real call worked in both directions and an admin said so         (acceptance.ts)
// The service is READY only when all four are in their good state; the next step is always the earliest state that is not.
import type { AttachLedgerRecord } from "./attach";
import type { AcceptanceState } from "./acceptance";

export type ConnectionState = "not_connected" | "in_progress" | "needs_review" | "connected";
export type SetupState = "not_started" | "in_progress" | "step_failed" | "needs_review" | "set_up";
export type RoutingState = "unknown" | "not_routed" | "routed_other_destination" | "verified";

export type ServiceStates = {
  connection: ConnectionState;
  setup: SetupState;
  routing: RoutingState;
  acceptance: AcceptanceState | "not_applicable";
  ready: boolean;
  next: "connect" | "resolve_connection" | "choose_destination_and_set_up" | "retry_setup" | "staff_review_setup" | "wait_for_routing" | "make_acceptance_call" | "confirm_acceptance" | "none";
};

export function deriveServiceStates(i: {
  connectionStatus: "pending" | "registering" | "registered" | "active" | "failed" | null;
  ledger: AttachLedgerRecord | null;
  /** From the read-only adapter. null = the adapter could not answer (never read as "not routed"). */
  routing: { didActive: boolean; destinationActive: boolean; destinationTarget: string | null } | null;
  expectedTarget: string | null;
  acceptance: AcceptanceState | null;
}): ServiceStates {
  const connection: ConnectionState =
    i.connectionStatus === "active" ? "connected"
    : i.connectionStatus === "registering" ? "needs_review"
    : i.connectionStatus === "pending" || i.connectionStatus === "registered" ? "in_progress"
    : "not_connected"; // null and failed

  const setup: SetupState =
    connection !== "connected" || !i.ledger ? "not_started"
    : i.ledger.status === "attached" ? "set_up"
    : i.ledger.status === "needs_review" ? "needs_review"
    : i.ledger.status === "step_failed" ? "step_failed"
    : "in_progress";

  let routing: RoutingState = "unknown";
  if (i.routing) {
    if (!i.routing.didActive || !i.routing.destinationActive) routing = "not_routed";
    else if (i.expectedTarget && i.routing.destinationTarget === i.expectedTarget) routing = "verified";
    else routing = "routed_other_destination";
  }

  const acceptance: ServiceStates["acceptance"] = routing === "verified" && setup === "set_up" ? (i.acceptance ?? "not_recorded") : "not_applicable";
  const ready = connection === "connected" && setup === "set_up" && routing === "verified" && acceptance === "accepted";

  let next: ServiceStates["next"];
  if (connection === "not_connected") next = "connect";
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
