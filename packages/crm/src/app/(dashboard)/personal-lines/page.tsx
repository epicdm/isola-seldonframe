import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrgId } from "@/lib/auth/helpers";
import { listTenantPersonalLines } from "@/lib/personal-lines/tenant-data";

export default async function PersonalLinesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const orgId = await getOrgId();
  if (!orgId) redirect("/login");
  const { search = "" } = await searchParams;
  const lines = await listTenantPersonalLines(orgId, search);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">Workspace services</p>
        <h1 className="text-2xl font-semibold">Personal Lines</h1>
        <p className="mt-2 text-sm text-muted-foreground">Accounts associated with this workspace through verified Personal Line lifecycle events.</p>
      </header>

      <form action="/personal-lines" method="get" className="flex max-w-xl gap-2">
        <label className="sr-only" htmlFor="line-search">Search Personal Lines</label>
        <input id="line-search" name="search" defaultValue={search} placeholder="Search customer or masked number" className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
        <button className="rounded-md border px-4 py-2 text-sm font-medium" type="submit">Search</button>
      </form>

      {lines.length === 0 ? (
        <section className="rounded-lg border p-6 text-sm text-muted-foreground">
          No Personal Line accounts are associated with this workspace yet. New accounts appear after the signed signup lifecycle is enabled and records its workspace binding.
        </section>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-muted-foreground"><tr><th className="p-3">Customer</th><th className="p-3">Account</th><th className="p-3">Number</th><th className="p-3">Onboarding stage</th><th className="p-3">Updated</th></tr></thead>
            <tbody>{lines.map((line) => (
              <tr key={line.referenceId} className="border-t">
                <td className="p-3"><Link className="underline-offset-4 hover:underline" href={`/contacts/${encodeURIComponent(line.customerId)}`}>{line.customerName}</Link></td>
                <td className="p-3"><Link className="font-medium underline-offset-4 hover:underline" href={`/contacts/${encodeURIComponent(line.customerId)}`}>{line.accountAssigned ? "Assigned · open customer" : "Pending · open customer"}</Link></td>
                <td className="p-3">{line.facts.did_masked ?? "Not yet recorded"}</td>
                <td className="p-3">{line.stage}</td>
                <td className="p-3">{new Date(line.updatedAt).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Plan and payment evidence is not yet available through this lifecycle association. No plan status is inferred from onboarding events.</p>
    </main>
  );
}
