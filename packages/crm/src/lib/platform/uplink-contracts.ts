export type UplinkFixtureOffer = "personal-line" | "business-front-office" | "agency-parent" | "agency-child";

export const UPLINK_FIXTURE_WORKSPACES: ReadonlyArray<{ offer: UplinkFixtureOffer; slug: string }> = [
  { offer: "personal-line", slug: "uplink-demo-personal-line" },
  { offer: "business-front-office", slug: "uplink-demo-business" },
  { offer: "agency-parent", slug: "uplink-demo-agency" },
  { offer: "agency-child", slug: "uplink-demo-agency-client" },
];

export function assertUplinkFixtureTarget(env: Record<string, string | undefined>): void {
  if (env.UPLINK_FIXTURES !== "enabled") {
    throw new Error("Set UPLINK_FIXTURES=enabled to create synthetic Uplink fixtures");
  }
  if (env.DB_DRIVER?.trim().toLowerCase() !== "pg") {
    throw new Error("DB_DRIVER=pg is required for transaction-based Uplink fixture seeding");
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  let databaseHost: string;
  try {
    databaseHost = new URL(env.DATABASE_URL).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  const appHost = (() => {
    try {
      return new URL(env.PLATFORM_APP_URL ?? "").hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (env.NODE_ENV === "production") {
    if (
      env.UPLINK_FIXTURE_TARGET !== "staging" ||
      appHost !== "build.uplink.epic.dm" ||
      databaseHost !== "uplink-db"
    ) {
      throw new Error("Production-mode fixtures are restricted to the isolated Uplink staging target");
    }
    return;
  }

  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!loopback.has(databaseHost) || (appHost && !loopback.has(appHost))) {
    throw new Error("Non-production fixtures may only target a loopback PostgreSQL database");
  }
}

export type AdapterKind = "chatwoot" | "epicVoice";

export interface ChatwootAdapterContract {
  handoff(input: {
    workspaceId: string;
    conversationId: string;
    reason: string;
  }): Promise<{ conversationId: string; assignedTeamId: string }>;
  handback(input: { workspaceId: string; conversationId: string }): Promise<void>;
}

export interface EpicVoiceAdapterContract {
  resolveDid(input: { workspaceId: string; did: string }): Promise<{ routeId: string }>;
  provisionDid(input: { workspaceId: string; did: string }): Promise<{ status: "staged" }>;
  publishCallEvent(input: {
    workspaceId: string;
    callId: string;
    disposition: string;
  }): Promise<void>;
}

export class UplinkAdapterUnavailableError extends Error {
  constructor(kind: AdapterKind, reason: "disabled" | "not_implemented") {
    super(`Uplink ${kind} adapter is ${reason}`);
    this.name = "UplinkAdapterUnavailableError";
  }
}

export function adapterRequested(kind: AdapterKind, env: Record<string, string | undefined> = process.env) {
  const key = kind === "chatwoot" ? "UPLINK_CHATWOOT_ENABLED" : "UPLINK_EPIC_VOICE_ENABLED";
  return env[key]?.trim().toLowerCase() === "true";
}

export function assertAdapterAvailable(kind: AdapterKind, env: Record<string, string | undefined> = process.env): never {
  throw new UplinkAdapterUnavailableError(kind, adapterRequested(kind, env) ? "not_implemented" : "disabled");
}
