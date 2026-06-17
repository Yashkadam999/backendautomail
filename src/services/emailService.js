import nodemailer from "nodemailer";
import { env } from "../config/env.js";

function createTransporter() {
  if (!env.gmail.user || !env.gmail.appPassword) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: env.gmail.user,
      pass: env.gmail.appPassword
    }
  });
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const filename = String(attachment.filename || attachment.name || "attachment").trim();
  const contentType = String(attachment.contentType || attachment.mimeType || "application/octet-stream");
  const rawContent = attachment.content || attachment.data || "";

  if (!filename || !rawContent) {
    return null;
  }

  if (typeof rawContent === "string" && rawContent.startsWith("data:")) {
    const match = rawContent.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return null;
    }

    return {
      filename,
      contentType: attachment.contentType || match[1] || contentType,
      content: Buffer.from(match[2], "base64")
    };
  }

  if (typeof rawContent === "string") {
    return {
      filename,
      contentType,
      content: Buffer.from(rawContent, "base64")
    };
  }

  return null;
}

export async function sendEmail({ to, subject, text, html, attachments = [], inReplyTo = "", references = [] }) {
  const transporter = createTransporter();
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map(normalizeAttachment).filter(Boolean)
    : [];
  const threadReferences = Array.isArray(references) ? references.filter(Boolean) : [];
  const mailHeaders = {};

  if (inReplyTo) {
    mailHeaders["In-Reply-To"] = inReplyTo;
  }

  if (threadReferences.length) {
    mailHeaders.References = threadReferences.join(" ");
  }

  if (!transporter) {
    return {
      mode: "mock",
      messageId: `mock-email-${Date.now()}`,
      to,
      subject,
      inReplyTo,
      references: threadReferences,
      attachments: normalizedAttachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType
      }))
    };
  }

  const info = await transporter.sendMail({
    from: `${env.gmail.fromName} <${env.gmail.user}>`,
    to,
    subject,
    text,
    html: html || text,
    attachments: normalizedAttachments,
    headers: mailHeaders
  });

  return {
    mode: "live",
    messageId: info.messageId,
    to,
    subject,
    inReplyTo,
    references: threadReferences,
    attachments: normalizedAttachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType
    }))
  };
}
