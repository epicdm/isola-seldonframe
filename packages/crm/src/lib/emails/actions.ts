"use server";

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
import { extractEmailTemplates, renderTemplateWithContact, sendEmailForOrg, type EmailTemplate } from "./emails-internal";

export async function listEmails() {
  const orgId = await getOrgId();

  if (!orgId) {
    return [];
  }

  return db.select().from(emails).where(eq(emails.orgId, orgId));
}

export async function listEmailTemplates() {
  const orgId = await getOrgId();

  if (!orgId) {
    return [];
  }

  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return extractEmailTemplates(org?.settings);
}

export async function createEmailTemplateAction(formData: FormData) {
  await requireWorkspaceAdmin();
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const name = String(formData.get("name") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const tag = String(formData.get("tag") ?? "general").trim().toLowerCase() || "general";
  const triggerEventRaw = String(formData.get("triggerEvent") ?? "").trim();
  const triggerEvent = triggerEventRaw ? triggerEventRaw.toLowerCase() : "";

  if (!name || !subject || !body) {
    throw new Error("Template name, subject, and body are required");
  }

  if (triggerEvent && !isValidEventType(triggerEvent)) {
    throw new Error("Trigger event must use lowercase entity.action format");
  }

  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const currentTemplates = extractEmailTemplates(org?.settings);

  const nextTemplate: EmailTemplate = {
    id: `tmpl_${Date.now()}`,
    name,
    subject,
    body,
    tag,
    triggerEvent: triggerEvent || undefined,
    createdAt: new Date().toISOString(),
  };

  const nextSettings = {
    ...((org?.settings as Record<string, unknown> | null) ?? {}),
    emailTemplates: [...currentTemplates, nextTemplate],
  };

  await db
    .update(organizations)
    .set({
      settings: nextSettings,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));
}

export async function createEmailTemplateForSeldonAction(input: {
  name: string;
  subject: string;
  body: string;
  tag?: string;
  triggerEvent?: string;
}) {
  await requireWorkspaceAdmin();
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const name = String(input.name ?? "").trim();
  const subject = String(input.subject ?? "").trim();
  const body = String(input.body ?? "").trim();
  const tag = String(input.tag ?? "general").trim().toLowerCase() || "general";
  const triggerEventRaw = String(input.triggerEvent ?? "").trim();
  const triggerEvent = triggerEventRaw ? triggerEventRaw.toLowerCase() : "";

  if (!name || !subject || !body) {
    throw new Error("Template name, subject, and body are required");
  }

  if (triggerEvent && !isValidEventType(triggerEvent)) {
    throw new Error("Trigger event must use lowercase entity.action format");
  }

  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const currentTemplates = extractEmailTemplates(org?.settings);

  const nextTemplate: EmailTemplate = {
    id: `tmpl_${Date.now()}`,
    name,
    subject,
    body,
    tag,
    triggerEvent: triggerEvent || undefined,
    createdAt: new Date().toISOString(),
  };

  const nextSettings = {
    ...((org?.settings as Record<string, unknown> | null) ?? {}),
    emailTemplates: [...currentTemplates, nextTemplate],
  };

  await db
    .update(organizations)
    .set({
      settings: nextSettings,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));

  return { id: nextTemplate.id };
}

export async function updateEmailTemplateAction(input: {
  templateId: string;
  name?: string;
  subject?: string;
  body?: string;
  tag?: string;
  triggerEvent?: string;
}) {
  await requireWorkspaceAdmin();
  assertWritable();

  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const templateId = String(input.templateId ?? "").trim();
  const requestedName = typeof input.name === "string" ? input.name.trim() : undefined;
  const requestedSubject = typeof input.subject === "string" ? input.subject.trim() : undefined;
  const requestedBody = typeof input.body === "string" ? input.body.trim() : undefined;
  const requestedTag = typeof input.tag === "string" ? input.tag.trim().toLowerCase() : undefined;
  const triggerEventRaw = String(input.triggerEvent ?? "").trim();
  const triggerEvent = triggerEventRaw ? triggerEventRaw.toLowerCase() : "";

  if (!templateId) {
    throw new Error("Template ID is required");
  }

  if (triggerEvent && !isValidEventType(triggerEvent)) {
    throw new Error("Trigger event must use lowercase entity.action format");
  }

  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const currentTemplates = extractEmailTemplates(org?.settings);
  const target = currentTemplates.find((template) => template.id === templateId);

  if (!target) {
    throw new Error("Template not found");
  }

  const name = requestedName || target.name;
  const subject = requestedSubject || target.subject;
  const body = requestedBody || target.body;
  const tag = requestedTag || target.tag || "general";

  const nextTemplates = currentTemplates.map((template) => {
    if (template.id !== templateId) {
      return template;
    }

    return {
      ...template,
      name,
      subject,
      body,
      tag,
      triggerEvent: triggerEvent || undefined,
    };
  });

  const nextSettings = {
    ...((org?.settings as Record<string, unknown> | null) ?? {}),
    emailTemplates: nextTemplates,
  };

  await db
    .update(organizations)
    .set({
      settings: nextSettings,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));

  return {
    id: templateId,
    name,
    subject,
    body,
    tag,
    triggerEvent: triggerEvent || undefined,
  };
}

export async function sendEmailTemplateToContactAction({
  contactId,
  templateId,
}: {
  contactId: string;
  templateId: string;
}) {
  assertWritable();

  const orgId = await getOrgId();
  const user = await getCurrentUser();

  if (!orgId || !user?.id) {
    throw new Error("Unauthorized");
  }

  const [contact] = await db
    .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
    .limit(1);

  if (!contact?.email) {
    throw new Error("Contact email is required");
  }

  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const templates = extractEmailTemplates(org?.settings);
  const template = templates.find((item) => item.id === templateId);

  if (!template) {
    throw new Error("Template not found");
  }

  const renderedTemplate = renderTemplateWithContact(template, contact.firstName);

  await sendEmailForOrg({
    orgId,
    userId: user.id,
    contactId: contact.id,
    toEmail: contact.email,
    subject: renderedTemplate.subject,
    body: renderedTemplate.body,
    providerOverride: "resend",
    metadata: {
      source: "contact-detail-template",
      templateId: template.id,
      templateTag: template.tag,
    },
  });
}

export async function sendEmailTemplateToContactFormAction(formData: FormData) {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "").trim();

  if (!contactId || !templateId) {
    throw new Error("Contact and template are required");
  }

  await sendEmailTemplateToContactAction({
    contactId,
    templateId,
  });
}

