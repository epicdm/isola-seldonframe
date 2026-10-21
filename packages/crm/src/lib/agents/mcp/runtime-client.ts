// Conversation-time MCP client (lib/agents/tools.ts defaultMcpDeps.makeClient).
// Same inline client as bind/refresh discovery, with two extra rules on EVERY
// request it sends:
//   - the URL is re-validated as public https (assertPublicHttpUrl) before the
//     request leaves — a binding whose host now resolves inside (DNS changed
//     since bind, or a stored legacy binding) is refused, not called;
//   - redirects are never followed — a 3xx toward an internal or attacker host
//     gets a refusal, not a second request carrying the stored bearer.
// `baseFetch` / `resolve` are injectable for tests only. The vetted IP is still
// not pinned to the socket (DNS-rebinding TOCTOU — see agent-connector-guard).

import { createMcpClient, type McpClient } from "./client";
import { AgentConnectorError, noRedirectFetch } from "./agent-connector-guard";
import { assertPublicHttpUrl, type DnsResolver } from "@/lib/security/ssrf-guard";

/** A fetch that re-checks every request URL is public https before sending. */
export function publicOnlyFetch(base: typeof fetch = fetch, resolve?: DnsResolver): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let ok = false;
    try {
      ok = new URL(raw).protocol === "https:";
      if (ok) await assertPublicHttpUrl(raw, resolve ? { resolve } : {});
    } catch {
      ok = false;
    }
    if (!ok) throw new AgentConnectorError("endpoint_not_allowed");
    return base(input, init);
  }) as typeof fetch;
}

export function createRuntimeMcpClient(
  endpoint: string,
  bearer: string,
  baseFetch: typeof fetch = fetch,
  resolve?: DnsResolver,
): McpClient {
  return createMcpClient({ endpoint, bearer, fetchImpl: noRedirectFetch(publicOnlyFetch(baseFetch, resolve)) });
}
