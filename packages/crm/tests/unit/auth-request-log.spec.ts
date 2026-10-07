import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { logAuthRequestPath } from "@/lib/auth/request-log";

describe("authentication route logging", () => {
  test("verification-token callback logs only method and path", () => {
    const entries: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => entries.push(args);
    try {
      const callback = new URL("https://uplink.epic.dm/api/auth/callback/email?token=verification-secret&tokenHash=stored-hash&email=owner%40epic.dm");
      logAuthRequestPath("GET", { nextUrl: callback });
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(entries, [["[auth][route] GET", "/api/auth/callback/email"]]);
    assert.equal(JSON.stringify(entries).includes("verification-secret"), false);
    assert.equal(JSON.stringify(entries).includes("stored-hash"), false);
    assert.equal(JSON.stringify(entries).includes("owner@epic.dm"), false);

    const route = readFileSync(path.resolve(__dirname, "../../src/app/api/auth/[...nextauth]/route.ts"), "utf8");
    assert.match(route, /logAuthRequestPath\("GET", req\)/);
    assert.doesNotMatch(route, /Object\.fromEntries\(req\.nextUrl\.searchParams\)/);
    assert.doesNotMatch(route, /headers\?\.get\?\.\("location"\)/);
  });
});
