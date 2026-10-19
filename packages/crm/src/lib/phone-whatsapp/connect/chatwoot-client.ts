// Chatwoot application API, the minimum the coexistence path needs. Server-only. Shapes follow Chatwoot v4.18 (read from the running image's
// source 2026-10-19): inboxes#create (channel type "whatsapp", provider "whatsapp_cloud"), contacts#create/search, contact_inboxes#create
// (ContactInboxBuilder returns an existing row), conversations#create, conversations/messages#create (MessageBuilder passes source_id through).
//
// Two Chatwoot facts this file depends on, both read from source:
//  * provider_config.source = "manual_setup_v2" makes Chatwoot SKIP its own after-create webhook setup (Channel::Whatsapp
//    should_auto_setup_webhooks?). Without it Chatwoot would subscribe the WABA itself and point the phone override at its own URL, replacing
//    ours, and (for a number Meta did not report as on the Business app) could call /register. We set the override ourselves.
//  * Chatwoot refuses API-created INCOMING messages outside API inboxes (MessageBuilder#message_type: "Incoming messages are only allowed in
//    Api inboxes"), so imported history is written as PRIVATE NOTES, one per historical message, labelled with who sent it and when. A
//    private note is never sent to WhatsApp (Base::SendOnChannelService#invalid_message?), never wakes an agent bot, and does not open a
//    24-hour reply window on an old contact, which a re-played inbound message would.
// The customer's business token is passed to Chatwoot as provider_config.api_key: Chatwoot needs it to send the replies its agents write.
// Nothing here logs a token or message content.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ChatwootError extends Error {
  constructor(public readonly status: number, label: string) {
    super(`chatwoot ${label} failed (${status})`);
    this.name = "ChatwootError";
  }
}

export interface ChatwootPort {
  ensureWhatsappInbox(a: { name: string; phoneE164: string; phoneNumberId: string; wabaId: string; businessToken: string }): Promise<{ inboxId: number; created: boolean }>;
  /** Find by phone, else create (with the WhatsApp contact inbox). Name is only used on create. */
  ensureContact(a: { inboxId: number; phoneDigits: string; name?: string }): Promise<{ contactId: number; created: boolean }>;
  /** Latest conversation of this contact in this inbox, else a new RESOLVED one (history is a record, not a live conversation). */
  ensureConversation(a: { inboxId: number; contactId: number; phoneDigits: string }): Promise<number>;
  /** A private note (never sent to WhatsApp). */
  createNote(a: { conversationId: number; content: string; sourceId: string }): Promise<void>;
  /** True when an agent bot is attached to the inbox (active or not). Throws on any failure or unexpected shape: callers fail closed. */
  inboxBotAttached(inboxId: number): Promise<boolean>;
}

