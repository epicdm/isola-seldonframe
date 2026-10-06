import type { Metadata } from "next";
import { getPlatformBranding } from "@/lib/platform/branding";
import { headers } from "next/headers";
import { DemoToastProvider } from "@/components/shared/demo-toast-provider";
import { ThemeProvider } from "@/components/shared/theme-provider";
import {
  GoogleAnalytics,
  shouldRenderGoogleAnalytics,
} from "@/components/analytics/google-analytics";
import {
  MarketingStructuredData,
  shouldRenderMarketingStructuredData,
} from "@/components/analytics/structured-data";
import StyledJsxRegistry from "./styled-jsx-registry";
import "./globals.css";

// SLICE 9 PR 2 C1: brand asset application. References go through
// /brand/ (extracted from the canonical asset bundle in the brand
// README). The legacy /logo.svg path is kept on disk for now (not
// removed in this commit) but no longer referenced from layout meta.
const platformBranding = getPlatformBranding();
const defaultMetadataTitle = "SeldonFrame — Sell AI front offices. Deploy them in minutes.";
const defaultMetadataDescription =
  "The agent-native, open-source alternative to GoHighLevel for agencies selling AI front offices to local businesses. Deploy branded client workspaces, booking, CRM, intake, and agents from one repeatable delivery loop.";
const metadataTitle = platformBranding.name === "SeldonFrame"
  ? defaultMetadataTitle
  : `${platformBranding.name} — Your communications, customers and AI front office`;
const metadataDescription = platformBranding.name === "SeldonFrame"
  ? defaultMetadataDescription
  : "Your communications, customers and AI front office—running on infrastructure EPIC already operates.";

export const metadata: Metadata = {
  metadataBase: new URL(platformBranding.homeUrl),
  title: metadataTitle,
  description: metadataDescription,
  manifest: platformBranding.showVendorBranding ? "/brand/manifest.webmanifest" : undefined,
  icons: platformBranding.faviconUrl
    ? {
        icon: [{ url: platformBranding.faviconUrl }],
        shortcut: platformBranding.faviconUrl,
        apple: [{ url: platformBranding.faviconUrl }],
      }
    : undefined,
  openGraph: {
    title: metadataTitle,
    description: metadataDescription,
  },
  twitter: {
    card: "summary",
    title: metadataTitle,
    description: metadataDescription,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // v1.40.14 — Google Analytics, host-aware. Only renders on
  // SeldonFrame-owned hosts (seldonframe.com, app.seldonframe.com).
  // Workspace subdomains and preview deploys get no GA injection
  // — see components/analytics/google-analytics.tsx for the
  // privacy rationale.
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const hostHeader = (await headers()).get("host") ?? "";
  const renderGA =
    Boolean(measurementId) && shouldRenderGoogleAnalytics(hostHeader);

  // SEO/GEO: marketing-only structured data. Renders Organization +
  // WebSite + SoftwareApplication JSON-LD on seldonframe.com only.
  // NOT on app.seldonframe.com (operator dashboard) or workspace
  // subdomains (per-workspace LocalBusiness schema is generated
  // separately per workspace). See structured-data.tsx for the
  // host-allowlist rationale.
  const renderMarketingSchema = shouldRenderMarketingStructuredData(hostHeader);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {/* StyledJsxRegistry flushes styled-jsx rules into the SSR <head> so the
            public landing-r1 surfaces paint fully styled (no FOUC). */}
        <StyledJsxRegistry>
          {renderGA && measurementId ? (
            <GoogleAnalytics measurementId={measurementId} />
          ) : null}
          {renderMarketingSchema ? <MarketingStructuredData /> : null}
          <ThemeProvider>
            <DemoToastProvider>{children}</DemoToastProvider>
          </ThemeProvider>
        </StyledJsxRegistry>
      </body>
    </html>
  );
}
