// WHO owns a number: the server-side association between a workspace and its WhatsApp business account and numbers.
//
// Security model (each point has a test):
//   - The association is held on the server, keyed by the workspace id that getOrgId() resolved from the signed-in session.
//     No request parameter, header or form field can name a number or an organization for this page.
//   - It is written only by EPIC staff (database, never a customer form). This module has no write path.
//   - One number belongs to exactly one workspace. If two workspaces claim the same number, BOTH are refused (fail
//     closed); the page shows a conflict and reads nothing from Meta or Magnus.
//   - Malformed entries are dropped, never repaired: an unparseable id cannot select anyone's number.
import type { LineLink } from "./types";

const DIGITS = /^\d{5,20}$/;

export function parseLinks(raw: unknown): LineLink[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: LineLink[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.wabaId !== "string" || typeof o.phoneNumberId !== "string") continue;
    if (!DIGITS.test(o.wabaId) || !DIGITS.test(o.phoneNumberId)) continue;
    if (seen.has(o.phoneNumberId)) continue;
    seen.add(o.phoneNumberId);
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
    out.push({ wabaId: o.wabaId, phoneNumberId: o.phoneNumberId, ...(label ? { label } : {}) });
  }
  return out;
}

export interface LinkStore {
  /** Links for exactly this workspace. */
  getLinks(orgId: string): Promise<LineLink[]>;
  /** Every workspace that claims this phone number (used to refuse double ownership). */
  claimants(phoneNumberId: string): Promise<string[]>;
}

/** Reads organizations.settings -> phoneWhatsapp.lines (a JSON array). Query functions are injected (drizzle in production). */
export class OrgSettingsLinkStore implements LinkStore {
  constructor(
    private readonly q: {
      readSettings(orgId: string): Promise<Record<string, unknown> | null>;
      findOrgsClaiming(phoneNumberId: string): Promise<string[]>;
    },
  ) {}

  async getLinks(orgId: string): Promise<LineLink[]> {
    const settings = await this.q.readSettings(orgId);
    const pw = settings?.phoneWhatsapp;
    return parseLinks(typeof pw === "object" && pw !== null ? (pw as { lines?: unknown }).lines : null);
  }

  claimants(phoneNumberId: string): Promise<string[]> {
    return this.q.findOrgsClaiming(phoneNumberId);
  }
}

/** Server-env map { "<orgId>": [ {wabaId, phoneNumberId, label?} ] }. Used for previews and staff-managed pilots. */
export class EnvLinkStore implements LinkStore {
  private readonly map = new Map<string, LineLink[]>();

  constructor(json: string | null | undefined) {
    if (!json) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return; // unparseable config = no links (fail closed)
    }
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [orgId, lines] of Object.entries(parsed as Record<string, unknown>)) this.map.set(orgId, parseLinks(lines));
  }

  async getLinks(orgId: string): Promise<LineLink[]> {
    return this.map.get(orgId) ?? [];
  }

  async claimants(phoneNumberId: string): Promise<string[]> {
    const out: string[] = [];
    for (const [orgId, links] of this.map) if (links.some((l) => l.phoneNumberId === phoneNumberId)) out.push(orgId);
    return out;
  }
}
