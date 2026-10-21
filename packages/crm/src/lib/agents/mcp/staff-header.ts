// EPIC 2026-10-21 — the per-call X-Staff-Id header for the Company lane's ask_employee bridge (bridge contract v0.4).
//
// The bridge keys its sessions and caps per (staff member, employee) on an X-Staff-Id HEADER that Uplink sets per call.
// It is deliberately not a tool argument, so the model can never name someone else. Rules enforced here and in
// wrap-tool.ts:
//   - the header goes ONLY to the one connector whose secret service name equals UPLINK_ASK_EMPLOYEE_SERVICE (unset =
//     no connector is the bridge; nothing ever carries the header);
//   - its value comes ONLY from the signed-in session's member (resolveAskEmployeeCaller), re-read on every call;
//   - a call to the bridge without a staff session (customer, public, voice, SMS, cron turns), from a turn not marked
//     as staff-driven, by a removed member, or with the owner-configurable permission OFF is REFUSED before any request.
// Pure helpers; the session read is injected (WrapMcpDeps.resolveStaffId).

export const STAFF_ID_HEADER = "x-staff-id";

/** True iff this connector's secret service name is the configured ask_employee bridge. */
export function isAskEmployeeService(serviceName: string, env: Record<string, string | undefined> = process.env): boolean {
  const configured = env.UPLINK_ASK_EMPLOYEE_SERVICE?.trim();
  return Boolean(configured) && serviceName === configured;
}

export class AskEmployeeCallerRefusedError extends Error {
  readonly code = "ask_employee_staff_session_required";
  constructor() {
    super("ask_employee can only be used by a signed-in staff member who has the Ask-an-employee permission.");
    this.name = "AskEmployeeCallerRefusedError";
  }
}
