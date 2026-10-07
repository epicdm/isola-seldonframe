// Marketing landing page (server wrapper).
//
// 2026-05-22 — Ported the Claude Design HTML mockup
// (handoff `seldonframe-home.html`, 13 sections) to React + Tailwind
// section components. Replaces the prior Cut-C-onboarding-pivot
// composition (Hero / HowItWorks / Comparison / Soul / Bento /
// DemoVideo / Agencies / Marketplace / Pricing / FAQ / WhyNow / FinalCta)
// with the new HTML-faithful section list.
//
// Order (2026-06-22 positioning v2 — one idea per section ladder):
//   Nav (fixed) → Hero (+ demo marquee) → BuildSteps (the 3-min demo)
//   → IdeStrip ("Every IDE" — 2026-07-01, links to /build#install)
//   → Modules (Run rung) → SmbCta (Sell rung) → Agents (Hire agents)
//   → AgencyMath (Build & sell rung) → Pricing → ProofStrip
//   → FAQ → FinalCta → Footer.
//   MarketingReplace ("Why not just…") is demoted off the homepage to
//   keep the ladder to one idea per rung (component still ships).
//
// Skipped from the HTML port:
//   - §9 Marketplace (hidden in source HTML with display:none — README
//     says to skip until marketplace ships)
//   - Nav "1.4k" stars chip (fake number, per task #82's truth-pass
//     principle; the live GitHub-API-backed badge in
//     `github-stars-badge.tsx` is available if we want to wire one in)
//
// The existing LandingMarketingPricingSection (3 tiers, FEATURES
// matrix) and LandingMarketingFaqSection (8 questions with FAQPage
// JSON-LD schema) are kept verbatim — they carry the truth-pass copy
// updated this morning and the JSON-LD invariant. The HTML's pricing
// (Growth / Scale / Agency Partner) and FAQ (8 questions) copy was
// less accurate than what already shipped, so we let truth win.
//
// Preserves the existing auth redirect: signed-in users go to the
// dashboard; unauthenticated visitors see the marketing surface.

// Landing theme tokens — imported at the route level, NOT in
// unified-landing.tsx or landing-mode.tsx, so those stay importable
// under the node:test harness (no CSS loader in tsx). /record/page.tsx
// must carry the same import (Task 10).
import "@/components/landing/landing-theme.css";
import "@/components/motion/motion-tokens.css";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isWebUngatedBuildOn } from "@/lib/web-build/policy";
import { isRecordToAgentOn } from "@/lib/recordings/policy";

/** Public marketing uses the current agency ladder by default. Set the
 *  flag explicitly to "0" only for a controlled legacy rollback. */
function isTierLadderOn(env: { SF_TIER_LADDER?: string | undefined }): boolean {
  return env.SF_TIER_LADDER?.trim() !== "0";
}

import { UnifiedLanding } from "./unified-landing";
import { resolveLandingMode } from "./landing-mode";
// Positioning line is shared with the /home.md agent-Markdown twin (M3) so the
// promise can't drift between the human page and the Markdown.
import { POSITIONING_ONE_LINER } from "./home-copy";
import { buildPlatformOrganizationWebsiteGraph, resolvePlatformBranding } from "@/lib/branding/platform";

const platformBrand = resolvePlatformBranding();
const homeTitle = platformBrand.name === "SeldonFrame"
  ? "SeldonFrame — Sell AI front offices. Deploy them in minutes."
  : `${platformBrand.name}, operated by ${platformBrand.operatorName}`;
const homeDescription = platformBrand.name === "SeldonFrame"
  ? POSITIONING_ONE_LINER
  : `${platformBrand.name} is ${platformBrand.operatorName}'s workspace entry for internet and telephone services. Contact ${platformBrand.operatorName} to confirm service availability and setup.`;