export async function sendEmailAction(formData: FormData) {
  assertWritable();

  const orgId = await getOrgId();
  const user = await getCurrentUser();

  if (!orgId || !user?.id) {
    throw new Error("Unauthorized");
  }

  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  const toEmail = String(formData.get("toEmail") ?? "").trim();

  if (!toEmail) {
    throw new Error("Recipient email is required");
  }

  if (contactId) {
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
      .limit(1);

    if (!contact) {
      throw new Error("Contact not found");
    }
  }

  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!subject || !body) {
    throw new Error("Subject and body are required");
  }

  await sendEmailForOrg({
    orgId,
    userId: user.id,
    contactId,
    toEmail,
    subject,
    body,
    providerOverride: String(formData.get("provider") ?? "") || null,
    metadata: {
      source: "dashboard",
    },
  });
}

export async function markEmailOpenedAction(emailId: string) {
  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const [row] = await db
    .update(emails)
    .set({
      openCount: sql`${emails.openCount} + 1`,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emails.orgId, orgId), eq(emails.id, emailId)))
    .returning({ id: emails.id, contactId: emails.contactId });

  if (row?.contactId) {
    await emitSeldonEvent("email.opened", {
      emailId: row.id,
      contactId: row.contactId,
    }, { orgId });
  }

  await recordEmailOpenedLearning(orgId);
}

export async function markEmailOpenedByPixelAction(emailId: string) {
  const [row] = await db
    .update(emails)
    .set({
      openCount: sql`${emails.openCount} + 1`,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emails.id, emailId))
    .returning({ id: emails.id, contactId: emails.contactId, orgId: emails.orgId });

  if (row?.contactId) {
    await emitSeldonEvent("email.opened", {
      emailId: row.id,
      contactId: row.contactId,
    }, { orgId: row.orgId });
  }

  if (row?.orgId) {
    await recordEmailOpenedLearning(row.orgId);
  }
}

export async function markEmailClickedAction(emailId: string, url: string) {
  const orgId = await getOrgId();

  if (!orgId) {
    throw new Error("Unauthorized");
  }

  const [row] = await db
    .update(emails)
    .set({
      clickCount: sql`${emails.clickCount} + 1`,
      lastClickedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emails.orgId, orgId), eq(emails.id, emailId)))
    .returning({ id: emails.id, contactId: emails.contactId });

  if (row?.contactId) {
    await emitSeldonEvent("email.clicked", {
      emailId: row.id,
      contactId: row.contactId,
      url,
    }, { orgId });
  }
}
