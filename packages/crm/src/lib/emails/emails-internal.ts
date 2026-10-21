// EPIC 2026-10-21 (staff-access correction): server-INTERNAL helpers moved verbatim out of the "use server" module next
// to this file, so they are no longer exported as client-callable server actions. Each takes its workspace as an
// argument and reads no session; only server code (webhooks, callbacks, event listeners, other server modules) calls them.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities, contacts, emails, organizations, users } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";
import { emitSeldonEvent } from "@/lib/events/bus";
import { isValidEventType } from "@/lib/events/event-types";
import { recordEmailOpenedLearning, recordEmailSentLearning } from "@/lib/soul/learning";
import { assertEmailSendLimit, incrementEmailSendUsage } from "@/lib/tier/limits";
import { dispatchWebhook } from "@/lib/utils/webhooks";
import {
  getEmailProvider,
  resolveDefaultFromEmail,
  resolveEmailProvider,
} from "./providers";
import { isEmailSuppressed, normalizeEmail } from "./suppression";
import { renderPlainEmailTemplate } from "./templates";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  tag: string;
  triggerEvent?: string;
  createdAt: string;
};

export type OrgSettingsWithTemplates = {
  emailTemplates?: EmailTemplate[];
  soulPackage?: {
    emailTemplates?: Array<{
      name?: string;
      subject?: string;
      body?: string;
      tag?: string;
      triggerEvent?: string;
    }>;
  };
};

export function extractEmailTemplates(settings: unknown): EmailTemplate[] {
  const source = (settings as OrgSettingsWithTemplates | null) ?? {};
  const rootTemplates = Array.isArray(source.emailTemplates) ? source.emailTemplates : [];
  const frameworkTemplates = Array.isArray(source.soulPackage?.emailTemplates) ? source.soulPackage.emailTemplates : [];

  const normalizedRoot = rootTemplates
    .filter((item): item is EmailTemplate => Boolean(item && typeof item === "object" && item.name && item.subject && item.body))
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id : `tmpl_root_${index}_${Date.now()}`,
      name: item.name,
      subject: item.subject,
      body: item.body,
      tag: item.tag || "general",
      triggerEvent: typeof item.triggerEvent === "string" ? item.triggerEvent : undefined,
      createdAt: item.createdAt || new Date().toISOString(),
    }));

  const normalizedFramework = frameworkTemplates
    .filter((item): item is NonNullable<typeof item> => Boolean(item && typeof item === "object"))
    .filter((item) => typeof item.name === "string" && typeof item.subject === "string" && typeof item.body === "string")
    .map((item, index) => ({
      id: `tmpl_framework_${index}_${item.name!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: item.name!,
      subject: item.subject!,
      body: item.body!,
      tag: typeof item.tag === "string" ? item.tag : "framework",
      triggerEvent: typeof item.triggerEvent === "string" ? item.triggerEvent : undefined,
      createdAt: new Date().toISOString(),
    }));

  const deduped = new Map<string, EmailTemplate>();
  for (const template of [...normalizedFramework, ...normalizedRoot]) {
    const key = `${template.name.toLowerCase()}::${template.subject.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, template);
    }
  }

  return Array.from(deduped.values());
}

export function renderTemplateWithContact(template: EmailTemplate, contactFirstName: string | null) {
  const safeName = contactFirstName || "there";
  return {
    subject: template.subject.replaceAll("{{firstName}}", safeName),
    body: template.body.replaceAll("{{firstName}}", safeName),
  };
}

