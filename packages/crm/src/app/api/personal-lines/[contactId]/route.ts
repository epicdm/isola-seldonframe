import { getOrgId } from "@/lib/auth/helpers";
import { getTenantPersonalLine } from "@/lib/personal-lines/tenant-data";
import { createPersonalLineDetailHandler } from "@/lib/personal-lines/http";

const handleDetail = createPersonalLineDetailHandler(getOrgId, getTenantPersonalLine);

export async function GET(request: Request, context: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await context.params;
  return handleDetail(request, contactId);
}
