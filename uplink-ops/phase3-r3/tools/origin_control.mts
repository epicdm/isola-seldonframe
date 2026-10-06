// Origin control against the REAL Codex source (r3.1). Offline; reads two local files; no network, no secrets.
// usage: node --experimental-strip-types tools/origin_control.mts <path-to-app-hosts.ts> <path-to-uplink-app.env.template> [origin]
// Loads packages/crm/src/lib/http/app-hosts.ts from a checkout of isola/pooled-postgres (or the final release head) and checks that the env template,
// with the canonical placeholder substituted, is accepted by canonicalAppOrigin(), and that the r3 split values are rejected (the positive/negative pair).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [src, tpl, originArg] = process.argv.slice(2);
if (!src || !tpl) { console.log("usage: origin_control.mts <app-hosts.ts> <env.template> [origin]"); process.exit(2); }
const origin = originArg ?? "https://build.uplink.epic.dm";
const mod = await import(pathToFileURL(resolve(src)).href);
let fails = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " [" + detail + "]" : "")); if (!ok) fails++; };

const env: Record<string, string> = {};
for (const line of readFileSync(tpl, "utf8").split("\n")) {
  if (!line.trim() || line.trim().startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  const k = line.slice(0, i), v = line.slice(i + 1).replace("{{CANONICAL_APP_ORIGIN}}", origin);
  if (!v.includes("{{")) env[k] = v;   // other placeholders (owner secrets, Codex keys) are not part of the origin question
}
let got = "";
try { got = mod.canonicalAppOrigin(env); } catch (e) { got = "THROWS " + (e as Error).message; }
check("template (placeholder = " + origin + ") is accepted by canonicalAppOrigin and yields that origin", got === origin, got);
let split = "";
try { split = mod.canonicalAppOrigin({ ...env, NEXT_PUBLIC_APP_URL: "https://uplink.epic.dm", AUTH_URL: "https://build.uplink.epic.dm", NEXTAUTH_URL: "https://build.uplink.epic.dm", PLATFORM_APP_URL: "https://build.uplink.epic.dm" }); } catch (e) { split = "THROWS"; }
check("negative control: the r3 split origins are rejected by the same function", split === "THROWS", split);
let none = "";
try { none = mod.canonicalAppOrigin({}); } catch (e) { none = "THROWS"; }
check("control: an empty environment falls back to the vendor origin (so an unset origin key is not silently accepted by this template check)", none.includes("seldonframe"), none);
console.log("SUMMARY origin controls failed=" + fails);
process.exit(fails ? 1 : 0);
