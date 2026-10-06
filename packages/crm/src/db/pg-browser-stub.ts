// Turbopack aliases `pg` to this file for BROWSER bundles only (next.config.ts).
// Some client components transitively import `@/db` (e.g. via the SMS provider
// chain), which now references node-postgres; the browser never opens a DB
// connection, so a throwing stub keeps node-only modules (net/tls/fs/dns) out
// of the client graph. Server bundles still resolve the real `pg`.
export class Pool {
  constructor() {
    throw new Error("pg is not available in the browser");
  }
}
