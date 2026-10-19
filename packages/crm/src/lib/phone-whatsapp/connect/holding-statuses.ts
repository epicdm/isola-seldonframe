// Statuses under which a workspace HOLDS a number (one number, one workspace). The single list used by every store that answers "who holds
// this number" (Law 21: connect/server-wiring.ts claimants() and service/stores.ts claimantsOf()). 'failed' releases the number; a
// 'disconnected' coexistence number stays held until EPIC reviews it.
export const HOLDING_STATUSES = ["pending", "registering", "registered", "active", "coex_linking", "connected_coexistence", "disconnected"] as const;
