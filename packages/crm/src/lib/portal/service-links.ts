// EPIC 2026-10-04 -- "Your services" return links for the native customer portal.
//
// The native portal could show bookings, invoices, documents, messages and the account, but offered no way for staff to
// point a signed-in customer at where their service lives (here: the Personal Line app, which keeps its own sign-in).
// Stored on organizations.settings.portal.serviceLinks. https only; nothing else is ever rendered as a link.

export type ServiceLink = { label: string; url: string };

export const MAX_SERVICE_LINKS = 5;

export function parseServiceLinks(raw: unknown): ServiceLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceLink[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SERVICE_LINKS) break;
    if (!item || typeof item !== "object") continue;
    const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label.trim() : "";
    const url = typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url.trim() : "";
    if (label.length < 1 || label.length > 60 || url.length > 300) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    out.push({ label, url: parsed.toString() });
  }
  return out;
}

export function serviceLinksFromSettings(settings: unknown): ServiceLink[] {
  const portal = (settings as { portal?: { serviceLinks?: unknown } } | null | undefined)?.portal;
  return parseServiceLinks(portal?.serviceLinks);
}
