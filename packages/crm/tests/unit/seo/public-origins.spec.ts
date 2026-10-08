import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  absolutePublicImageUrl,
  sitePublicOrigin,
  workspacePageMetadata,
  workspacePublicOrigin,
} from "../../../src/lib/seo/public-origins";

describe("public SEO origins", () => {
  test("preserves the upstream public-site default", () => {
    assert.equal(sitePublicOrigin({}), "https://www.seldonframe.com");
  });

  test("uses the configured branded app origin instead of a vendor fallback", () => {
    assert.equal(
      sitePublicOrigin({ PLATFORM_NAME: "Uplink", PLATFORM_APP_URL: "https://uplink.epic.dm" }),
      "https://uplink.epic.dm",
    );
  });

  test("an explicit public-site origin takes precedence", () => {
    assert.equal(
      sitePublicOrigin({
        PLATFORM_NAME: "Uplink",
        PLATFORM_APP_URL: "https://uplink.epic.dm",
        NEXT_PUBLIC_SITE_URL: "https://www.epic.dm/",
      }),
      "https://www.epic.dm",
    );
  });

  test("preserves the local HTTP site override for development", () => {
    assert.equal(sitePublicOrigin({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }), "http://localhost:3000");
  });

  test("builds workspace URLs from the configured base domain", () => {
    assert.equal(
      workspacePublicOrigin("pat-personal-line", { WORKSPACE_BASE_DOMAIN: "uplink.epic.dm" }),
      "https://pat-personal-line.uplink.epic.dm",
    );
    assert.throws(() => workspacePublicOrigin("bad/name", { WORKSPACE_BASE_DOMAIN: "uplink.epic.dm" }));
  });

  test("emits canonical, Open Graph and Twitter metadata at the workspace destination", () => {
    const metadata = workspacePageMetadata({
      slug: "pat-personal-line",
      title: "Personal Line",
      description: "A verified service overview.",
      image: "/media/preview.png",
      env: { WORKSPACE_BASE_DOMAIN: "uplink.epic.dm" },
    });

    assert.equal(metadata.alternates?.canonical, "https://pat-personal-line.uplink.epic.dm/");
    assert.deepEqual(metadata.openGraph, {
      title: "Personal Line",
      description: "A verified service overview.",
      url: "https://pat-personal-line.uplink.epic.dm/",
      type: "website",
      images: [{ url: "https://pat-personal-line.uplink.epic.dm/media/preview.png" }],
    });
    assert.deepEqual(metadata.twitter, {
      card: "summary_large_image",
      title: "Personal Line",
      description: "A verified service overview.",
      images: ["https://pat-personal-line.uplink.epic.dm/media/preview.png"],
    });
  });

  test("drops unsafe social image URLs and uses an honest summary card", () => {
    assert.equal(absolutePublicImageUrl("javascript:alert(1)", "https://client.uplink.epic.dm/"), null);
    assert.equal(absolutePublicImageUrl("http://client.example/image.png", "https://client.uplink.epic.dm/"), null);
    const metadata = workspacePageMetadata({
      slug: "client",
      title: "Client",
      image: "javascript:alert(1)",
      env: { WORKSPACE_BASE_DOMAIN: "uplink.epic.dm" },
    });
    assert.deepEqual(metadata.openGraph?.images, undefined);
    assert.equal((metadata.twitter as { card?: string } | null | undefined)?.card, "summary");
  });
});
