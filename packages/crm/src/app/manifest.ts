import type { MetadataRoute } from "next";
import { generatePwaManifest } from "@seldonframe/core/virality";
import { resolvePlatformBranding } from "@/lib/branding/platform";

export default function manifest(): MetadataRoute.Manifest {
  const branding = resolvePlatformBranding();
  const base = generatePwaManifest({
    name: `${branding.name} CRM`,
    shortName: branding.name,
    description: `${branding.name} workspace`,
    startUrl: "/hub",
    themeColor: "#0a0e14",
    backgroundColor: "#0a0e14",
    icons: branding.name === "SeldonFrame"
      ? [{ src: "/logo.svg", sizes: "any", type: "image/svg+xml" }]
      : branding.faviconUrl
        ? [{ src: branding.faviconUrl, sizes: "any", type: "image/svg+xml" }]
        : [],
  }) as MetadataRoute.Manifest;

  return {
    ...base,
    // Web Share Target (record-to-agent mobile-P3): lets Android's native
    // Share sheet send a screen recording straight into /record instead of
    // the operator hunting the file down in their Files app. MetadataRoute
    // .Manifest doesn't type `share_target` — cast through `unknown` so
    // this stays a plain object literal Next serializes as-is.
    share_target: {
      action: "/record/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [
          {
            name: "recording",
            accept: ["video/mp4", "video/quicktime", "video/webm"],
          },
        ],
      },
    },
  } as unknown as MetadataRoute.Manifest;
}
