// Phone & WhatsApp: a READ-ONLY view of this workspace's WhatsApp business number(s), calling eligibility, call
// destination, routing readiness and last call. Part one of the journey: connect -> select number -> configure
// destination -> verify routing -> acceptance call. This page shows evidence; EPIC staff perform every change.
//
// Identity: the ONLY input is getOrgId() (server session). This page reads no params, no searchParams, no cookies of its own
// and renders no input that could name a number or workspace. There is no write action, no server action and no form.
import { redirect } from "next/navigation";

import { getOrgId } from "@/lib/auth/helpers";
import { loadPhoneWhatsappView } from "@/lib/phone-whatsapp/service";
import { getServiceDeps, getStaffSetupWhatsapp } from "@/lib/phone-whatsapp/server";
import { PhoneWhatsappView } from "./view";

export const dynamic = "force-dynamic";

export default async function PhoneWhatsappPage() {
  const orgId = await getOrgId();
  if (!orgId) redirect("/login");

  const view = await loadPhoneWhatsappView(orgId, getServiceDeps());
  return <PhoneWhatsappView view={view} waNumber={getStaffSetupWhatsapp()} />;
}
