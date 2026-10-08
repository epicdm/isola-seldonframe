import type { Metadata } from "next";
import { resolvePlatformBranding, resolveWorkspaceBaseDomain } from "@/lib/branding/platform";
import { resolveWorkspaceSlugFromHostHeader } from "@/lib/workspace/host-to-slug";

type PublicOriginEnv = Record<string, string | undefined>;

function publicOrigin(value: string | undefined, allowLoopbackHttp = false): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const loopbackHttp = allowLoopbackHttp && url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function sitePublicOrigin(env: PublicOriginEnv = process.env): string {
  const explicit = publicOrigin(env.NEXT_PUBLIC_SITE_URL, true) ?? publicOrigin(env.PLATFORM_HOME_URL, true);
  if (explicit) return explicit;

  const brand = resolvePlatformBranding(env);
  if (brand.name !== "SeldonFrame") return publicOrigin(brand.appUrl, true) ?? "https://app.seldonframe.com";
  return "https://www.seldonframe.com";
}

export function workspacePublicOrigin(
  slug: string,
  env: PublicOriginEnv = process.env,
): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    throw new Error("Invalid workspace slug for public URL.");
  }
  const domain = resolveWorkspaceBaseDomain(env).replace(/^\.+|\.+$/g, "");
  const url = new URL(`https://${slug}.${domain}`);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new Error("Invalid workspace public domain configuration.");
  }
  return url.origin;
}

export function absolutePublicImageUrl(value: string | null | undefined, pageUrl: string): string | null {
  if (!value?.trim()) return null;
  try {
    const image = new URL(value.trim(), pageUrl);
    if (image.protocol !== "https:" || image.username || image.password) return null;
    return image.toString();
  } catch {
    return null;
  }
}

export function workspacePageMetadata(input: {
  slug: string;
  title: string;
  description?: string;
  image?: string | null;
  path?: string;
  env?: PublicOriginEnv;
}): Metadata {
  const origin = workspacePublicOrigin(input.slug, input.env);
  const path = input.path ? `/${input.path.replace(/^\/+/, "")}` : "/";
  const canonical = new URL(path, `${origin}/`).toString();
  const image = absolutePublicImageUrl(input.image, canonical);
  const description = input.description;

  return {
    ...(description ? { description } : {}),
    alternates: { canonical },
    openGraph: {
      title: input.title,
      ...(description ? { description } : {}),
      url: canonical,
      type: "website",
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: input.title,
      ...(description ? { description } : {}),
      ...(image ? { images: [image] } : {}),
    },
  };
}

/**
 * The public surface for the HOST a crawler addressed (branded deployments only; an unbranded SeldonFrame host keeps the
 * upstream behaviour). On a workspace host the surface is that workspace's own origin; anywhere else it is the platform origin.
 * Lane A (v4.43 acceptance): robots.txt / sitemap.xml used the platform app host for every request, which is restricted
 * for the public and lists vendor marketing URLs that are hidden on a branded deployment.
 */
export function brandedPublicSurface(
  hostHeader: string | null | undefined,
  env: PublicOriginEnv = process.env,
): { branded: boolean; workspaceSlug: string | null; origin: string } {
  const branded = resolvePlatformBranding(env).name !== "SeldonFrame";
  const workspaceSlug = branded ? resolveWorkspaceSlugFromHostHeader(hostHeader) : null;
  let origin = sitePublicOrigin(env);
  if (workspaceSlug) {
    try {
      origin = workspacePublicOrigin(workspaceSlug, env);
    } catch {
      // invalid slug: stay on the platform origin
    }
  }
  return { branded, workspaceSlug, origin };
}