export const metadata: Metadata = {
  title: homeTitle,
  description: homeDescription,
  openGraph: {
    title: homeTitle,
    description: homeDescription,
    type: "website",
    url: platformBrand.homeUrl,
    images: platformBrand.name === "SeldonFrame"
      ? [{ url: "/brand/og-image.png", width: 1200, height: 630 }]
      : platformBrand.logoUrl ? [{ url: platformBrand.logoUrl }] : [],
  },
  twitter: {
    card: "summary_large_image",
    title: homeTitle,
    description: homeDescription,
    images: platformBrand.name === "SeldonFrame"
      ? ["/brand/twitter-card.png"]
      : platformBrand.logoUrl ? [platformBrand.logoUrl] : [],
  },
};

export default async function PublicHomePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/dashboard");
  }
  const tierLadderOn = isTierLadderOn({ SF_TIER_LADDER: process.env.SF_TIER_LADDER });
  const params = await searchParams;
  const recordEnabled = isRecordToAgentOn({ SF_RECORD_TO_AGENT: process.env.SF_RECORD_TO_AGENT });
  const initialMode = resolveLandingMode(params.mode, recordEnabled);
  const siteGraph = platformBrand.name === "SeldonFrame"
    ? [
        {
          "@type": "Organization",
          "@id": "https://www.seldonframe.com/#org",
          name: "SeldonFrame",
          url: "https://www.seldonframe.com",
          logo: "https://www.seldonframe.com/brand/og-image.png",
          description: POSITIONING_ONE_LINER,
          founder: {
            "@type": "Person",
            name: "Maxime Houle",
            image: "https://www.seldonframe.com/brand/maxime-houle.png",
          },
          sameAs: [
            "https://x.com/seldonframe",
            "https://github.com/seldonframe",
            "https://linkedin.com/company/seldonframe",
          ],
        },
        {
          "@type": "WebSite",
          "@id": "https://www.seldonframe.com/#website",
          name: "SeldonFrame",
          url: "https://www.seldonframe.com",
          publisher: { "@id": "https://www.seldonframe.com/#org" },
        },
      ]
    : buildPlatformOrganizationWebsiteGraph(platformBrand, homeDescription);

  if (platformBrand.name !== "SeldonFrame") {
    const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@graph": siteGraph })
      .replace(/</g, "\\u003c");
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        <header className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">Operated by {platformBrand.operatorName}</p>
          {platformBrand.logoUrl ? <img className="max-h-12 max-w-56 object-contain object-left" src={platformBrand.logoUrl} alt={platformBrand.name} /> : null}
          <h1 className="text-4xl font-semibold tracking-tight">{platformBrand.name}</h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            {platformBrand.operatorName} provides internet and telephone services. Sign in to your {platformBrand.name} workspace, or contact {platformBrand.operatorName} to confirm service availability and setup.
          </p>
        </header>
        <nav className="flex flex-wrap items-center gap-4">
          <a className="inline-flex items-center rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground" href={`${platformBrand.appUrl}/login`}>Sign in</a>
          <a className="text-sm underline underline-offset-4" href={`mailto:${platformBrand.supportEmail}`}>Contact {platformBrand.operatorName}</a>
          <a className="text-sm underline underline-offset-4" href="/license">Open-source notices</a>
        </nav>
      </main>
    );
  }

  return (
    <>
      {/* Entity anchor: Organization + WebSite JSON-LD. Every other page's
          Article/SoftwareApplication schema hangs off this org identity, and
          sameAs ties the entity to the real X/GitHub profiles for E-E-A-T. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": siteGraph,
          }),
        }}
      />
      <UnifiedLanding
        initialMode={initialMode}
        recordEnabled={recordEnabled}
        urlStrategy="replace-state"
        tierLadderOn={tierLadderOn}
        ungatedBuildEnabled={isWebUngatedBuildOn({
          SF_WEB_UNGATED_BUILD: process.env.SF_WEB_UNGATED_BUILD,
        })}
        recordProps={{ claimedSessionId: null, claimed: false, isAuthed: false, sharedFlag: null }}
      />
    </>
  );
}
