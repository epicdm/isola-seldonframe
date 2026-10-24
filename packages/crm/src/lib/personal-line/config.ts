// EPIC 2026-10-21 — Personal Line lifecycle ingress configuration (deployment-level, fail closed).
//
//   PL_LIFECYCLE_KEY_FILE      path of the Docker secret holding the HMAC key (>= 32 bytes, no whitespace; one trailing
//                              newline tolerated). The key value is read here and never logged.
//   PL_LIFECYCLE_KID           the key id the sender puts in X-PL-SF-Kid (1-16 lowercase letters/digits)
//   PL_LIFECYCLE_TENANT_ORGS   the EXPLICIT allowlist of plsvc tenant -> Uplink workspace, e.g.
//                              "epic=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8". Comma-separated for more. A malformed list,
//                              a duplicated tenant or a duplicated workspace makes the whole configuration invalid.
//
// Any of the three missing or invalid => the ingress answers 503 for every request (deployed dark until the secret
// and the allowlist are provisioned). Unknown tenants and workspaces not on the list are refused (403).
//
// DEVIATION from the 2026-10-11 slice (which kept the key per workspace in workspace_secrets behind a settings card):
// the 2026-10-21 brief provisions the key as a Docker secret and asks for an explicit tenant->workspace allowlist, so
// this ingress does not depend on the (undeployed) settings card. No secret is stored in the database.
import { readFileSync } from "node:fs";
import type { PlKey } from "./signing";

const KID = /^[a-z0-9]{1,16}$/;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LifecycleConfig = { key: PlKey; tenants: ReadonlyMap<string, string> };

export function validSigningKey(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 32 && !/\s/.test(value);
}

/** PURE. null = invalid (or empty); never a partial list. */
export function parseTenantOrgs(raw: string | undefined): Map<string, string> | null {
  if (!raw || !raw.trim()) return null;
  const out = new Map<string, string>();
  const orgs = new Set<string>();
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^([^=\s]+)=([^=\s]+)$/);
    if (!m) return null;
    const [, tenant, org] = m;
    if (!TENANT.test(tenant) || !UUID.test(org)) return null;
    if (out.has(tenant) || orgs.has(org)) return null;
    out.set(tenant, org);
    orgs.add(org);
  }
  return out.size > 0 ? out : null;
}

export function resolveLifecycleConfig(
  env: Record<string, string | undefined>,
  readKeyFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): LifecycleConfig | null {
  const file = env.PL_LIFECYCLE_KEY_FILE;
  const kid = env.PL_LIFECYCLE_KID;
  const tenants = parseTenantOrgs(env.PL_LIFECYCLE_TENANT_ORGS);
  if (!file || !kid || !KID.test(kid) || !tenants) return null;
  let key: string;
  try {
    key = readKeyFile(file).replace(/\r?\n$/, "");
  } catch {
    return null;
  }
  if (!validSigningKey(key)) return null;
  return { key: { kid, key }, tenants };
}
