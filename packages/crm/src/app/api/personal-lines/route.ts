import { getOrgId } from "@/lib/auth/helpers";
import { listTenantPersonalLines } from "@/lib/personal-lines/tenant-data";
import { createPersonalLinesListHandler } from "@/lib/personal-lines/http";

export const GET = createPersonalLinesListHandler(getOrgId, listTenantPersonalLines);
