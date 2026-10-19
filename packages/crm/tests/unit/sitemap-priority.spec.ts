import { test } from "node:test";
import assert from "node:assert/strict";
import { rankUrlsForFaqRelevance } from "@/lib/soul-compiler/sitemap-priority";
import * as sitemapModule from "../../src/app/sitemap";

const buildSitemap = (
  sitemapModule as unknown as {
    default: () => Promise<Array<{ url: string | URL }> >;
  }
).default;

function makeMockClient(response: string) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: response }],
      }),
    },
  };
}

type TestClient = NonNullable<Parameters<typeof rankUrlsForFaqRelevance>[0]["_testClient"]>;

function asTestClient(response: string): TestClient {
  return makeMockClient(response) as unknown as TestClient;
}

test("sitemap-priority: returns ranked URLs from Claude response", async () => {
  const mockResponse = JSON.stringify([
    { url: "https://example.com/faq", reason: "Explicit FAQ slug", confidence: 0.95 },
    { url: "https://example.com/services", reason: "May contain inline Q&A", confidence: 0.5 },
  ]);

  const result = await rankUrlsForFaqRelevance({
    domain: "example.com",
    apiKey: "sk-test",
    _testUrls: ["https://example.com/faq", "https://example.com/services", "https://example.com/blog/post-1"],
    _testClient: asTestClient(mockResponse),
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://example.com/faq");
  assert.equal(result[0].confidence, 0.95);
});

test("sitemap-priority: rejects hallucinated URLs not in input", async () => {
  const mockResponse = JSON.stringify([
    { url: "https://example.com/faq", reason: "FAQ", confidence: 0.9 },
    { url: "https://hallucinated.com/faq", reason: "FAQ", confidence: 0.9 },
  ]);

  const result = await rankUrlsForFaqRelevance({
    domain: "example.com",
    apiKey: "sk-test",
    _testUrls: ["https://example.com/faq"],
    _testClient: asTestClient(mockResponse),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://example.com/faq");
});

test("sitemap-priority: respects limit parameter", async () => {
  const mockResponse = JSON.stringify([
    { url: "https://example.com/faq", reason: "FAQ", confidence: 0.9 },
    { url: "https://example.com/services", reason: "S", confidence: 0.7 },
    { url: "https://example.com/about", reason: "A", confidence: 0.5 },
  ]);

  const result = await rankUrlsForFaqRelevance({
    domain: "example.com",
    apiKey: "sk-test",
    limit: 2,
    _testUrls: [
      "https://example.com/faq",
      "https://example.com/services",
      "https://example.com/about",
    ],
    _testClient: asTestClient(mockResponse),
  });

  assert.equal(result.length, 2);
});

test("sitemap-priority: empty URL list returns empty result", async () => {
  const result = await rankUrlsForFaqRelevance({
    domain: "example.com",
    apiKey: "sk-test",
    _testUrls: [],
    _testClient: asTestClient("[]"),
  });

  assert.deepEqual(result, []);
});

test("sitemap-priority: malformed JSON falls back to top URLs", async () => {
  const result = await rankUrlsForFaqRelevance({
    domain: "example.com",
    apiKey: "sk-test",
    _testUrls: ["https://example.com/faq", "https://example.com/services"],
    _testClient: asTestClient("not json"),
  });

  // Fallback: return the input URLs with confidence 0.5
  assert.equal(result.length, 2);
  assert.equal(result[0].confidence, 0.5);
});

test("canonical AI front office guides are included in the guide sitemap", async () => {
  // This asserts the UPSTREAM (unbranded) sitemap. A branded deployment deliberately lists only its workspace home (v4.43), so
  // pin an unbranded environment for this assertion regardless of the build's baked PLATFORM_* values.
  const saved = { name: process.env.PLATFORM_NAME, home: process.env.PLATFORM_HOME_URL, site: process.env.NEXT_PUBLIC_SITE_URL, app: process.env.PLATFORM_APP_URL };
  process.env.PLATFORM_NAME = "SeldonFrame"; delete process.env.PLATFORM_HOME_URL; delete process.env.NEXT_PUBLIC_SITE_URL; delete process.env.PLATFORM_APP_URL;
  let entries: Array<{ url: string | URL }>;
  try {
    entries = await buildSitemap();
  } finally {
    for (const [key, value] of [["PLATFORM_NAME", saved.name], ["PLATFORM_HOME_URL", saved.home], ["NEXT_PUBLIC_SITE_URL", saved.site], ["PLATFORM_APP_URL", saved.app]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const urls = new Set(entries.map((entry) => String(entry.url)));

  for (const slug of [
    "what-is-an-ai-front-office",
    "ai-front-office-examples",
    "ai-front-office-software-for-agencies",
  ]) {
    assert.ok(urls.has(`https://www.seldonframe.com/guides/${slug}`), `missing sitemap URL: ${slug}`);
  }
});
