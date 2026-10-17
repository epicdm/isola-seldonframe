// The one entry point the page uses. The ONLY identity input is the workspace id the server resolved from the session.
import { buildLineView, type ViewOptions } from "./view-model";
import type { LinkStore } from "./link-store";
import type { EvidenceResult, LineLink, PageView } from "./types";

export type ServiceDeps = {
  store: LinkStore;
  provider: (link: LineLink) => Promise<EvidenceResult>;
  now: () => Date;
  expectedSipHost?: string | null;
};

export async function loadPhoneWhatsappView(orgId: string, deps: ServiceDeps): Promise<PageView> {
  if (typeof orgId !== "string" || orgId.length < 8) throw new Error("loadPhoneWhatsappView requires the signed-in workspace id");
  const links = await deps.store.getLinks(orgId);
  if (links.length === 0) return { kind: "no_link" };

  // One number, one workspace. Any other claimant (or no claim at all for this workspace) means the data is not ours to show.
  for (const l of links) {
    const owners = new Set(await deps.store.claimants(l.phoneNumberId));
    if (!owners.has(orgId) || owners.size !== 1) return { kind: "link_conflict" };
  }

  const opts: ViewOptions = { now: deps.now(), expectedSipHost: deps.expectedSipHost ?? null, proofWindowDays: 30 };
  const lines = await Promise.all(
    links.map(async (l) => {
      let result: EvidenceResult;
      try {
        result = await deps.provider(l);
      } catch (e) {
        result = { kind: "failed", error: e instanceof Error ? e.message.slice(0, 160) : "unexpected failure" };
      }
      return buildLineView(l, result, opts);
    }),
  );
  return { kind: "lines", lines };
}
