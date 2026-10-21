// Conversation-time MCP client (lib/agents/tools.ts defaultMcpDeps.makeClient).
// Same inline client as bind/refresh discovery, but it NEVER follows a
// redirect: a bound server that answers a tools/call with a 3xx toward an
// internal or attacker host gets a refusal, not a second request carrying the
// stored bearer. `baseFetch` is injectable for tests only.

import { createMcpClient, type McpClient } from "./client";
import { noRedirectFetch } from "./agent-connector-guard";

export function createRuntimeMcpClient(
  endpoint: string,
  bearer: string,
  baseFetch: typeof fetch = fetch,
): McpClient {
  return createMcpClient({ endpoint, bearer, fetchImpl: noRedirectFetch(baseFetch) });
}
