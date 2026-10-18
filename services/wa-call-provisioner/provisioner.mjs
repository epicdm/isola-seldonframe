// The provisioner core: FOUR idempotent operations, nothing else. There is no billing operation and no delete/update operation in this module or its port.
//
// Duplicate prevention is not "look up, then insert". It is, in order:
//   1. an idempotency record per key (a finished key always returns its stored result);
//   2. a per-resource lease with a fencing token: only one holder works on a DID number / a DID's destinations at a time, across requests, processes and restarts;
//   3. lookup under the lease, then write ONLY if the lease still has more time left than the upstream call can take (a stalled holder whose lease ran out
//      refuses to write instead of racing the next holder);
//   4. after ANY upstream error the result is reconciled by looking again (the write may have happened and the answer been lost): found = success, absent = not done;
//   5. after a destination write the rows are counted: more than one identical row is reported needs_review, never "fixed" by deleting;
//   6. on start, every operation left in a non-final state is reconciled before new work is accepted.
// The upstream (the voice platform) is behind `port`; production wiring of that port is a separate, unapproved step.
export class ProvisionerError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

// allowWrites:false = VERIFY-ONLY mode (first live slice): staff create the records in the platform's own admin UI; the provisioner only finds and reads them back.
export function makeProvisioner({ store, port, now = () => Date.now(), leaseMs = 30_000, callTimeoutMs = 5_000, marginMs = 1_000, owner = `p-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, hooks = {}, allowWrites = true }) {
  const need = callTimeoutMs + marginMs;

  async function withLease(resource, fn) {
    const lease = store.acquire(resource, owner, now(), leaseMs);
    if (!lease) throw new ProvisionerError("busy", "another request holds this resource");
    try { return await fn(lease); } finally { store.release(resource, lease.token); }
  }
  const guardWrite = (resource, lease) => {
    if (!allowWrites) throw new ProvisionerError("staff_action_required", "verify-only mode: the record must be created by staff first");
    if (!store.stillHolds(resource, lease.token, now(), need)) throw new ProvisionerError("lease_expired", "lease no longer held with enough time left; not writing");
  };

  /** Runs `body` once per key. A finished key returns its stored result; an unfinished one is re-run (bodies are reconciling, so re-running is safe). */
  async function once(key, step, body) {
    const op = store.claimOp(key, step, now());
    if (op.state === "done") return { ...JSON.parse(op.result), created: false, replay: true };
    if (op.state === "needs_review") throw new ProvisionerError("needs_review", "a previous attempt needs review");
    store.setOp(key, "writing", null, null, now());
    try {
      const r = await body();
      store.setOp(key, "done", { ref: r.ref }, null, now());
      return r;
    } catch (e) {
      // "busy" means somebody else is doing this work: it must not disturb that holder's record. A finished record is never downgraded.
      if (!(e instanceof ProvisionerError && e.code === "busy") && store.getOp(key)?.state !== "done") {
        const state = e instanceof ProvisionerError && e.code === "needs_review" ? "needs_review" : "unknown";
        store.setOp(key, state, null, e.code ?? e.name ?? "error", now());
      }
      throw e;
    }
  }

  return {
    owner,
    async ensureServiceAccount({ key, workspaceId }) {
      return once(key, "service_account", () => withLease(`acct:${workspaceId}`, async (lease) => {
        const found = await port.findAccount(workspaceId);
        if (found) return { ref: found.ref, created: false };
        guardWrite(`acct:${workspaceId}`, lease);
        try { const c = await port.createAccount(workspaceId); await hooks.afterUpstreamWrite?.("account"); return { ref: c.ref, created: true }; }
        catch (e) { const again = await port.findAccount(workspaceId); if (again) return { ref: again.ref, created: true }; throw e; }
      }));
    },

    async ensureDid({ key, accountRef, number }) {
      return once(key, "did", () => withLease(`did:${number}`, async (lease) => {
        const found = await port.findDid(number);
        if (found) {
          if (found.accountRef !== accountRef) throw new ProvisionerError("did_owned_elsewhere", "that number already belongs to another account");
          return { ref: found.ref, created: false };
        }
        guardWrite(`did:${number}`, lease);
        try { const c = await port.createDid({ number, accountRef, tag: key }); await hooks.afterUpstreamWrite?.("did"); return { ref: c.ref, created: true }; }
        catch (e) {
          const again = await port.findDid(number); // duplicate-number refusals and lost answers both land here
          if (again && again.accountRef === accountRef) return { ref: again.ref, created: true };
          throw e;
        }
      }));
    },

    async ensureDestination({ key, didRef, target }) {
      return once(key, "destination", () => withLease(`dest:${didRef}`, async (lease) => {
        const rows = await port.listDestinations(didRef);
        const same = rows.filter((r) => r.target === target);
        if (same.length > 1) throw new ProvisionerError("needs_review", "duplicate identical destinations already exist");
        if (same.length === 1) return { ref: same[0].ref, created: false };
        if (rows.length > 0) throw new ProvisionerError("did_has_other_destination", "this number already routes elsewhere; changing it is a separate explicit action");
        guardWrite(`dest:${didRef}`, lease);
        let ref;
        try { ref = (await port.createDestination({ didRef, target })).ref; await hooks.afterUpstreamWrite?.("destination"); }
        catch (e) {
          const again = (await port.listDestinations(didRef)).filter((r) => r.target === target);
          if (again.length === 1) return { ref: again[0].ref, created: true };
          if (again.length > 1) throw new ProvisionerError("needs_review", "duplicate destinations after an ambiguous write");
          throw e;
        }
        const after = (await port.listDestinations(didRef)).filter((r) => r.target === target);
        if (after.length !== 1) throw new ProvisionerError("needs_review", `expected exactly one destination row, found ${after.length}`);
        return { ref, created: true };
      }));
    },

    async readBack({ didRef }) {
      const d = await port.getDid(didRef);
      const rows = d ? await port.listDestinations(didRef) : [];
      return { didActive: !!d?.active, destination: rows.length === 1 ? { target: rows[0].target, active: !!rows[0].active } : null, destinationCount: rows.length };
    },

    /** Startup reconciliation: nothing is accepted until every non-final operation has been looked at. Only reads; never writes upstream. */
    async recover() {
      const out = [];
      for (const op of store.inFlight()) out.push({ key: op.key, step: op.step, was: op.state });
      for (const op of store.inFlight()) store.setOp(op.key, "unknown", null, op.error ?? "interrupted", now()); // re-running the key reconciles via lookup
      return out;
    },
  };
}