export function buildTrackingPixel(emailId: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/email/open/${emailId}`;
}

export async function getOrgOwnerUserId(orgId: string) {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);
  return owner?.id ?? null;
}

export async function createEmailTimelineActivity(params: {
  orgId: string;
  userId: string;
  contactId: string | null;
  subject: string;
  emailId: string;
  toEmail: string;
}) {
  await db.insert(activities).values({
    orgId: params.orgId,
    userId: params.userId,
    contactId: params.contactId,
    type: "email",
    subject: `Email sent: ${params.subject}`,
    body: `Sent to ${params.toEmail}`,
    metadata: {
      emailId: params.emailId,
      source: "email",
    },
  });
}

export async function sendEmailForOrg(params: {
  orgId: string;
  userId: string;
  contactId: string | null;
  toEmail: string;
  subject: string;
  body: string;
  providerOverride?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const toEmail = normalizeEmail(params.toEmail);

  const suppression = await isEmailSuppressed(params.orgId, toEmail);
  if (suppression) {
    await emitSeldonEvent("email.suppressed", {
      email: toEmail,
      reason: suppression.reason,
      contactId: params.contactId,
    }, { orgId: params.orgId });
    return { emailId: null, contactId: params.contactId, suppressed: true as const };
  }

  const provider = await resolveEmailProvider(params.providerOverride || null);

  await assertEmailSendLimit(params.orgId);

  const rendered = renderPlainEmailTemplate({
    heading: params.subject,
    body: params.body,
  });

  const [created] = await db
    .insert(emails)
    .values({
      orgId: params.orgId,
      contactId: params.contactId,
      userId: params.userId,
      provider,
      fromEmail: resolveDefaultFromEmail(),
      toEmail: params.toEmail,
      subject: params.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: "queued",
      metadata: {
        source: "dashboard",
        providerConfigured: provider !== "manual",
        ...(params.metadata ?? {}),
      },
    })
    .returning({ id: emails.id, contactId: emails.contactId });

  if (!created) {
    throw new Error("Could not queue email");
  }

  const trackedHtml = `${rendered.html}<img src="${buildTrackingPixel(created.id)}" alt="" width="1" height="1" style="display:none" />`;

  let externalMessageId = `${provider}-${Date.now()}`;

  const impl = getEmailProvider(provider);
  if (impl) {
    const result = await impl.send({
      orgId: params.orgId,
      from: resolveDefaultFromEmail(),
      to: params.toEmail,
      subject: params.subject,
      html: trackedHtml,
      text: rendered.text,
      tags: [{ name: "email_id", value: created.id }],
    });
    externalMessageId = result.externalMessageId;
  }

  await db
    .update(emails)
    .set({
      bodyHtml: trackedHtml,
      status: "sent",
      externalMessageId,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emails.id, created.id));

  if (created.contactId) {
    await emitSeldonEvent("email.sent", {
      emailId: created.id,
      contactId: created.contactId,
    }, { orgId: params.orgId });
  }

  await createEmailTimelineActivity({
    orgId: params.orgId,
    userId: params.userId,
    contactId: created.contactId,
    subject: params.subject,
    emailId: created.id,
    toEmail: params.toEmail,
  });

  await recordEmailSentLearning({
    orgId: params.orgId,
    subject: params.subject,
    sentAt: new Date(),
  });

  await incrementEmailSendUsage(params.orgId);

  await dispatchWebhook({
    orgId: params.orgId,
    event: "email.sent",
    payload: {
      emailId: created.id,
      contactId: created.contactId,
      provider,
      toEmail: params.toEmail,
    },
  });

  return { emailId: created.id, contactId: created.contactId, suppressed: false as const };
}

export async function sendWelcomeEmailForContact(contactId: string) {
  const [contact] = await db
    .select({
      id: contacts.id,
      orgId: contacts.orgId,
      email: contacts.email,
      firstName: contacts.firstName,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact?.email) {
    return;
  }

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, contact.orgId))
    .limit(1);
  const templates = extractEmailTemplates(org?.settings);
  const welcomeTemplate = templates.find((item) => item.tag === "welcome");

  if (!welcomeTemplate) {
    return;
  }

  const ownerUserId = await getOrgOwnerUserId(contact.orgId);

  if (!ownerUserId) {
    return;
  }

  const renderedTemplate = renderTemplateWithContact(welcomeTemplate, contact.firstName);

  await sendEmailForOrg({
    orgId: contact.orgId,
    userId: ownerUserId,
    contactId: contact.id,
    toEmail: contact.email,
    subject: renderedTemplate.subject,
    body: renderedTemplate.body,
    providerOverride: "resend",
    metadata: {
      source: "welcome-automation",
      templateId: welcomeTemplate.id,
      templateTag: welcomeTemplate.tag,
    },
  });
}

export async function sendTriggeredEmailsForContactEvent(params: { eventType: string; contactId: string }) {
  if (!isValidEventType(params.eventType)) {
    return;
  }

  const normalizedEventType = params.eventType.toLowerCase();

  const [contact] = await db
    .select({
      id: contacts.id,
      orgId: contacts.orgId,
      email: contacts.email,
      firstName: contacts.firstName,
    })
    .from(contacts)
    .where(eq(contacts.id, params.contactId))
    .limit(1);

  if (!contact?.email) {
    return;
  }

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, contact.orgId))
    .limit(1);

  const matchingTemplates = extractEmailTemplates(org?.settings).filter(
    (template) => (template.triggerEvent || "").toLowerCase() === normalizedEventType
  );

  if (matchingTemplates.length === 0) {
    return;
  }

  const ownerUserId = await getOrgOwnerUserId(contact.orgId);

  if (!ownerUserId) {
    return;
  }

  for (const template of matchingTemplates) {
    const renderedTemplate = renderTemplateWithContact(template, contact.firstName);

    await sendEmailForOrg({
      orgId: contact.orgId,
      userId: ownerUserId,
      contactId: contact.id,
      toEmail: contact.email,
      subject: renderedTemplate.subject,
      body: renderedTemplate.body,
      providerOverride: "resend",
      metadata: {
        source: "event-trigger-template",
        templateId: template.id,
        templateTag: template.tag,
        triggerEvent: normalizedEventType,
      },
    });
  }
}
