// EPIC 2026-10-11 — "Your Personal Line" card on the customer portal Home (subscriber account slice 2a).
// Pure presentation of lib/personal-line/card.ts. Every figure that is null renders as "Not available" — never 0,
// never a guess. The error state says plainly that the line cannot be shown (CLAUDE.md §2.26: no false assurance).
import type { PlCard, PlSummary } from "@/lib/personal-line/card";

export const PL_CARD_ERROR_TEXT = "We can't show your line right now";
const HELP_WHATSAPP = "https://wa.me/17678180001";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { timeZone: "America/Dominica", month: "long", day: "numeric", year: "numeric" });
}

function walletText(w: PlSummary["wallet"]): string {
  if (!w) return "Not available";
  const sym = w.currency === "XCD" ? "EC$" : `${w.currency} `;
  return `${sym}${w.amount}`;
}

function minutesText(s: PlSummary): string {
  if (s.minutesLeft === null) return "Not available";
  return s.minutesIncluded !== null ? `${s.minutesLeft} of ${s.minutesIncluded} minutes left` : `${s.minutesLeft} minutes left`;
}

const SETUP_TEXT: Record<PlSummary["setupState"], string> = {
  registered: "Connected — your Cloud Softphone app is signed in",
  not_registered: "Not connected — open the Cloud Softphone app to finish setting up",
  unknown: "We can't check your connection right now",
};

const cardStyle = { backgroundColor: "#FFFFFF", border: "1px solid #E5E5E1", borderRadius: "14px" } as const;

export function PersonalLineCard({ card }: { card: PlCard }) {
  if (card.kind === "none") return null;
  if (card.kind === "error") {
    return (
      <article data-personal-line-card="error" className="px-6 py-5 sm:px-8" style={cardStyle} aria-label="Your Personal Line">
        <p className="text-[11px] uppercase tracking-wide" style={{ color: "#888" }}>Your Personal Line</p>
        <p className="mt-2 text-[15px]" style={{ color: "#444" }}>{PL_CARD_ERROR_TEXT}.</p>
        <a href={HELP_WHATSAPP} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-[13px] underline" style={{ color: "#111" }}>
          Get help on WhatsApp
        </a>
      </article>
    );
  }
  const s = card.summary;
  const planEnd = formatDate(s.planEnd);
  const plan = s.planName ?? s.plan;
  const rows: Array<[string, string]> = [
    ["Plan", plan ? (planEnd ? `${plan} — ends ${planEnd}` : plan) : "Not available"],
    ["Minutes", minutesText(s)],
    ["Wallet credit", walletText(s.wallet)],
    ["Setup", SETUP_TEXT[s.setupState]],
  ];
  return (
    <article data-personal-line-card="ok" className="px-6 py-6 sm:px-8 sm:py-7" style={cardStyle} aria-label="Your Personal Line">
      <p className="text-[11px] uppercase tracking-wide" style={{ color: "#888" }}>Your Personal Line</p>
      <h2 className="mt-2 text-[22px] sm:text-[26px] font-semibold tracking-tight" style={{ color: "#111" }} data-personal-line-number="">
        {s.did}
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-y-2 text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-x-4">
            <dt style={{ color: "#888" }}>{k}</dt>
            <dd style={{ color: "#111" }}>{v}</dd>
          </div>
        ))}
      </dl>
      <a href={HELP_WHATSAPP} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex h-9 items-center px-4 text-[13px] font-medium"
        style={{ backgroundColor: "#FFFFFF", color: "#111", borderRadius: "8px", border: "1px solid #E5E5E1" }}>
        Get help on WhatsApp
      </a>
    </article>
  );
}
