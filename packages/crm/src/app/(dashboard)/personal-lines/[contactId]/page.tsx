import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOrgId } from "@/lib/auth/helpers";
import { getTenantPersonalLine } from "@/lib/personal-lines/tenant-data";
import { ChatwootLinkCard } from "@/components/contacts/chatwoot-link-card";
import { getChatwootLinkState, type LinkState } from "@/lib/chatwoot-link/service";
import { canConfirmChatwootLink, resolveChatwootActor } from "@/lib/chatwoot-link/session";
import { makeChatwootLinkDeps } from "@/lib/chatwoot-link/wiring";

export default async function PersonalLineDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const orgId = await getOrgId();
  if (!orgId) redirect("/login");
  const { contactId } = await params;
  const line = await getTenantPersonalLine(orgId, contactId);
  if (!line) notFound();
  const chatwootLink: LinkState = await getChatwootLinkState(orgId, line.customerId, makeChatwootLinkDeps(orgId)).catch(
    () => ({ state: "unavailable" }) as LinkState,
  );
  const chatwootCanConfirm =
    chatwootLink.state === "unlinked" && canConfirmChatwootLink(await resolveChatwootActor().catch(() => null));

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <Link href="/personal-lines" className="text-sm text-muted-foreground underline-offset-4 hover:underline">← Personal Lines</Link>
      <header><p className="text-sm text-muted-foreground">Workspace Personal Line</p><h1 className="text-2xl font-semibold">{line.accountAssigned ? "Personal Line" : "Signup in progress"}</h1></header>
      <section className="rounded-lg border p-5">
        <p className="text-xs text-muted-foreground">Linked customer</p>
        <Link href={`/contacts/${encodeURIComponent(line.customerId)}`} className="mt-1 inline-block font-medium underline-offset-4 hover:underline">{line.customerName}</Link>
        <p className="mt-1 text-xs text-muted-foreground">Customer association comes from the signed Personal Line identity link.</p>
      </section>
      <section className="grid gap-4 rounded-lg border p-5 sm:grid-cols-2">
        <div><p className="text-xs text-muted-foreground">Onboarding stage</p><p className="mt-1 font-medium">{line.stage}</p></div>
        <div><p className="text-xs text-muted-foreground">Account assignment</p><p className="mt-1 font-medium">{line.accountAssigned ? "Assigned" : "Pending"}</p></div>
        <div><p className="text-xs text-muted-foreground">Personal Line number</p><p className="mt-1 font-medium">{line.facts.did_masked ?? "Not yet recorded"}</p></div>
        <div><p className="text-xs text-muted-foreground">SIP registration</p><p className="mt-1 font-medium">{line.facts.registered_at ? `Registered ${line.facts.registered_at}` : "No registration event recorded"}</p></div>
        <div><p className="text-xs text-muted-foreground">First call</p><p className="mt-1 font-medium">{line.facts.first_call_at ?? "No first-call event recorded"}</p></div>
      </section>
      {chatwootLink.state !== "unavailable" ? (
        <ChatwootLinkCard
          key={`${line.customerId}:${chatwootLink.state}:${chatwootLink.state === "linked" ? `${chatwootLink.url}:${chatwootLink.confirmedAt}` : ""}`}
          contactId={line.customerId}
          initial={chatwootLink}
          canConfirm={chatwootCanConfirm}
        />
      ) : null}
      <p className="text-sm text-muted-foreground">Payment and plan status require a trusted billing association. This page does not infer them from signup or call events. No management action is enabled until its supported service procedure is connected.</p>
    </main>
  );
}
