// EPIC 2026-10-21 (staff-access correction, Codex r2) — dependency-injection seams on exported server actions.
//
// Several exported "use server" actions accept an optional `deps` / `_deps` argument so unit tests can replace getOrgId,
// database reads and the like. A server action's arguments come from the CLIENT, and React accepts server-function
// references (and arbitrary data) as action arguments, so a client could have replaced getOrgId — the only role check on
// those actions — or flipped a data flag.
//
// Rule: an injected dependency is honoured only when there is NO request scope (a direct server-side call: unit tests,
// scripts). Every production invocation (action POST, page render, route handler) runs inside a request scope, where the
// injected value is discarded and the production defaults — including the role guard — are used. No production caller
// passes these arguments (they are all called from client components with input only).
//
// Not a "use server" module.

import { headers } from "next/headers";

export async function serverSideDeps<T>(deps: T | undefined): Promise<T | undefined> {
  if (deps === undefined || deps === null) return undefined;
  try {
    await headers();
  } catch (error) {
    // Honoured ONLY for Next's own "no request scope" error (next 16: throwForMissingRequestStore, code E251). Any other
    // failure is not proof that we are outside a request, so the injected value is ignored (fail closed).
    if (isOutsideRequestScopeError(error)) return deps; // a direct server-side caller (unit test, script)
    return undefined;
  }
  return undefined; // inside a request: whatever arrived here came through the action boundary — ignore it
}

export function isOutsideRequestScopeError(error: unknown): boolean {
  const code = (error as { __NEXT_ERROR_CODE?: unknown } | null)?.__NEXT_ERROR_CODE;
  const message = error instanceof Error ? error.message : "";
  return code === "E251" || /`headers` was called outside a request scope/.test(message);
}
