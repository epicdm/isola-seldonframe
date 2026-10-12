// EPIC 2026-10-12 (AGPL-3.0 section 5(a) modification notice): the white-label platform
// storefront served at the root of a branded host (replaces the earlier minimal
// "Operated by EPIC" block in app/(public)/page.tsx).
//
// Visual language: the upstream SeldonFrame LANDING theme (`.lp-root` parchment tokens from
// components/landing/landing-theme.css, the same ones the upstream landing uses: warm
// background, deep-green CTA and closing slab, display serif headline, mono eyebrows, soft
// bordered cards). Content: ours only. The upstream landing's SECTIONS are not reused because
// they are the vendor's sales pitch (see docs/UPLINK-STOREFRONT.md for the section-by-section
// assessment). Server component, no client state. Every claim is backed by a Port record; see
// the claim-to-source table in docs/UPLINK-STOREFRONT.md. Do not add a claim without its source.

import { Building2, LogIn, MessageCircle, Phone, PhoneOutgoing, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PlatformBranding } from "@/lib/branding/platform";
import type { StorefrontConfig } from "@/lib/branding/storefront";

const cardCls = "gap-0 rounded-2xl border border-[var(--lp-border)] bg-[var(--lp-card)] py-0 text-[var(--lp-ink)] shadow-[0_1px_0_rgba(34,29,23,0.04),0_12px_32px_-18px_rgba(34,29,23,0.18)] ring-0";
const btnBase = "inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lp-accent)]/40";
const btnPrimary = cn(btnBase, "w-full bg-[var(--lp-cta-bg)] text-[var(--lp-cta-ink)] hover:bg-[var(--lp-accent-strong)] sm:w-auto");
const btnOutline = cn(btnBase, "w-full border border-[var(--lp-border)] bg-transparent text-[var(--lp-ink)] hover:bg-[var(--lp-accent-soft)] sm:w-auto");

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0 text-[var(--lp-accent)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-sm leading-relaxed text-[var(--lp-ink)]">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <Check />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("inline-flex items-center gap-2.5 font-mono text-[11.5px] font-medium uppercase tracking-[0.16em] text-[var(--lp-muted)] before:block before:h-px before:w-4 before:bg-current before:opacity-55", className)}>
      {children}
    </p>
  );
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-11 items-center justify-center rounded-xl bg-[var(--lp-accent-soft)] text-[var(--lp-accent)]" aria-hidden="true">
      {children}
    </span>
  );
}

const STEPS = [
  { icon: MessageCircle, title: "Sign up in WhatsApp", body: "Chat with EPIC, confirm your free trial and get your number and step-by-step guidance." },
  { icon: Smartphone, title: "Install the free app", body: "Get the Cloud Softphone app for iPhone or Android and set up your line with a one-tap link." },
  { icon: PhoneOutgoing, title: "Make your calls", body: "Call from the app on your own +1 767 Dominica number." },
];

