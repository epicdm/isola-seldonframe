import type { Metadata } from "next";
import { resolvePlatformBranding, resolveWorkspaceBaseDomain } from "@/lib/branding/platform";

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
