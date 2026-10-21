// Chatwoot customer link: a READ-ONLY Chatwoot client. GET requests only; there is no write method on this interface.
// Shapes follow Chatwoot v4.18 (read from the running image's source 2026-10-21):
//  * GET /api/v1/accounts/:account/contacts/search?q=&page=  ContactsController#search: name/email/phone_number ILIKE %q%, 15 per page;
//    { meta: { count, current_page, has_more }, payload: [...] }. Pages are followed up to a budget; a lookup that hit the budget with more
//    pages left reports itself INCOMPLETE rather than passing for "all matches" (Codex review 2026-10-21).
//  * GET /api/v1/accounts/:account/contacts/:id/conversations  Contacts::ConversationsController#index: newest 25, filtered by the token
//    user's inbox permissions (PermissionFilterService); { payload: [...] }
//  * a conversation's API "id" is its display_id (_conversation.json.jbuilder: json.id conversation.display_id), which is the number in
//    the dashboard route accounts/:accountId/conversations/:conversation_id.
// Nothing here logs the token, a phone number, an email or message content.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ChatwootContact = { id: number; name: string | null; phone: string | null; email: string | null };
export type ChatwootConversation = { displayId: number; inboxId: number | null; status: string | null; lastActivityAt: number | null };

export type ChatwootSearchResult = { contacts: ChatwootContact[]; complete: boolean };

export const SEARCH_PAGE_SIZE = 15; // Chatwoot v4.18 ContactsController::RESULTS_PER_PAGE
export const SEARCH_MAX_PAGES = 5;

export interface ChatwootReader {
  searchContacts(q: string): Promise<ChatwootSearchResult>;
  contactConversations(contactId: number): Promise<ChatwootConversation[]>;
}

export class ChatwootReadError extends Error {
  constructor(public readonly status: number, label: string) {
    super(`chatwoot ${label} failed (${status})`);
    this.name = "ChatwootReadError";
  }
}

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const optStr = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function makeChatwootReader(opts: { apiBase: string; accountId: string; apiToken: string; fetch?: Fetch; timeoutMs?: number }): ChatwootReader {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeout = opts.timeoutMs ?? 5_000;
  const root = `${opts.apiBase.replace(/\/+$/, "")}/api/v1/accounts/${encodeURIComponent(opts.accountId)}`;
  const accountNum = Number(opts.accountId);

  async function get(label: string, path: string): Promise<{ payload: unknown[]; meta: Record<string, unknown> }> {
    const res = await f(`${root}${path}`, {
      method: "GET",
      headers: { api_access_token: opts.apiToken, Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
      redirect: "manual", // a 3xx is !ok and throws: a body served from anywhere but the configured endpoint is never read
      cache: "no-store",
    });
    if (!res.ok || res.redirected) throw new ChatwootReadError(res.ok ? 502 : res.status, label);
    const j = (await res.json().catch(() => null)) as { payload?: unknown; meta?: unknown } | null;
    if (!j || typeof j !== "object" || !Array.isArray(j.payload)) throw new ChatwootReadError(502, label);
    const meta = j.meta && typeof j.meta === "object" && !Array.isArray(j.meta) ? (j.meta as Record<string, unknown>) : {};
    return { payload: j.payload, meta };
  }

  return {
    async searchContacts(q) {
      const query = q.trim();
      if (!query) return { contacts: [], complete: true };
      const out: ChatwootContact[] = [];
      const seen = new Set<number>();
      for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        const { payload, meta } = await get("contact search", `/contacts/search?q=${encodeURIComponent(query)}&page=${page}`);
        for (const r of payload as Array<Record<string, unknown>>) {
          const id = posInt(r?.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({ id, name: optStr(r.name), phone: optStr(r.phone_number, 40), email: optStr(r.email) });
        }
        // has_more is v4.18's own answer. Without it, a full page is read as "maybe more" (never as complete).
        const more = meta.has_more === true || (meta.has_more === undefined && payload.length >= SEARCH_PAGE_SIZE);
        if (!more) return { contacts: out, complete: true };
        if (payload.length === 0) break; // "more" with an empty page: inconsistent, stop and report incomplete
      }
      return { contacts: out, complete: false };
    },

    async contactConversations(contactId) {
      if (!posInt(contactId)) throw new ChatwootReadError(400, "contact conversations");
      const { payload: rows } = await get("contact conversations", `/contacts/${contactId}/conversations`);
      const out: ChatwootConversation[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const displayId = posInt(r?.id);
        if (!displayId) continue;
        // A conversation that says it belongs to another account is never offered (defence in depth: the path already names the account).
        if (r.account_id !== undefined && r.account_id !== accountNum) continue;
        out.push({
          displayId,
          inboxId: posInt(r.inbox_id),
          status: optStr(r.status, 20),
          lastActivityAt: typeof r.last_activity_at === "number" && Number.isFinite(r.last_activity_at) ? r.last_activity_at : null,
        });
      }
      return out;
    },
  };
}
