import { notFound, redirect } from "next/navigation";
import { getOrgId } from "@/lib/auth/helpers";
import { getTenantPersonalLine } from "@/lib/personal-lines/tenant-data";

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
  redirect(`/contacts/${encodeURIComponent(line.customerId)}`);
}
