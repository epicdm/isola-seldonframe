// /marketplace.md — the clean-Markdown twin of the /marketplace storefront.
//
// Explicit `.md` URL → ALWAYS Markdown (no Accept negotiation; the proxy only
// negotiates the HTML page). Rendered from the SAME storefront catalog the HTML
// page loads (loadStorefrontCatalog → render-markdown), so it can never drift.
//
// Vary: Accept + a Link rel="alternate" back to the HTML page declare the twin
// to CDNs and crawlers — exactly the dual-representation pattern the design doc
// specifies (the HTML page advertises the .md; the .md points back at HTML).

import { loadStorefrontCatalog } from "@/lib/marketplace/load-storefront";
import { renderMarketplaceIndexMarkdown, marketplaceUrl } from "@/lib/marketplace/render-markdown";
import { resolvePlatformBranding } from "@/lib/branding/platform";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const catalog = await loadStorefrontCatalog();
  const brand = resolvePlatformBranding();
  const agents = brand.name === "SeldonFrame" ? catalog : catalog.filter((agent) => !agent.isSeed);
  const md = renderMarketplaceIndexMarkdown(agents, brand.appUrl, brand.name);

  return new Response(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      Link: `<${marketplaceUrl(brand.appUrl)}>; rel="alternate"; type="text/html"`,
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
