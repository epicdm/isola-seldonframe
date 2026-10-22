// v1.30.2 — Shared article shell.
//
// Linear-style: small "category" eyebrow, big H1, lede paragraph, then
// children. Footer has prev/next siblings + edit-on-GitHub link.
//
// Each article page imports this and passes:
//   <ArticleShell category="..." title="..." lede="..." githubPath="...">
//     ...content...
//   </ArticleShell>
//
// Keep article content terse (Linear-style). Where the doc is "click
// here to do X" rather than long-form prose, link to the in-app
// surface and stop.

import Link from "next/link";
import { ChevronRight, Pencil } from "lucide-react";

const REPO = "https://github.com/seldonframe/seldonframe";

export function ArticleShell({
  category,
  categoryHref,
  title,
  lede,
  githubPath,
  children,
}: {
  category: string;
  categoryHref?: string;
  title: string;
  lede?: string;
  /** path relative to packages/crm/src/ — used for "Edit on GitHub" link */
  githubPath?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="docs-article">
      <nav className="mb-8 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link href="/docs" className="hover:text-foreground transition-colors">
          Docs
        </Link>
        <ChevronRight className="size-3" />
        {categoryHref ? (
          <Link href={categoryHref} className="hover:text-foreground transition-colors">
            {category}
          </Link>
        ) : (
          <span>{category}</span>
        )}
      </nav>

      <header className="mb-10">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          {title}
        </h1>
        {lede ? (
          <p className="mt-4 text-lg text-muted-foreground leading-relaxed">{lede}</p>
        ) : null}
      </header>

      <div className="docs-prose"><UpstreamGeneral />
      {children}</div>

      <footer className="mt-16 border-t pt-8 flex items-center justify-between gap-4 text-sm">
        <Link
          href="/docs"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to all docs
        </Link>
        {githubPath ? (
          <a
            href={`${REPO}/blob/main/packages/crm/src/${githubPath}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="size-3.5" />
            Edit on GitHub
          </a>
        ) : null}
      </footer>
    </article>
  );
}

/**
 * Inline pill-shaped link to an in-app surface. Use when the doc's
 * point is "click this to do the thing" — saves users from reading.
 */
export function InAppLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
    >
      {children}
      <ChevronRight className="size-3.5" />
    </Link>
  );
}

/** Numbered step in a how-to. */
export function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-3">
      <div className="shrink-0 size-7 rounded-full border bg-card text-xs font-semibold flex items-center justify-center text-foreground">
        {n}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <h3 className="text-base font-semibold text-foreground mb-1.5">{title}</h3>
        <div className="text-sm text-muted-foreground leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

/** "Coming soon" marker for unbuilt features. */
export function ComingSoon({ children }: { children?: React.ReactNode }) {
  return (
    <div className="my-6 rounded-lg border border-dashed bg-muted/20 px-5 py-4">
      <p className="text-sm font-semibold text-foreground mb-1">Coming soon</p>
      <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
    </div>
  );
}

/** Callout box: info / tip / warn. */
export function Callout({
  variant = "info",
  title,
  children,
}: {
  variant?: "info" | "tip" | "warn";
  title?: string;
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-blue-500/30 bg-blue-500/5",
    tip: "border-emerald-500/30 bg-emerald-500/5",
    warn: "border-amber-500/30 bg-amber-500/5",
  }[variant];
  return (
    <div className={`my-5 rounded-lg border ${styles} px-5 py-4`}>
      {title ? <p className="text-sm font-semibold text-foreground mb-1">{title}</p> : null}
      <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
}

// Upstream instructions that do NOT apply to EPIC's Uplink deployment. One place for the wording.
// Nothing here may claim that an integration is configured or usable for EPIC: say "check with EPIC".
export const UPSTREAM_NOTICES = {
  signup: `Sign up, "Start building" and similar steps describe upstream's hosted SeldonFrame service. They do not apply to EPIC's Uplink deployment. Ask EPIC how access to Uplink is arranged.`,
  plans: `Plans, tiers, prices and plan limits mentioned in these docs are upstream SeldonFrame's. They are not EPIC's Uplink plans or prices. Ask EPIC for current terms.`,
  keys: `Connecting your own Stripe, Twilio, Resend, Anthropic/OpenAI or Google accounts is upstream's self-service setup. Whether an integration is available to you on EPIC's Uplink, and how it is set up, is not described here: check with EPIC.`,
  mcp: `The Claude Code / MCP quickstart is written for upstream's hosted SeldonFrame (its server address, tokens and tool list). Whether your account can use it on EPIC's Uplink: check with EPIC. Do not paste upstream tokens or addresses.`,
  domains: `Custom-domain self-service is an upstream feature. Whether and how EPIC sets up a custom domain for your Uplink workspace: check with EPIC. Uplink workspace sites are served at <name>.uplink.epic.dm.`,
  hosts: `Example addresses in this article may be upstream's. On Uplink the app is uplink.epic.dm and workspace sites are <name>.uplink.epic.dm. Any other path or snippet shown here that was not checked against Uplink is unverified: check with EPIC.`,
} as const;

export type UpstreamNoticeKind = keyof typeof UPSTREAM_NOTICES;

// Shown on EVERY docs page (ArticleShell and the docs home): the pages describe upstream's product, not EPIC's service.
export const UPSTREAM_GENERAL = `These docs describe upstream SeldonFrame's product. The features, steps and timings described may not be available or set up on EPIC's Uplink: check with EPIC before relying on them.`;

export function UpstreamGeneral() {
  return <p className="my-4 rounded-md border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">{UPSTREAM_GENERAL}</p>;
}

export function UpstreamNotice({ kinds }: { kinds: UpstreamNoticeKind[] }) {
  return (
    <Callout variant="warn" title="Upstream instructions - not applicable to EPIC's Uplink">
      <ul className="list-disc space-y-1 pl-5">
        {kinds.map((kind) => (
          <li key={kind}>{UPSTREAM_NOTICES[kind]}</li>
        ))}
      </ul>
    </Callout>
  );
}

/** Code block that wraps cleanly and looks like a terminal. */
export function CodeBlock({ children, language }: { children: string; language?: string }) {
  return (
    <pre className="my-4 overflow-x-auto rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed">
      <code className={language ? `language-${language}` : undefined}>{children}</code>
    </pre>
  );
}