export function PlatformStorefront({ brand, config }: { brand: PlatformBranding; config: StorefrontConfig }) {
  const pl = config.personalLine;
  return (
    <div className="lp-root relative min-h-screen overflow-x-clip bg-[var(--lp-bg)] text-[var(--lp-ink)]" data-platform-storefront>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(55%_70%_at_50%_0%,rgba(61,110,79,0.13),transparent_70%)]"
      />

      {!pl.signupOpen ? (
        <div role="status" className="relative border-b border-[var(--lp-border-soft)] bg-[var(--lp-accent-soft)] px-5 py-2.5 text-center text-sm" data-storefront-banner="signup-unavailable">
          <span className="font-medium">Personal Line sign-up is temporarily unavailable.</span>{" "}
          <span className="text-[var(--lp-body)]">Details are in the Personal Line section below.</span>
        </div>
      ) : null}

      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-3">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="max-h-9 max-w-40 object-contain object-left" src={brand.logoUrl} alt={brand.name} />
          ) : (
            <span className="text-xl font-semibold tracking-tight">{brand.name}</span>
          )}
          <span className="hidden border-l border-[var(--lp-border)] pl-3 text-sm text-[var(--lp-muted)] sm:inline">by {brand.operatorName}</span>
        </div>
        <a href={config.signIn.href} className={cn(btnOutline, "h-9 w-auto px-5")} data-storefront-signin-link>
          Sign in
        </a>
      </header>

      <main className="relative">
        <section className="mx-auto w-full max-w-6xl px-5 pb-12 pt-10 sm:px-8 sm:pb-16 sm:pt-16">
          <Eyebrow>Internet and telephone services</Eyebrow>
          <h1 className="mt-5 max-w-3xl text-balance font-display text-[clamp(36px,6vw,64px)] font-semibold leading-[1.03] tracking-[-0.03em]">
            Phone and internet services, operated by {brand.operatorName}.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--lp-body)] sm:text-lg">
            {brand.name} is {brand.operatorName}&rsquo;s service platform. Choose how you want to get started: a personal calling line, services for your business, or sign in to your workspace.
          </p>
        </section>

        <section aria-label="Get started" className="mx-auto grid w-full max-w-6xl gap-5 px-5 sm:px-8 lg:grid-cols-3 lg:gap-6">
          {/* 1. Personal Line: the featured offer */}
          <Card className={cn(cardCls, "lg:col-span-2")} data-entry="personal-line">
            <CardContent className="grid gap-8 p-6 sm:p-8 md:grid-cols-[1.05fr_1fr]">
              <div className="flex flex-col gap-5">
                <IconTile><Phone className="size-5" /></IconTile>
                <div className="space-y-2">
                  <Eyebrow>For individuals</Eyebrow>
                  <h2 className="font-display text-3xl font-semibold tracking-tight">Personal Line</h2>
                  <p className="text-sm leading-relaxed text-[var(--lp-body)]">
                    Your own +1 767 Dominica number for making voice calls from the free Cloud Softphone app on iPhone and Android.
                  </p>
                </div>
                <Bullets
                  items={[
                    "Free 7-day trial with 60 Dominica minutes, EC$0.",
                    "The launch offer covers outgoing calling.",
                    "Voice only: no SMS and no emergency calling.",
                  ]}
                />
                <div className="mt-auto flex flex-col gap-3 pt-1">
                  {pl.signupOpen && pl.ctaHref ? (
                    <a href={pl.ctaHref} className={btnPrimary} data-cta="personal-line-signup" data-signup-state="open">
                      {pl.ctaLabel}
                    </a>
                  ) : (
                    <div role="status" className="rounded-xl border border-[var(--lp-border)] bg-[var(--lp-accent-soft)] p-4 text-sm leading-relaxed" data-cta="personal-line-signup" data-signup-state="unavailable">
                      <p className="font-medium">{pl.ctaLabel}</p>
                      <p className="mt-1.5 text-[var(--lp-body)]">{pl.notice}</p>
                      <a href={pl.contactHref} className={cn(btnOutline, "mt-3 h-10")}>
                        Email {brand.operatorName}
                      </a>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--lp-border-soft)] bg-[var(--lp-bg)] p-5 sm:p-6">
                <Eyebrow>How Personal Line works</Eyebrow>
                <ol className="mt-5 space-y-6">
                  {STEPS.map((step, i) => (
                    <li key={step.title} className="flex gap-3.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--lp-cta-bg)] text-xs font-semibold text-[var(--lp-cta-ink)]" aria-hidden="true">{i + 1}</span>
                      <div className="space-y-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <step.icon className="size-4 text-[var(--lp-muted)]" aria-hidden="true" />
                          {step.title}
                        </p>
                        <p className="text-sm leading-relaxed text-[var(--lp-body)]">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </CardContent>
          </Card>

          {/* 3. Workspace sign-in */}
          <Card className={cardCls} data-entry="workspace-sign-in">
            <CardContent className="flex h-full flex-col gap-5 p-6 sm:p-8">
              <IconTile><LogIn className="size-5" /></IconTile>
              <div className="space-y-2">
                <Eyebrow>Existing customers</Eyebrow>
                <h2 className="font-display text-3xl font-semibold tracking-tight">Workspace sign-in</h2>
                <p className="text-sm leading-relaxed text-[var(--lp-body)]">
                  Already have a {brand.name} workspace? Sign in to manage it.
                </p>
              </div>
              <Bullets items={["We email you a sign-in link; there is no password to remember."]} />
              <div className="mt-auto pt-1">
                <a href={config.signIn.href} className={cn(btnPrimary, "sm:w-full")} data-cta="workspace-signin">
                  Sign in to your workspace
                </a>
              </div>
            </CardContent>
          </Card>

          {/* 2. Business services: a full-width band */}
          <Card className={cn(cardCls, "lg:col-span-3")} data-entry="business-services">
            <CardContent className="grid items-center gap-6 p-6 sm:p-8 md:grid-cols-[1.2fr_1fr_auto] md:gap-10">
              <div className="flex items-start gap-4">
                <IconTile><Building2 className="size-5" /></IconTile>
                <div className="space-y-2">
                  <Eyebrow>For businesses</Eyebrow>
                  <h2 className="font-display text-3xl font-semibold tracking-tight">Business services</h2>
                  <p className="text-sm leading-relaxed text-[var(--lp-body)]">
                    Internet and telephone service for your business, set up and run by {brand.operatorName}.
                  </p>
                </div>
              </div>
              <Bullets
                items={[
                  `Set up with a person at ${brand.operatorName}, not a self-service form.`,
                  "Availability depends on your location and the service you need, so we confirm it with you first.",
                ]}
              />
              <div className="flex flex-col gap-2">
                <a href={config.business.contactHref} className={btnOutline} data-cta="business-contact">
                  Contact {brand.operatorName}
                </a>
                <p className="text-xs text-[var(--lp-muted)]">Opens an email to {config.supportEmail}.</p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Closing slab: the upstream landing's deep-green final-CTA pattern, with our contact route. */}
        <section className="mx-auto mt-16 w-full max-w-6xl px-5 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-[var(--lp-cta-slab)] px-6 py-10 text-[var(--lp-cta-slab-ink)] sm:flex-row sm:items-center sm:px-10">
            <div className="max-w-xl space-y-2">
              <h2 className="font-display text-3xl font-semibold tracking-tight">Not sure which one fits?</h2>
              <p className="text-sm leading-relaxed opacity-80">Email {brand.operatorName} and a person will point you to the right service.</p>
            </div>
            <a href={config.business.contactHref} className={cn(btnBase, "w-full bg-[var(--lp-cta-slab-ink)] text-[var(--lp-cta-slab)] hover:opacity-90 sm:w-auto")}>
              Contact {brand.operatorName}
            </a>
          </div>
        </section>
      </main>

      <footer className="relative mt-16 border-t border-[var(--lp-border)] bg-[var(--lp-bg-alt)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-[var(--lp-muted)] sm:flex-row sm:items-start sm:justify-between sm:px-8">
          <div className="space-y-1">
            <p className="font-medium text-[var(--lp-ink)]">{brand.name} by {brand.operatorName}</p>
            <p>
              {brand.name} is operated by {brand.operatorName}. Questions: <a className="underline underline-offset-4" href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a>
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Legal">
            <a className="underline underline-offset-4" href="/license">Open-source notices</a>
            {brand.sourceUrl ? (
              <a className="underline underline-offset-4" href={brand.sourceUrl} rel="noopener noreferrer">Source code</a>
            ) : null}
          </nav>
        </div>
      </footer>
    </div>
  );
}
