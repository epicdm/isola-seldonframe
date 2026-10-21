// EPIC 2026-10-21 (Codex r3): serverSideDeps against the REAL next/headers (no mock). Outside a request scope Next 16 throws
// its own "outside a request scope" error (E251), and only that error lets injected deps through; any other error does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headers } from "next/headers";
import { isOutsideRequestScopeError, serverSideDeps } from "../../../src/lib/auth/server-side-deps";

describe("serverSideDeps (real next/headers)", () => {
  test("instrument: the real headers() outside a request throws Next's own request-scope error", async () => {
    let caught: unknown = null;
    try { await headers(); } catch (e) { caught = e; }
    assert.ok(caught, "headers() must throw outside a request");
    assert.equal(isOutsideRequestScopeError(caught), true, `unexpected error: ${String(caught)}`);
  });
  test("outside a request, injected deps are honoured (unit tests keep their seams)", async () => {
    const deps = { getOrgId: async () => "x" };
    assert.equal(await serverSideDeps(deps), deps);
    assert.equal(await serverSideDeps(undefined), undefined);
  });
  test("control: an unrelated error is NOT treated as outside-a-request", () => {
    assert.equal(isOutsideRequestScopeError(new Error("boom")), false);
    assert.equal(isOutsideRequestScopeError(null), false);
  });
});
