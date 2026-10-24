import { readFileSync } from "node:fs";
import { parseTenantOrgs } from "@/lib/personal-line/config";

export type PersonalLineCreditEvidence = {
  at: string;
  amountEc: number | null;
  currencyPaid: string | null;
  minutes: number | null;
  referenceKind: string | null;
  state: string | null;
};

export type PersonalLineServiceEvidence =
  | { status: "unavailable" | "not_linked" | "association_mismatch" }
  | {
      status: "verified";
      voice: { sipRegistered: boolean | null; magnusUserAssigned: boolean; createdAt: string };
      registration: { status: string | null; peerStatus: string | null; registeredAt: string | null };
      wallet: {
        status: string;
        balanceEc: number | null;
        currency: string | null;
        creditsStatus: string;
        credits: PersonalLineCreditEvidence[];
      };
      plan: { status: string; state: string | null; name: string | null; expiresAt: string | null };
    };

type BffReaderOptions = {
  baseUrl?: string;
  readTokenFile?: string;
  /** The single tenant key this BFF credential is authorized to serve. */
  tenantKey?: string;
  /** Injected only for tests; production reads the signed-ingress tenant map. */
  tenantOrgs?: ReadonlyMap<string, string> | null;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function projectCredits(value: unknown): PersonalLineCreditEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    if (!row || row.kind !== "credit" || !["credited", "marker_unverified"].includes(String(row.state))) return [];
    const at = text(row.at);
    if (!at) return [];
    return [{
      at,
      amountEc: finiteNumber(row.amountEc),
      currencyPaid: text(row.paymentCurrency),
      minutes: finiteNumber(row.minutes),
      referenceKind: text(row.referenceKind),
      state: text(row.state),
    }];
  });
}

function projectVerifiedDetail(detail: Record<string, unknown>, service: Record<string, unknown>): PersonalLineServiceEvidence {
  const registration = record(detail.registration);
  const wallet = record(detail.wallet);
  const allowance = record(wallet?.planAllowance);
  const plan = record(detail.plan);
  return {
    status: "verified",
    voice: {
      sipRegistered: typeof service.sipRegistered === "boolean" ? service.sipRegistered : null,
      magnusUserAssigned: service.magnusUserAssigned === true,
      createdAt: text(service.createdAt) ?? "",
    },
    registration: {
      status: text(registration?.status),
      peerStatus: text(registration?.peerStatus),
      registeredAt: text(registration?.registeredAt),
    },
    wallet: {
      status: text(wallet?.status) ?? "unknown",
      balanceEc: finiteNumber(wallet?.balanceEc),
      currency: text(wallet?.currency),
      creditsStatus: Array.isArray(wallet?.recentCredits) ? "ok" : text(wallet?.recentCreditsStatus) ?? "unavailable",
      credits: projectCredits(wallet?.recentCredits),
    },
    plan: {
      status: text(plan?.status) ?? "unknown",
      state: text(plan?.state),
      name: text(allowance?.planName) ?? text(plan?.planName),
      expiresAt: text(allowance?.expiresAt) ?? text(plan?.expiresAt),
    },
  };
}

/**
 * Read one signed lifecycle subject through the existing BFF contract.
 * The LiteAccount ID is an internal join key and is never returned. Before
 * surfacing detail, the BFF's Odoo customer-services association must contain
 * the same DID exactly once.
 */
export function createPersonalLineBffReader(options: BffReaderOptions = {}) {
  const baseUrl = (options.baseUrl ?? process.env.PERSONAL_LINE_BFF_URL)?.replace(/\/+$/, "");
  const tokenFile = options.readTokenFile ?? process.env.PERSONAL_LINE_READ_TOKEN_FILE;
  const tenantKey = options.tenantKey ?? process.env.PERSONAL_LINE_BFF_TENANT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  return async function read(orgId: string, accountId: string): Promise<PersonalLineServiceEvidence> {
    const tenantOrgs = options.tenantOrgs ?? parseTenantOrgs(process.env.PL_LIFECYCLE_TENANT_ORGS);
    const authorizedOrg = tenantKey ? tenantOrgs?.get(tenantKey) : null;
    // bff-v2's customer-360 integration is EPIC/Odoo-bound. Never use its
    // shared credential for another workspace merely because a signed event
    // supplied an account ID there. The tenant key -> workspace binding is
    // deployment configuration, not a user-supplied query parameter.
    if (!authorizedOrg || authorizedOrg.toLowerCase() !== orgId.toLowerCase()) return { status: "unavailable" };
    if (!baseUrl || !tokenFile || !/^[A-Za-z0-9_-]{8,128}$/.test(accountId)) return { status: "unavailable" };
    let token: string;
    try {
      token = readFile(tokenFile).trim();
    } catch {
      return { status: "unavailable" };
    }
    if (token.length < 32) return { status: "unavailable" };

    const headers = { "x-pl-operator-read-token": token };
    try {
      const detailResponse = await fetchImpl(
        `${baseUrl}/api/internal/personal-line/${encodeURIComponent(accountId)}/service-detail`,
        { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(8_000) },
      );
      if (!detailResponse.ok) return { status: "unavailable" };
      const detailBody = record(await detailResponse.json());
      if (!detailBody) return { status: "unavailable" };
      const account = record(detailBody?.account);
      if (!account) return { status: "unavailable" };
      const partnerId = account?.odooPartnerId;
      const intendedDid = text(account?.intendedDid);
      if (typeof partnerId !== "number" || !Number.isInteger(partnerId) || partnerId <= 0 || !intendedDid) return { status: "not_linked" };
      const did = digits(intendedDid);
      if (!/^[1-9]\d{6,14}$/.test(did)) return { status: "association_mismatch" };

      const servicesResponse = await fetchImpl(`${baseUrl}/api/internal/customer-360/services`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ odooPartnerId: partnerId }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!servicesResponse.ok) return { status: "unavailable" };
      const servicesBody = record(await servicesResponse.json());
      if (!Array.isArray(servicesBody?.services)) return { status: "unavailable" };
      const matches = servicesBody.services.filter((item) => {
        const candidate = record(item);
        return candidate && typeof candidate.did === "string" && digits(candidate.did) === did;
      });
      if (matches.length !== 1) return { status: "association_mismatch" };
      const service = record(matches[0]);
      if (!service || typeof service.magnusUserAssigned !== "boolean" || !text(service.createdAt)) {
        return { status: "unavailable" };
      }
      return projectVerifiedDetail(detailBody, service);
    } catch {
      return { status: "unavailable" };
    }
  };
}

export const readPersonalLineServiceEvidence = createPersonalLineBffReader();
