// EPIC 2026-10-12 (AGPL-3.0 section 5(a) modification notice): the white-label platform
// storefront served at the root of a branded host (replaces the earlier minimal
// "Operated by EPIC" block in app/(public)/page.tsx).
//
// Server component, no client state. Built only from the existing SeldonFrame design
// tokens and primitives (Card, Badge, buttonVariants). Every claim here is backed by a Port
// record; see docs/UPLINK-STOREFRONT.md for the claim-to-source table. Do not add a claim
// without adding its source there.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { PlatformBranding } from "@/lib/branding/platform";
import type { StorefrontConfig } from "@/lib/branding/storefront";

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0 text-primary" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-sm leading-relaxed text-foreground/90">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <Check />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const primaryCta = cn(buttonVariants({ variant: "default", size: "lg" }), "h-11 w-full justify-center px-4 text-sm sm:w-auto");
const secondaryCta = cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 w-full justify-center px-4 text-sm sm:w-auto");

export function PlatformStorefront({ brand, config }: { brand: PlatformBranding; config: StorefrontConfig }) {
  const pl = config.personalLine;
  return (
    <div className="min-h-screen bg-background text-foreground" data-platform-storefront>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-3">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="max-h-9 max-w-40 object-contain object-left" src={brand.logoUrl} alt={brand.name} />
          ) : (
            <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
          )}
          <span className="hidden text-sm text-muted-foreground sm:inline">by {brand.operatorName}</span>
        </div>
        <a href={config.signIn.href} className={cn(buttonVariants({ variant: "ghost", size: "lg" }), "h-9 px-3")} data-storefront-signin-link>
          Sign in
        </a>
      </header>

      <main>
        <section className="mx-auto w-full max-w-6xl px-5 pb-10 pt-8 sm:px-8 sm:pb-14 sm:pt-14">
          <p className="mb-5 inline-flex items-center gap-2.5 font-mono text-[11.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground before:block before:h-px before:w-4 before:bg-current before:opacity-55">
            {brand.name} by {brand.operatorName}
          </p>
          <h1 className="max-w-3xl text-balance font-display text-[clamp(34px,6vw,60px)] font-semibold leading-[1.04] tracking-[-0.03em]">
            Phone and internet services, operated by {brand.operatorName}.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            {brand.name} is {brand.operatorName}&rsquo;s service platform. Pick the door that fits you: a personal calling line, services for your business, or your workspace.
          </p>
        </section>

        <section aria-label="Get started" className="mx-auto grid w-full max-w-6xl gap-5 px-5 pb-16 sm:px-8 md:grid-cols-3 md:gap-6">
          {/* 1. Personal Line */}
          <Card className="gap-5 py-6" data-entry="personal-line">
            <CardHeader className="gap-2 px-6">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">For individuals</p>
              <CardTitle className="text-xl font-semibold tracking-tight">Personal Line</CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Your own +1 767 Dominica number for making voice calls from the free Cloud Softphone app on iPhone and Android.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5 px-6">
              <Bullets
                items={[
                  "Free 7-day trial with 60 Dominica minutes, EC$0.",
                  "The launch offer covers outgoing calling.",
                  "Voice only: no SMS and no emergency calling.",
                ]}
              />
              <div className="mt-auto flex flex-col gap-3">
                {pl.signupOpen && pl.ctaHref ? (
                  <>
                    <a href={pl.ctaHref} className={primaryCta} data-cta="personal-line-signup" data-signup-state="open">
                      {pl.ctaLabel}
                    </a>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      You sign up and get guidance in WhatsApp, then install the free app to make calls.
                    </p>
                  </>
                ) : (
                  <div
                    role="status"
                    className="rounded-lg border border-border bg-muted/60 p-4 text-sm leading-relaxed"
                    data-cta="personal-line-signup"
                    data-signup-state="unavailable"
                  >
                    <p className="font-medium">{pl.ctaLabel}</p>
                    <p className="mt-1.5 text-muted-foreground">{pl.notice}</p>
                    <a href={pl.contactHref} className={cn(buttonVariants({ variant: "outline", size: "lg" }), "mt-3 h-10 w-full justify-center px-4 text-sm")}>
                      Email {brand.operatorName}
                    </a>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 2. Business services */}
          <Card className="gap-5 py-6" data-entry="business-services">
            <CardHeader className="gap-2 px-6">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">For businesses</p>
              <CardTitle className="text-xl font-semibold tracking-tight">Business services</CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Internet and telephone service for your business, set up and run by {brand.operatorName}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5 px-6">
              <Bullets
                items={[
                  `Set up with a person at ${brand.operatorName}, not a self-service form.`,
                  "Availability depends on your location and the service you need, so we confirm it with you first.",
                ]}
              />
              <div className="mt-auto flex flex-col gap-3">
                <a href={config.business.contactHref} className={secondaryCta} data-cta="business-contact">
                  Contact {brand.operatorName}
                </a>
                <p className="text-xs leading-relaxed text-muted-foreground">Opens an email to {config.supportEmail}.</p>
              </div>
            </CardContent>
          </Card>

          {/* 3. Workspace sign-in */}
          <Card className="gap-5 py-6" data-entry="workspace-sign-in">
            <CardHeader className="gap-2 px-6">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Existing customers</p>
              <CardTitle className="text-xl font-semibold tracking-tight">Workspace sign-in</CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Already have a {brand.name} workspace? Sign in to manage it.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5 px-6">
              <Bullets items={["We email you a sign-in link; there is no password to remember."]} />
              <div className="mt-auto flex flex-col gap-3">
                <a href={config.signIn.href} className={primaryCta} data-cta="workspace-signin">
                  Sign in to your workspace
                </a>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>
            {brand.name} is operated by {brand.operatorName}. Questions: <a className="underline underline-offset-4" href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a>
          </p>
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