export function makeChatwootClient(opts: { base: string; accountId: string; apiToken: string; fetch?: Fetch; timeoutMs?: number }): ChatwootPort {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeout = opts.timeoutMs ?? 10_000;
  const root = `${opts.base.replace(/\/+$/, "")}/api/v1/accounts/${encodeURIComponent(opts.accountId)}`;

  async function call(label: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await f(`${root}${path}`, {
      method,
      headers: { api_access_token: opts.apiToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new ChatwootError(res.status, label);
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | unknown[] | null;
    if (!j || typeof j !== "object") throw new ChatwootError(502, label);
    return (Array.isArray(j) ? { payload: j } : j) as Record<string, unknown>;
  }
  const list = (j: Record<string, unknown>): Array<Record<string, unknown>> => {
    const p = j.payload ?? j.data;
    if (Array.isArray(p)) return p as Array<Record<string, unknown>>;
    const inner = (p as { payload?: unknown } | undefined)?.payload;
    return Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : [];
  };
  const idOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

  return {
    async ensureWhatsappInbox(a) {
      const existing = list(await call("inbox list", "GET", "/inboxes")).find((i) => i.channel_type === "Channel::Whatsapp" && i.phone_number === a.phoneE164);
      if (existing) {
        const pc = (existing.provider_config ?? {}) as Record<string, unknown>;
        // A Chatwoot inbox for this phone that is bound to a DIFFERENT Meta phone id is a conflict we never overwrite.
        if (pc.phone_number_id !== undefined && String(pc.phone_number_id) !== a.phoneNumberId) throw new ChatwootError(409, "inbox conflict");
        const id = idOf(existing.id);
        if (!id) throw new ChatwootError(502, "inbox list");
        return { inboxId: id, created: false };
      }
      const j = await call("inbox create", "POST", "/inboxes", {
        name: a.name.slice(0, 60),
        channel: {
          type: "whatsapp",
          phone_number: a.phoneE164,
          provider: "whatsapp_cloud",
          provider_config: { api_key: a.businessToken, phone_number_id: a.phoneNumberId, business_account_id: a.wabaId, source: "manual_setup_v2" },
        },
      });
      const id = idOf(j.id) ?? idOf((j.payload as { id?: unknown } | undefined)?.id);
      if (!id) throw new ChatwootError(502, "inbox create");
      return { inboxId: id, created: true };
    },

    async ensureContact(a) {
      const e164 = `+${a.phoneDigits}`;
      const found = list(await call("contact search", "GET", `/contacts/search?q=${encodeURIComponent(e164)}`)).find((c) => c.phone_number === e164);
      if (found && idOf(found.id)) {
        const contactId = idOf(found.id)!;
        await call("contact inbox", "POST", `/contacts/${contactId}/contact_inboxes`, { inbox_id: a.inboxId, source_id: a.phoneDigits });
        return { contactId, created: false };
      }
      const j = await call("contact create", "POST", "/contacts", { inbox_id: a.inboxId, phone_number: e164, ...(a.name ? { name: a.name.slice(0, 120) } : {}) });
      const p = (j.payload ?? {}) as { contact?: { id?: unknown }; id?: unknown };
      const contactId = idOf(p.contact?.id) ?? idOf(p.id) ?? idOf(j.id);
      if (!contactId) throw new ChatwootError(502, "contact create");
      return { contactId, created: true };
    },

    async ensureConversation(a) {
      const convs = list(await call("contact conversations", "GET", `/contacts/${a.contactId}/conversations`)).filter((c) => c.inbox_id === a.inboxId);
      const latest = convs.map((c) => idOf(c.id)).filter((x): x is number => x !== null).sort((x, y) => y - x)[0];
      if (latest) return latest;
      const j = await call("conversation create", "POST", "/conversations", { inbox_id: a.inboxId, contact_id: a.contactId, source_id: a.phoneDigits, status: "resolved" });
      const id = idOf(j.id);
      if (!id) throw new ChatwootError(502, "conversation create");
      return id;
    },

    async createNote(a) {
      await call("note create", "POST", `/conversations/${a.conversationId}/messages`, {
        content: a.content,
        message_type: "outgoing",
        private: true,
        source_id: a.sourceId,
      });
    },

    async inboxBotAttached(inboxId) {
      // GET inboxes/:id/agent_bot (Chatwoot v4.18 InboxesController#agent_bot = @inbox.agent_bot, through agent_bot_inbox, active OR inactive;
      // view: { agent_bot: {...} } or { agent_bot: {} }). For an administrator token the bot object carries its access_token and secret: only
      // the id is read here, nothing else is kept, returned or logged. Anything that is not clearly 'none' or clearly 'a bot' throws.
      if (!idOf(inboxId)) throw new ChatwootError(400, "inbox agent bot");
      const j = await call("inbox agent bot", "GET", `/inboxes/${inboxId}/agent_bot`);
      if (!Object.prototype.hasOwnProperty.call(j, "agent_bot")) throw new ChatwootError(502, "inbox agent bot");
      const bot = j.agent_bot;
      if (bot === null) return false;
      if (typeof bot !== "object" || Array.isArray(bot)) throw new ChatwootError(502, "inbox agent bot");
      if (Object.keys(bot as object).length === 0) return false;
      if (idOf((bot as { id?: unknown }).id)) return true;
      throw new ChatwootError(502, "inbox agent bot"); // non-empty without an id: ambiguous, never read as 'no bot'
    },
  };
}
