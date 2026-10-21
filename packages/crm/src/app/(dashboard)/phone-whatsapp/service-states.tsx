// Presentational only (no data access, no actions): the four SEPARATE states of a number's calling service. "Connected to Meta" is one row among four and
// is never worded as "ready". Not yet wired into the page: wiring is the next increment, behind the same exposure flags.
import type { ServiceStates } from "@/lib/phone-whatsapp/service/states";
import type { RoutingHealth } from "@/lib/phone-whatsapp/service/routing-observations";

const TEXT = {
  connection: {
    not_connected: ["Not connected to Meta", "attention"],
    in_progress: ["Connection not finished", "attention"],
    needs_review: ["Connection needs EPIC to check it", "attention"],
    connected: ["Connected to Meta", "ok"],
    linked_by_staff: ["Connected to Meta (number linked by EPIC staff)", "ok"],
    unknown: ["Could not be checked with Meta right now", "unknown"],
  },
  setup: {
    not_started: ["Calling service not set up yet", "attention"],
    in_progress: ["Calling service setup is running", "attention"],
    step_failed: ["Calling service setup stopped part-way; you can retry", "attention"],
    needs_review: ["Calling service setup needs EPIC to check it", "attention"],
    set_up: ["Calling service account and destination set up", "ok"],
    staff_managed: ["Managed by EPIC staff, not set up from this page", "unknown"],
  },
  routing: {
    unknown: ["Routing could not be checked right now", "unknown"],
    not_routed: ["Calls are not being sent anywhere yet", "attention"],
    routed_other_destination: ["Calls go to a different destination than the one you chose", "attention"],
    routed_by_staff: ["Calls are configured to go to the destination EPIC staff set (shown below); none was chosen on this page", "unknown"],
    verified: ["Calls are routed to your chosen destination", "ok"],
  },
  acceptance: {
    not_applicable: ["Acceptance call comes after setup and routing", "unknown"],
    not_recorded: ["No acceptance call yet", "attention"],
    routing_not_verified: ["Routing must be verified before an acceptance call", "attention"],
    call_seen_unconfirmed: ["A call was seen; an admin must confirm two-way audio", "attention"],
    failed: ["The last acceptance call did not work; place another", "attention"],
    accepted: ["An acceptance call worked in both directions", "ok"],
  },
} as const;

const NEXT: Record<ServiceStates["next"], string> = {
  connect: "Connect your WhatsApp number.",
  resolve_connection: "Finish or review the connection first.",
  choose_destination_and_set_up: "Choose where calls are answered, then set up the calling service.",
  retry_setup: "Retry the setup; it continues from where it stopped.",
  staff_review_setup: "EPIC will check the setup; nothing has been undone.",
  wait_for_routing: "Waiting for routing to show your destination.",
  make_acceptance_call: "Place an acceptance call to the number.",
  confirm_acceptance: "Confirm that the call had audio in both directions.",
  staff_managed: "Calling for this number is managed by EPIC staff. To change where calls go, contact EPIC.",
  recheck: "Reload this page to check again.",
  none: "Nothing left to do.",
};

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const HEALTH_TONE: Record<RoutingHealth["state"], string> = { verified: "ok", faults: "attention", configured_unverified: "unknown", not_measured: "unknown", unknown: "unknown" };

type Eligibility = { tone: "ok" | "attention" | "unknown"; headline: string };

// Heading: "verified" appears only when routing health is a recorded passing WhatsApp call (staff-linked) or all four states are good (self-serve).
function heading(states: ServiceStates, observedAt: string | null, eligibility: Eligibility | null, h: RoutingHealth | null): string {
  if (h) {
    if (h.state === "verified" && states.connection === "linked_by_staff" && eligibility?.tone === "ok") return `WhatsApp calling verified as of ${utc(h.observedAt!)}`;
    if (h.state === "faults") return "Calling for this number is not operational";
    return "Calling for this number is managed by EPIC staff; WhatsApp calling is not verified";
  }
  if (states.ready) return observedAt ? `Calling service verified ready as of ${utc(observedAt)}` : "Calling service verified ready";
  return states.next === "staff_managed" ? "Calling for this number is managed by EPIC staff" : states.next === "recheck" ? "Calling service status could not be checked" : "Calling service is not ready yet";
}

export function ServiceStatesCard({ states, observedAt = null, eligibility = null, routingHealth = null }: { states: ServiceStates; observedAt?: string | null; eligibility?: Eligibility | null; routingHealth?: RoutingHealth | null }) {
  const rows: Array<readonly [string, readonly [string, string]]> = [
    ["Connection to Meta", TEXT.connection[states.connection]],
    ...(eligibility ? [["Calling eligibility", [eligibility.headline, eligibility.tone]] as const] : []),
    ["Calling service setup", TEXT.setup[states.setup]],
    ["Routing", routingHealth ? [routingHealth.text, HEALTH_TONE[routingHealth.state]] as const : TEXT.routing[states.routing]],
    ["Acceptance call", routingHealth ? (routingHealth.state === "verified" ? ["Recorded by EPIC staff (see Routing)", "ok"] as const : ["No passing WhatsApp acceptance call is recorded for the current route", "attention"] as const) : TEXT.acceptance[states.acceptance]],
  ];
  return (
    <section className="crm-card space-y-2 p-4" data-testid="service-states" aria-label="Calling service status">
      <h2 className="text-lg font-semibold">
        {heading(states, observedAt, eligibility, routingHealth)}
      </h2>
      {states.ready ? (
        <p className="text-xs text-muted-foreground" data-testid="service-ready-scope">
          This describes the configuration checked at that time. It is re-checked each time this page loads; it is not monitored continuously, and a route changed and changed back between two checks would not be noticed.
        </p>
      ) : null}
      <ul className="space-y-1 text-sm">
        {rows.map(([label, [text, tone]]) => (
          <li key={label} data-tone={tone}>
            <span className="font-medium">{label}:</span> {text}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground" data-testid="service-next">Next: {NEXT[states.next]}</p>
    </section>
  );
}
