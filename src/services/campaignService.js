import cron from "node-cron";
import { env } from "../config/env.js";
import { Campaign } from "../models/Campaign.js";
import { Template } from "../models/Template.js";
import {
  extractTemplateVariables,
  formatRichTextEmailHtml,
  htmlToPlainText,
  renderTemplate
} from "./templateService.js";
import { sendEmail } from "./emailService.js";
import { generateWhatsAppLink, normalizePhone } from "./whatsappService.js";
import { fetchSheetColumns, fetchSheetRows } from "./googleSheetsService.js";

const schedulerState = {
  started: false,
  task: null,
  startedAt: null
};

const DELIVERY_MISS_GRACE_MS = 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return 200 + Math.floor(Math.random() * 300);
}

function toDate(value) {
  if (!value) {
    return new Date();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function combineDateAndTime(dateValue, timeValue) {
  const date = toDate(dateValue);
  const [hours = "0", minutes = "0"] = String(timeValue || "").split(":");

  date.setHours(Number(hours) || 0, Number(minutes) || 0, 0, 0);
  return date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function toDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertRangeStartsTodayOrLater({ deliveryRangeStart }, errorMessage = "deliveryRangeStart cannot be in the past") {
  if (!deliveryRangeStart) {
    return;
  }

  const todayStart = startOfDay(new Date());
  const rangeStart = startOfDay(toDate(deliveryRangeStart));

  if (rangeStart.getTime() < todayStart.getTime()) {
    throw new Error(errorMessage);
  }
}

function normalizeScheduledDays(days = []) {
  if (!Array.isArray(days)) {
    return [];
  }

  return [...new Set(days.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort(
    (a, b) => a - b
  );
}

function normalizeDateRange({ scheduledAt, deliveryRangeStart, deliveryRangeEnd }) {
  const startSource = deliveryRangeStart || scheduledAt || new Date();
  const endSource = deliveryRangeEnd || startSource;
  const startDate = startOfDay(toDate(startSource));
  const endDate = endOfDay(toDate(endSource));

  if (startDate.getTime() > endDate.getTime()) {
    throw new Error("deliveryRangeEnd must be on or after deliveryRangeStart");
  }

  return {
    deliveryRangeStart: startDate,
    deliveryRangeEnd: endDate
  };
}

function isCampaignInRange(campaign, currentDate = new Date()) {
  const rangeStart = campaign?.deliveryRangeStart ? startOfDay(new Date(campaign.deliveryRangeStart)) : null;
  const rangeEnd = campaign?.deliveryRangeEnd ? endOfDay(new Date(campaign.deliveryRangeEnd)) : null;

  if (!rangeStart || !rangeEnd) {
    return true;
  }

  return currentDate.getTime() >= rangeStart.getTime() && currentDate.getTime() <= rangeEnd.getTime();
}

function isCampaignRangeExpired(campaign, currentDate = new Date()) {
  if (!campaign?.deliveryRangeEnd) {
    return false;
  }

  return currentDate.getTime() > endOfDay(new Date(campaign.deliveryRangeEnd)).getTime();
}

function hasDeliveredToday(campaign, currentDate = new Date()) {
  return String(campaign?.lastDeliveredOn || "") === toDayKey(currentDate);
}

function getCampaignScheduledClock(campaign) {
  const scheduledAt = campaign?.scheduledAt ? new Date(campaign.scheduledAt) : null;

  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return { hours: 0, minutes: 0 };
  }

  return {
    hours: scheduledAt.getHours(),
    minutes: scheduledAt.getMinutes()
  };
}

function isScheduledTimeReached(campaign, currentDate = new Date()) {
  const scheduledForToday = getCampaignScheduledDateTime(campaign, currentDate);
  return currentDate.getTime() >= scheduledForToday.getTime();
}

function getCampaignScheduledDateTime(campaign, date = new Date()) {
  const { hours, minutes } = getCampaignScheduledClock(campaign);
  const scheduledForDate = new Date(date);

  scheduledForDate.setHours(hours, minutes, 0, 0);
  return scheduledForDate;
}

function shouldMarkDeliveryMissed(campaign, currentDate = new Date()) {
  if (!wasSchedulerOfflineAtScheduledTime(campaign, currentDate)) {
    return false;
  }

  if (!isCampaignInRange(campaign, currentDate)) {
    return false;
  }

  if (!isCampaignAllowedToday(campaign, currentDate)) {
    return false;
  }

  if (hasDeliveredToday(campaign, currentDate)) {
    return false;
  }

  const scheduledForToday = getCampaignScheduledDateTime(campaign, currentDate);
  const delayMs = currentDate.getTime() - scheduledForToday.getTime();

  return delayMs > DELIVERY_MISS_GRACE_MS;
}

function wasSchedulerOfflineAtScheduledTime(campaign, currentDate = new Date()) {
  const schedulerStartedAt = schedulerState.startedAt ? new Date(schedulerState.startedAt) : null;
  if (!schedulerStartedAt || Number.isNaN(schedulerStartedAt.getTime())) {
    return false;
  }

  const scheduledForToday = getCampaignScheduledDateTime(campaign, currentDate);
  return schedulerStartedAt.getTime() > scheduledForToday.getTime();
}

function createMissedDeliveryResult({ row, channel, scheduledFor, reason }) {
  const { email, phone } = identifyRecipient(row || {});
  const message = renderTemplate(
    "Delivery window missed for {{name}}",
    {
      ...(row || {}),
      name: extractRecipientName(row || {}) || "recipient"
    }
  );

  return {
    ...(row || {}),
    name: extractRecipientName(row || {}),
    email: String(email || "").trim(),
    phone: normalizePhone(phone),
    channel,
    subject: "",
    message,
    emailStatus: channel === "email" ? "skipped" : "skipped",
    emailMessageId: "",
    emailMode: "skipped",
    emailInReplyTo: "",
    emailReferences: [],
    emailAttachments: [],
    whatsappLink: "",
    whatsappStatus: channel === "whatsapp" ? "skipped" : "skipped",
    error: reason,
    scheduledFor
  };
}

async function markCampaignMissedForToday(campaign, currentDate = new Date()) {
  const eligibleRows = Array.isArray(campaign.recipientSnapshot) ? campaign.recipientSnapshot : [];
  const channel = campaign.channel || campaign.templateSnapshot?.channel || campaign.templateId?.channel || "email";
  const dayKey = toDayKey(currentDate);
  const scheduledFor = getCampaignScheduledDateTime(campaign, currentDate);
  const reason = `Delivery window missed on ${dayKey}. Scheduled time passed before campaign processing resumed.`;

  campaign.channel = channel;
  campaign.totalUsers = eligibleRows.length;
  campaign.successCount = 0;
  campaign.failedCount = eligibleRows.length;
  campaign.results = eligibleRows.map((row) =>
    createMissedDeliveryResult({ row, channel, scheduledFor, reason })
  );
  campaign.lastDeliveredOn = dayKey;

  if (!Array.isArray(campaign.missedDeliveries)) {
    campaign.missedDeliveries = [];
  }

  campaign.missedDeliveries.push({
    dayKey,
    scheduledFor,
    failedCount: eligibleRows.length,
    reason,
    recordedAt: new Date()
  });

  campaign.updatedAt = new Date();

  if (isCampaignRangeExpired(campaign, currentDate) || !hasFutureEligibleDeliveryDay(campaign, currentDate)) {
    campaign.status = "range_completed";
    campaign.completedAt = new Date();
  } else {
    campaign.status = "scheduled";
    campaign.completedAt = null;
  }

  await campaign.save();
  return campaign.toObject();
}

function isCampaignAllowedToday(campaign, currentDate = new Date()) {
  const day = currentDate.getDay();
  const mode = campaign?.scheduleMode || "all";

  if (mode === "weekdays") {
    return day >= 1 && day <= 5;
  }

  if (mode === "weekends") {
    return day === 0 || day === 6;
  }

  if (mode === "custom") {
    const customDays = normalizeScheduledDays(campaign?.scheduledDays || []);
    return customDays.includes(day);
  }

  return true;
}

function hasFutureEligibleDeliveryDay(campaign, currentDate = new Date()) {
  if (!campaign?.deliveryRangeEnd) {
    return true;
  }

  const rangeEnd = endOfDay(new Date(campaign.deliveryRangeEnd));
  if (Number.isNaN(rangeEnd.getTime())) {
    return false;
  }

  const cursor = startOfDay(new Date(currentDate));
  cursor.setDate(cursor.getDate() + 1);

  while (cursor.getTime() <= rangeEnd.getTime()) {
    if (isCampaignAllowedToday(campaign, cursor)) {
      return true;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return false;
}

function identifyRecipient(row) {
  const email = row.email || row.Email || row.EMAIL || "";
  const phone = row.phone || row.Phone || row.PHONE || row.whatsapp || row.mobile || "";
  return { email, phone };
}

function shouldIncludeCampaignRecipient(row) {
  if (!row || typeof row !== "object") {
    return false;
  }

  const sendFlagEntries = Object.entries(row).filter(([key]) => {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalizedKey === "issend";
  });

  if (!sendFlagEntries.length) {
    return true;
  }

  const firstDefinedValue = sendFlagEntries.find(([, value]) => value !== undefined && value !== null)?.[1];
  const flagValue = firstDefinedValue ?? sendFlagEntries[0][1];

  if (typeof flagValue === "boolean") {
    return flagValue;
  }

  const normalizedValue = String(flagValue || "").trim().toLowerCase();
  return ["true", "1", "yes", "y"].includes(normalizedValue);
}

function extractRecipientName(row) {
  if (!row || typeof row !== "object") {
    return "";
  }

  const directName =
    row.name ||
    row.Name ||
    row.fullName ||
    row.FullName ||
    row.firstName ||
    row.FirstName ||
    row["Full Name"] ||
    row["First Name"] ||
    "";

  if (directName) {
    return String(directName).trim();
  }

  const derived = Object.entries(row).find(([key, value]) => {
    if (!value) {
      return false;
    }

    const normalizedKey = String(key).toLowerCase().replace(/[^a-z]/g, "");
    return normalizedKey.includes("name") && !normalizedKey.includes("campaign");
  });

  if (derived) {
    return String(derived[1]).trim();
  }

  const genericCandidate = Object.entries(row).find(([key, value]) => {
    const text = String(value || "").trim();
    if (!text) {
      return false;
    }

    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normalizedKey) {
      return false;
    }

    const excludedKeys = [
      "email",
      "phone",
      "mobile",
      "whatsapp",
      "subject",
      "message",
      "status",
      "error",
      "link",
      "campaign",
      "date",
      "time",
      "id"
    ];

    if (excludedKeys.some((token) => normalizedKey.includes(token))) {
      return false;
    }

    // Prefer human-like text values over numeric-only fields.
    return /[a-zA-Z]/.test(text);
  });

  if (genericCandidate) {
    return String(genericCandidate[1]).trim();
  }

  const { email } = identifyRecipient(row);
  const emailLocalPart = String(email || "").split("@")[0];
  if (emailLocalPart) {
    return emailLocalPart
      .replace(/[._-]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  return "";
}

function normalizeEmailRecipient(email = "") {
  return String(email || "").trim().toLowerCase();
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const filename = String(attachment.filename || attachment.name || "").trim();
  const content = attachment.content || attachment.data || "";

  if (!filename || !content) {
    return null;
  }

  return {
    filename,
    contentType: String(attachment.contentType || attachment.mimeType || "application/octet-stream"),
    content
  };
}

function summarizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  return {
    filename: attachment.filename || "attachment",
    contentType: attachment.contentType || "application/octet-stream"
  };
}

async function buildCampaignSnapshot({ campaignName, template, sheetUrl, sheetRange }) {
  if (!template) {
    throw new Error("Template not found");
  }

  if (!sheetUrl) {
    throw new Error("Template is missing sheetUrl. Update template before scheduling campaign");
  }

  const rows = await fetchSheetRows(sheetUrl, sheetRange);
  const eligibleRows = rows.filter(shouldIncludeCampaignRecipient);

  const recipientSnapshot = eligibleRows.map((row) => {
    const { email, phone } = identifyRecipient(row);

    return {
      ...row,
      name: extractRecipientName(row),
      email: String(email || "").trim(),
      phone: normalizePhone(phone)
    };
  });

  return {
    templateSnapshot: {
      name: String(template.name || campaignName || "").trim(),
      channel: String(template.channel || "email").trim() || "email",
      subject: String(template.subject || "").trim(),
      body: String(template.body || "").trim(),
      sheetUrl: String(sheetUrl || "").trim(),
      sheetRange: String(sheetRange || env.google.defaultRange).trim() || env.google.defaultRange,
      capturedAt: new Date()
    },
    recipientSnapshot
  };
}

function normalizeReplyRecipient(result, index) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const email = String(result.email || result.Email || "").trim();
  if (!email) {
    return null;
  }

  return {
    index,
    email,
    name: extractRecipientName(result),
    emailMessageId: String(result.emailMessageId || "").trim(),
    subject: String(result.subject || "").trim(),
    row: result
  };
}

async function buildReplyRecipients(campaign) {
  const channel = campaign?.channel || campaign?.templateId?.channel || "email";
  if (channel !== "email") {
    return [];
  }

  const results = Array.isArray(campaign?.results) ? campaign.results : [];
  if (results.length) {
    let eligibleRows = [];

    if (campaign?.sheetUrl) {
      try {
        const rows = await fetchSheetRows(campaign.sheetUrl, campaign.sheetRange);
        eligibleRows = rows.filter(shouldIncludeCampaignRecipient);
      } catch (_error) {
        eligibleRows = [];
      }
    }

    return results.map((result, index) => {
      const liveRow = eligibleRows[index] && typeof eligibleRows[index] === "object" ? eligibleRows[index] : null;
      const resolvedName = extractRecipientName(result) || extractRecipientName(liveRow || {}) || "";
      const resolvedEmail = String(result?.email || result?.Email || identifyRecipient(liveRow || {}).email || "").trim();
      const resolvedPhone = normalizePhone(result?.phone || result?.Phone || identifyRecipient(liveRow || {}).phone || "");

      return {
        ...(liveRow || {}),
        ...result,
        index,
        name: resolvedName,
        email: resolvedEmail,
        phone: resolvedPhone
      };
    });
  }

  if (!campaign?.sheetUrl) {
    return [];
  }

  try {
    const rows = await fetchSheetRows(campaign.sheetUrl, campaign.sheetRange);
    const eligibleRows = rows.filter(shouldIncludeCampaignRecipient);

    return eligibleRows.map((row, index) => {
      const { email, phone } = identifyRecipient(row);

      return {
        ...row,
        index,
        name: extractRecipientName(row),
        email: String(email || "").trim(),
        phone: normalizePhone(phone),
        channel: "email",
        emailStatus: "queued",
        error: ""
      };
    });
  } catch (_error) {
    return [];
  }
}

export async function createTemplate(payload) {
  const { name, channel, subject = "", body, sheetUrl, sheetRange = env.google.defaultRange } = payload;

  if (!name || !channel || !body || !sheetUrl) {
    throw new Error("name, channel, body, and sheetUrl are required");
  }

  const variables = [
    ...new Set([
      ...extractTemplateVariables(subject),
      ...extractTemplateVariables(body)
    ])
  ];

  const template = new Template({
    name,
    channel,
    subject,
    body,
    sheetUrl,
    sheetRange,
    variables
  });

  await template.save();
  return {
    ...template.toObject(),
    id: template._id.toString()
  };
}

export async function listTemplates() {
  const templates = await Template.find().sort({ createdAt: -1 });
  return templates.map((template) => ({
    ...template.toObject(),
    id: template._id.toString()
  }));
}

export async function updateTemplate(templateId, payload) {
  const template = await Template.findById(templateId);
  if (!template) {
    throw new Error("Template not found");
  }

  const {
    name,
    channel,
    subject,
    body,
    sheetUrl,
    sheetRange
  } = payload || {};

  const nextName = String(name ?? template.name).trim();
  const nextChannel = String(channel ?? template.channel).trim() || template.channel;
  const nextSubject = String(subject ?? template.subject ?? "").trim();
  const nextBody = String(body ?? template.body ?? "").trim();
  const nextSheetUrl = String(sheetUrl ?? template.sheetUrl ?? "").trim();
  const nextSheetRange = String(sheetRange ?? template.sheetRange ?? env.google.defaultRange).trim() || env.google.defaultRange;

  if (!nextName || !nextChannel || !nextBody || !nextSheetUrl) {
    throw new Error("name, channel, body, and sheetUrl are required");
  }

  if (!["email", "whatsapp"].includes(nextChannel)) {
    throw new Error("Invalid template channel");
  }

  if (nextChannel !== template.channel) {
    const dependentCampaignCount = await Campaign.countDocuments({ templateId: template._id });
    if (dependentCampaignCount > 0) {
      throw new Error("Cannot change template channel after campaigns have been created from this template");
    }
  }

  const variables = [
    ...new Set([
      ...extractTemplateVariables(nextSubject),
      ...extractTemplateVariables(nextBody)
    ])
  ];

  template.name = nextName;
  template.channel = nextChannel;
  template.subject = nextChannel === "email" ? nextSubject : "";
  template.body = nextBody;
  template.sheetUrl = nextSheetUrl;
  template.sheetRange = nextSheetRange;
  template.variables = variables;
  await template.save();

  return {
    ...template.toObject(),
    id: template._id.toString()
  };
}

export async function deleteTemplate(templateId) {
  const template = await Template.findById(templateId);
  if (!template) {
    throw new Error("Template not found");
  }

  await Template.findByIdAndDelete(templateId);

  return {
    message: `Template "${template.name}" deleted successfully`,
    deletedId: templateId
  };
}

export async function createCampaign(payload) {
  const {
    name,
    templateId,
    attachments = [],
    scheduleInSameThread = false,
    scheduleMode = "all",
    scheduledDays = [],
    deliveryRangeStart,
    deliveryRangeEnd,
    scheduledTime = "09:00"
  } = payload;

  if (!name || !templateId) {
    throw new Error("name and templateId are required");
  }

  const template = await Template.findById(templateId);
  if (!template) {
    throw new Error("Template not found");
  }

  if (!template.sheetUrl) {
    throw new Error("Template is missing sheetUrl. Update template before scheduling campaign");
  }

  const allowedModes = new Set(["all", "weekdays", "weekends", "custom"]);
  if (!allowedModes.has(scheduleMode)) {
    throw new Error("Invalid scheduleMode");
  }

  const normalizedDays = normalizeScheduledDays(scheduledDays);
  if (scheduleMode === "custom" && !normalizedDays.length) {
    throw new Error("Select at least one day for custom schedule");
  }

  const normalizedRange = normalizeDateRange({
    deliveryRangeStart,
    deliveryRangeEnd
  });
  assertRangeStartsTodayOrLater(normalizedRange);
  const scheduledAt = combineDateAndTime(normalizedRange.deliveryRangeStart, scheduledTime);
  const snapshot = await buildCampaignSnapshot({
    campaignName: name,
    template,
    sheetUrl: template.sheetUrl,
    sheetRange: template.sheetRange || env.google.defaultRange
  });

  const campaign = new Campaign({
    name,
    templateId: template._id,
    channel: template.channel,
    sheetUrl: template.sheetUrl,
    sheetRange: template.sheetRange || env.google.defaultRange,
    templateSnapshot: snapshot.templateSnapshot,
    recipientSnapshot: snapshot.recipientSnapshot,
    scheduledAt,
    deliveryRangeStart: normalizedRange.deliveryRangeStart,
    deliveryRangeEnd: normalizedRange.deliveryRangeEnd,
    scheduleMode,
    scheduleInSameThread: Boolean(scheduleInSameThread),
    scheduledDays: normalizedDays,
    lastDeliveredOn: "",
    status: "scheduled",
    totalUsers: snapshot.recipientSnapshot.length,
    successCount: 0,
    failedCount: 0,
    attachments: template.channel === "email" 
      ? attachments.map(normalizeAttachment).filter(Boolean)
      : [],
    whatsappLinks: [],
    results: []
  });

  await campaign.save();
  return {
    ...campaign.toObject(),
    id: campaign._id.toString(),
    templateId: campaign.templateId.toString()
  };
}

export async function updateCampaign(campaignId, payload) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (campaign.status !== "scheduled") {
    throw new Error("Only scheduled campaigns can be edited");
  }

  const isReplyCampaign = campaign.replyMode === "selected_users_reply";

  const {
    name,
    templateId,
    scheduleMode,
    scheduledDays,
    scheduleInSameThread,
    deliveryRangeStart,
    deliveryRangeEnd,
    scheduledTime,
    attachments
  } = payload || {};

  const nextName = String(name ?? campaign.name).trim();
  if (!nextName) {
    throw new Error("name is required");
  }

  const nextTemplateId = String(templateId || campaign.templateId || "").trim();
  if (!nextTemplateId) {
    throw new Error("templateId is required");
  }

  const template = await Template.findById(nextTemplateId);
  if (!template) {
    throw new Error("Template not found");
  }

  if (!template.sheetUrl) {
    throw new Error("Template is missing sheetUrl. Update template before scheduling campaign");
  }

  if (isReplyCampaign && template.channel !== "email") {
    throw new Error("Reply campaigns can only use email templates");
  }

  const allowedModes = new Set(["all", "weekdays", "weekends", "custom"]);
  const nextScheduleMode = String(scheduleMode || campaign.scheduleMode || "all");
  if (!allowedModes.has(nextScheduleMode)) {
    throw new Error("Invalid scheduleMode");
  }

  const normalizedDays = normalizeScheduledDays(scheduledDays ?? campaign.scheduledDays ?? []);
  if (nextScheduleMode === "custom" && !normalizedDays.length) {
    throw new Error("Select at least one day for custom schedule");
  }

  const normalizedRange = normalizeDateRange({
    scheduledAt: deliveryRangeStart || campaign.deliveryRangeStart || campaign.scheduledAt,
    deliveryRangeStart: deliveryRangeStart ?? campaign.deliveryRangeStart,
    deliveryRangeEnd: deliveryRangeEnd ?? campaign.deliveryRangeEnd
  });
  assertRangeStartsTodayOrLater(normalizedRange);
  const snapshot = await buildCampaignSnapshot({
    campaignName: nextName,
    template,
    sheetUrl: template.sheetUrl,
    sheetRange: template.sheetRange || env.google.defaultRange
  });

  const nextScheduledTime = String(scheduledTime || "").trim() || String(campaign.scheduledAt || "").slice(11, 16) || "09:00";
  const nextScheduledAt = combineDateAndTime(normalizedRange.deliveryRangeStart, nextScheduledTime);

  campaign.name = nextName;
  campaign.templateId = template._id;
  campaign.channel = template.channel;
  campaign.sheetUrl = template.sheetUrl;
  campaign.sheetRange = template.sheetRange || env.google.defaultRange;
  campaign.templateSnapshot = snapshot.templateSnapshot;
  campaign.recipientSnapshot = snapshot.recipientSnapshot;
  campaign.deliveryRangeStart = normalizedRange.deliveryRangeStart;
  campaign.deliveryRangeEnd = normalizedRange.deliveryRangeEnd;
  campaign.scheduledAt = nextScheduledAt;
  campaign.scheduleMode = nextScheduleMode;
  campaign.scheduledDays = normalizedDays;
  campaign.scheduleInSameThread = template.channel === "email"
    ? Boolean(scheduleInSameThread)
    : false;
  campaign.totalUsers = snapshot.recipientSnapshot.length;

  if (Array.isArray(attachments)) {
    campaign.attachments = template.channel === "email"
      ? attachments.map(normalizeAttachment).filter(Boolean)
      : [];
  } else if (template.channel !== "email") {
    campaign.attachments = [];
  }

  campaign.updatedAt = new Date();
  await campaign.save();

  return {
    ...campaign.toObject(),
    id: campaign._id.toString(),
    templateId: campaign.templateId.toString()
  };
}

export async function createReplyCampaign(payload) {
  const {
    sourceCampaignId,
    name,
    body = "",
    templateId = "",
    scheduledAt,
    deliveryRangeStart,
    deliveryRangeEnd,
    scheduledTime = "09:00",
    scheduleMode = "all",
    scheduledDays = [],
    recipientIndexes = [],
    attachments = [],
    reuseOriginalAttachments = true
  } = payload;

  if (!sourceCampaignId) {
    throw new Error("sourceCampaignId is required");
  }

  const sourceCampaign = await Campaign.findById(sourceCampaignId).populate("templateId");
  if (!sourceCampaign) {
    throw new Error("Source campaign not found");
  }

  if (sourceCampaign.channel !== "email") {
    throw new Error("Replies are only supported for email campaigns");
  }

  const allowedModes = new Set(["all", "weekdays", "weekends", "custom"]);
  if (!allowedModes.has(scheduleMode)) {
    throw new Error("Invalid scheduleMode");
  }

  const normalizedDays = normalizeScheduledDays(scheduledDays);
  if (scheduleMode === "custom" && !normalizedDays.length) {
    throw new Error("Select at least one day for custom reply delivery");
  }

  const selectedIndexes = Array.isArray(recipientIndexes)
    ? [...new Set(recipientIndexes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0))]
    : [];

  if (!selectedIndexes.length) {
    throw new Error("Select at least one recipient to reply to");
  }

  const sourceResults = Array.isArray(sourceCampaign.results) ? sourceCampaign.results : [];
  const liveRows = (await fetchSheetRows(sourceCampaign.sheetUrl, sourceCampaign.sheetRange)).filter(shouldIncludeCampaignRecipient);
  const selectedRecipients = selectedIndexes
    .map((index) => {
      let baseRecipient = normalizeReplyRecipient(sourceResults[index], index);
      const liveRow = liveRows[index] && typeof liveRows[index] === "object" ? liveRows[index] : null;

      if (!baseRecipient && liveRow) {
        const { email } = identifyRecipient(liveRow);
        const normalizedEmail = String(email || "").trim();

        if (!normalizedEmail) {
          return null;
        }

        baseRecipient = {
          index,
          email: normalizedEmail,
          name: extractRecipientName(liveRow),
          emailMessageId: "",
          subject: "",
          row: liveRow
        };
      }

      if (!baseRecipient) {
        return null;
      }

      return {
        ...baseRecipient,
        row: {
          ...(liveRow || {}),
          ...baseRecipient.row,
          email: baseRecipient.email,
          name: baseRecipient.name || liveRow?.name || baseRecipient.row.name || ""
        }
      };
    })
    .filter(Boolean);

  if (!selectedRecipients.length) {
    throw new Error("No valid email recipients were found in the selected campaign rows");
  }

  let resolvedReplyBody = String(body || "").trim();
  let selectedReplyTemplateId = null;
  const normalizedTemplateId = String(templateId || "").trim();

  if (normalizedTemplateId) {
    const selectedTemplate = await Template.findById(normalizedTemplateId);
    if (!selectedTemplate) {
      throw new Error("Selected reply template not found");
    }

    if (selectedTemplate.channel !== "email") {
      throw new Error("Selected reply template must be an email template");
    }

    selectedReplyTemplateId = selectedTemplate._id;

    if (!resolvedReplyBody) {
      resolvedReplyBody = String(selectedTemplate.body || "").trim();
    }
  }

  if (!resolvedReplyBody) {
    throw new Error("Reply body is required");
  }

  const fallbackScheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  if (fallbackScheduledAt && Number.isNaN(fallbackScheduledAt.getTime())) {
    throw new Error("Invalid scheduledAt value");
  }

  const normalizedRange = normalizeDateRange({
    scheduledAt: fallbackScheduledAt || new Date(),
    deliveryRangeStart,
    deliveryRangeEnd
  });
  assertRangeStartsTodayOrLater(
    normalizedRange,
    "Reply deliveryRangeStart cannot be in the past"
  );
  const scheduledFor = combineDateAndTime(normalizedRange.deliveryRangeStart, scheduledTime);
  const replyDeliveryRangeStart = normalizedRange.deliveryRangeStart;
  const replyDeliveryRangeEnd = normalizedRange.deliveryRangeEnd;

  const inheritedAttachments = reuseOriginalAttachments && Array.isArray(sourceCampaign.attachments)
    ? sourceCampaign.attachments
    : [];
  const replyAttachments = [
    ...inheritedAttachments,
    ...attachments.map(normalizeAttachment).filter(Boolean)
  ];

  const replyCampaignName = String(name || "").trim() || `${sourceCampaign.name} - Reply`;

  const replyCampaign = new Campaign({
    name: replyCampaignName,
    templateId: sourceCampaign.templateId?._id || sourceCampaign.templateId,
    channel: "email",
    sheetUrl: sourceCampaign.sheetUrl,
    sheetRange: sourceCampaign.sheetRange,
    sourceCampaignId: sourceCampaign._id,
    sourceResultIndexes: selectedRecipients.map((recipient) => recipient.index),
    replyTemplateId: selectedReplyTemplateId,
    replyBody: resolvedReplyBody,
    replySourceSubject: String(sourceCampaign.templateId?.subject || sourceCampaign.name || "").trim(),
    replyRecipients: selectedRecipients.map((recipient) => ({
      index: recipient.index,
      email: recipient.email,
      name: recipient.name || "",
      emailMessageId: recipient.emailMessageId || "",
      row: recipient.row || {}
    })),
    replyMode: "selected_users_reply",
    scheduledAt: scheduledFor,
    deliveryRangeStart: replyDeliveryRangeStart,
    deliveryRangeEnd: replyDeliveryRangeEnd,
    scheduleMode,
    scheduledDays: normalizedDays,
    status: "scheduled",
    totalUsers: selectedRecipients.length,
    successCount: 0,
    failedCount: 0,
    attachments: replyAttachments,
    whatsappLinks: [],
    results: []
  });

  await replyCampaign.save();

  if (scheduledFor.getTime() <= Date.now()) {
    return runCampaign(replyCampaign._id, { force: true });
  }

  return replyCampaign.toObject();
}

async function runReplyCampaign(campaign) {
  const sourceCampaign = campaign.sourceCampaignId
    ? await Campaign.findById(campaign.sourceCampaignId).populate("templateId")
    : null;

  const baseSubject =
    String(campaign.replySourceSubject || "").trim() ||
    String(sourceCampaign?.templateId?.subject || sourceCampaign?.name || campaign.name || "").trim();
  const baseBody = String(campaign.replyBody || "").trim();

  if (!baseBody) {
    throw new Error("Reply campaign is missing body content");
  }

  const recipients = Array.isArray(campaign.replyRecipients) ? campaign.replyRecipients : [];
  campaign.totalUsers = recipients.length;
  campaign.successCount = 0;
  campaign.failedCount = 0;
  campaign.results = [];

  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index] || {};
    const row = recipient.row && typeof recipient.row === "object" ? recipient.row : {};
    const email = String(recipient.email || "").trim();
    const inReplyTo = String(recipient.emailMessageId || "").trim();
    const references = inReplyTo ? [inReplyTo] : [];
    const renderedSubject = renderTemplate(baseSubject, row);
    const renderedMessage = renderTemplate(baseBody, row);
    const renderedHtmlMessage = formatRichTextEmailHtml(renderedMessage);
    const renderedTextMessage = htmlToPlainText(renderedMessage);

    let emailResult = null;
    let emailError = "";

    try {
      if (!email) {
        throw new Error("Missing email address");
      }

      emailResult = await sendEmail({
        to: email,
        subject: renderedSubject,
        text: renderedTextMessage,
        html: renderedHtmlMessage,
        attachments: Array.isArray(campaign.attachments) ? campaign.attachments : [],
        inReplyTo,
        references
      });

      campaign.successCount += 1;
    } catch (error) {
      emailError = error.message;
      campaign.failedCount += 1;
    }

    campaign.results.push({
      ...row,
      name:
        String(recipient.name || "").trim() ||
        row.name ||
        row.Name ||
        row.fullName ||
        row.FullName ||
        row.firstName ||
        row.FirstName ||
        "",
      email,
      channel: "email",
      subject: renderedSubject,
      message: renderedMessage,
      emailStatus: emailResult ? "sent" : "skipped",
      emailMessageId: emailResult?.messageId || "",
      emailMode: emailResult?.mode || "direct",
      emailInReplyTo: inReplyTo,
      emailReferences: references,
      sourceCampaignId: campaign.sourceCampaignId ? campaign.sourceCampaignId.toString() : "",
      sourceResultIndex: Number.isInteger(recipient.index) ? recipient.index : index,
      emailAttachments: (Array.isArray(emailResult?.attachments) ? emailResult.attachments : campaign.attachments || [])
        .map(summarizeAttachment)
        .filter(Boolean),
      error: emailError
    });

    if ((index + 1) % 25 === 0 || index === recipients.length - 1) {
      campaign.updatedAt = new Date();
      await campaign.save();
    }
  }

  campaign.completedAt = new Date();
  campaign.lastDeliveredOn = toDayKey(campaign.completedAt);
  campaign.status = campaign.failedCount > 0 && campaign.successCount > 0
    ? "partial_completed"
    : campaign.failedCount > 0 && campaign.successCount === 0
    ? "failed"
    : "completed";
  campaign.updatedAt = new Date();
  await campaign.save();

  return campaign.toObject();
}

export async function getCampaignSheetColumns(campaignId) {
  const campaign = await Campaign.findById(campaignId);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (!campaign.sheetUrl) {
    return [];
  }

  return fetchSheetColumns(campaign.sheetUrl, campaign.sheetRange);
}

export async function previewSheetColumns(payload = {}) {
  const { sheetUrl, sheetRange = env.google.defaultRange } = payload;

  if (!sheetUrl) {
    throw new Error("sheetUrl is required");
  }

  return fetchSheetColumns(sheetUrl, sheetRange);
}

export async function listCampaigns() {
  const campaigns = await Campaign.find().sort({ createdAt: -1 }).populate("templateId");
  return campaigns.map((campaign) => {
    const channel = campaign.channel || campaign.templateSnapshot?.channel || campaign.templateId?.channel || "email";
    const templateId = campaign.templateId?._id
      ? campaign.templateId._id.toString()
      : campaign.templateId
        ? String(campaign.templateId)
        : null;

    return {
      ...campaign.toObject(),
      id: campaign._id.toString(),
      templateId,
      channel,
      status: campaign.status === "running" ? "processing" : campaign.status
    };
  });
}

export async function getCampaignById(campaignId) {
  const campaign = await Campaign.findById(campaignId).populate("templateId");
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const channel = campaign.channel || campaign.templateSnapshot?.channel || campaign.templateId?.channel || "email";
  const replyRecipients = await buildReplyRecipients(campaign);
  const templateId = campaign.templateId?._id
    ? campaign.templateId._id.toString()
    : campaign.templateId
      ? String(campaign.templateId)
      : null;

  return {
    ...campaign.toObject(),
    id: campaign._id.toString(),
    templateId,
    channel,
    replyRecipients
  };
}

export async function runCampaign(campaignId, options = {}) {
  const { force = false } = options;
  const campaign = await Campaign.findById(campaignId).populate("templateId");

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (campaign.status === "terminated") {
    throw new Error("Campaign is terminated");
  }

  if (campaign.status === "completed" || campaign.status === "range_completed") {
    return campaign.toObject();
  }

  if (!force && isCampaignRangeExpired(campaign, new Date())) {
    campaign.status = "range_completed";
    campaign.completedAt = new Date();
    campaign.updatedAt = new Date();
    await campaign.save();
    return campaign.toObject();
  }

  const now = new Date();

  if (
    !force &&
    (!isCampaignInRange(campaign, now) ||
      !isCampaignAllowedToday(campaign, now) ||
      hasDeliveredToday(campaign, now) ||
      !isScheduledTimeReached(campaign, now))
  ) {
    return campaign.toObject();
  }

  if (campaign.status === "running" && !force) {
    const startedAtTs = campaign.startedAt ? new Date(campaign.startedAt).getTime() : 0;
    const staleForMs = startedAtTs ? Date.now() - startedAtTs : Number.MAX_SAFE_INTEGER;

    if (staleForMs < 5 * 60 * 1000) {
      return campaign.toObject();
    }

    campaign.status = "scheduled";
  }

  if (!force && !isCampaignAllowedToday(campaign, new Date())) {
    return campaign.toObject();
  }

  if (campaign.replyMode === "selected_users_reply") {
    campaign.status = "running";
    campaign.startedAt = new Date();
    campaign.updatedAt = new Date();
    await campaign.save();

    try {
      return await runReplyCampaign(campaign);
    } catch (error) {
      campaign.status = "failed";
      campaign.completedAt = new Date();
      if (!Array.isArray(campaign.results)) {
        campaign.results = [];
      }
      campaign.results.push({
        error: error.message,
        emailStatus: "skipped"
      });
      campaign.updatedAt = new Date();
      await campaign.save();
      return campaign.toObject();
    }
  }

  const template = campaign.templateId;
  const snapshotTemplate = campaign.templateSnapshot && typeof campaign.templateSnapshot === "object"
    ? campaign.templateSnapshot
    : null;
  const channel = campaign.channel || snapshotTemplate?.channel || template?.channel || "email";
  const subjectTemplate = String(snapshotTemplate?.subject ?? template?.subject ?? campaign.name ?? "").trim();
  const bodyTemplate = String(snapshotTemplate?.body ?? template?.body ?? "").trim();

  if (!bodyTemplate) {
    throw new Error("Campaign is missing message body snapshot");
  }

  campaign.channel = channel;
  campaign.status = "running";
  campaign.startedAt = new Date();
  campaign.updatedAt = new Date();
  await campaign.save();

  try {
    const shouldThreadEmails = channel === "email" && Boolean(campaign.scheduleInSameThread);
    const emailThreadMap = new Map(
      (Array.isArray(campaign.emailThreads) ? campaign.emailThreads : [])
        .map((entry) => {
          const recipient = normalizeEmailRecipient(entry?.recipient);
          const messageId = String(entry?.lastMessageId || "").trim();
          if (!recipient || !messageId) {
            return null;
          }

          return [recipient, messageId];
        })
        .filter(Boolean)
    );

    const eligibleRows = Array.isArray(campaign.recipientSnapshot) ? campaign.recipientSnapshot : [];

    if (!eligibleRows.length) {
      throw new Error("Campaign snapshot is missing recipient data");
    }

    campaign.totalUsers = eligibleRows.length;
    campaign.successCount = 0;
    campaign.failedCount = 0;
    campaign.whatsappLinks = [];
    campaign.results = [];

    for (let index = 0; index < eligibleRows.length; index += 1) {
      if (index % 10 === 0) {
        const latestCampaign = await Campaign.findById(campaign._id).select("status");
        if (latestCampaign?.status === "terminated") {
          campaign.status = "terminated";
          campaign.completedAt = new Date();
          break;
        }
      }

      const row = eligibleRows[index];
      const { email, phone } = identifyRecipient(row);
      const recipientName = extractRecipientName(row);
      const subject = renderTemplate(subjectTemplate || campaign.name, row);
      const message = renderTemplate(bodyTemplate, row);
      const messageHtml = formatRichTextEmailHtml(message);
      const messageText = htmlToPlainText(message);
      const whatsappLink = channel === "whatsapp" ? generateWhatsAppLink(phone, message) : "";
      const campaignAttachments = Array.isArray(campaign.attachments) ? campaign.attachments : [];
      const normalizedRecipientEmail = normalizeEmailRecipient(email);
      const inReplyTo = shouldThreadEmails ? emailThreadMap.get(normalizedRecipientEmail) || "" : "";
      const references = inReplyTo ? [inReplyTo] : [];

      let emailResult = null;
      let emailError = "";

      try {
        if (channel === "email" && email) {
          emailResult = await sendEmail({
            to: email,
            subject,
            text: messageText,
            html: messageHtml,
            attachments: campaignAttachments,
            inReplyTo,
            references
          });

          campaign.successCount += 1;

          if (shouldThreadEmails && normalizedRecipientEmail && emailResult?.messageId) {
            emailThreadMap.set(normalizedRecipientEmail, String(emailResult.messageId));
          }
        } else if (channel === "whatsapp" && whatsappLink) {
          campaign.successCount += 1;
        } else {
          campaign.failedCount += 1;
          emailError = channel === "whatsapp" ? "Missing phone number" : "Missing email address";
        }

        if (channel === "email" && index < eligibleRows.length - 1) {
          await sleep(randomDelay());
        }
      } catch (error) {
        emailError = error.message;
        campaign.failedCount += 1;
      }

      if (channel === "whatsapp") {
        campaign.whatsappLinks.push({
          name: recipientName,
          email,
          phone: normalizePhone(phone),
          whatsappLink,
          message
        });
      }

      campaign.results.push({
        ...row,
        name: recipientName,
        email,
        phone: normalizePhone(phone),
        channel,
        subject,
        message,
        emailStatus: channel === "email" ? (emailResult ? "sent" : "skipped") : "skipped",
        emailMessageId: emailResult?.messageId || "",
        emailMode: emailResult?.mode || "skipped",
        emailInReplyTo: inReplyTo,
        emailReferences: references,
        emailAttachments: Array.isArray(emailResult?.attachments)
          ? emailResult.attachments.map(summarizeAttachment).filter(Boolean)
          : campaignAttachments.map(summarizeAttachment).filter(Boolean),
        whatsappLink,
        whatsappStatus: channel === "whatsapp" && whatsappLink ? "ready" : "skipped",
        error: emailError
      });

      // Persist in batches to avoid slowing down delivery with per-recipient writes.
      if ((index + 1) % 25 === 0 || index === eligibleRows.length - 1) {
        campaign.updatedAt = new Date();
        await campaign.save();
      }
    }

    if (shouldThreadEmails) {
      campaign.emailThreads = [...emailThreadMap.entries()].map(([recipient, lastMessageId]) => ({
        recipient,
        lastMessageId,
        updatedAt: new Date()
      }));
    }

    if (campaign.status !== "terminated") {
      const now = new Date();
      campaign.lastDeliveredOn = toDayKey(now);
      campaign.updatedAt = now;

      if (isCampaignRangeExpired(campaign, now) || !hasFutureEligibleDeliveryDay(campaign, now)) {
        campaign.completedAt = now;
        campaign.status = "range_completed";
      } else {
        campaign.status = "scheduled";
      }
    }
  } catch (error) {
    campaign.status = "failed";
    campaign.completedAt = new Date();
    if (!Array.isArray(campaign.results)) {
      campaign.results = [];
    }
    campaign.results.push({
      error: error.message,
      emailStatus: "skipped"
    });
  }

  campaign.updatedAt = new Date();
  await campaign.save();

  return campaign.toObject();
}

export async function runDueCampaigns() {
  const now = Date.now();
  const dueCampaigns = await Campaign.find({
    status: "scheduled",
    scheduledAt: { $lte: new Date(now) }
  });

  const nowDate = new Date(now);
  const missedCampaigns = dueCampaigns.filter((campaign) => shouldMarkDeliveryMissed(campaign, nowDate));

  for (const campaign of missedCampaigns) {
    await markCampaignMissedForToday(campaign, nowDate);
  }

  const activeDueCampaigns = dueCampaigns.filter(
    (campaign) => !missedCampaigns.some((missedCampaign) => String(missedCampaign._id) === String(campaign._id))
  );

  const eligibleCampaigns = activeDueCampaigns.filter((campaign) => {
    if (isCampaignRangeExpired(campaign, nowDate)) {
      return false;
    }

    if (!isCampaignInRange(campaign, nowDate)) {
      return false;
    }

    if (!isCampaignAllowedToday(campaign, nowDate)) {
      return false;
    }

    if (!isScheduledTimeReached(campaign, nowDate)) {
      return false;
    }

    return !hasDeliveredToday(campaign, nowDate);
  });

  const expiredCampaigns = activeDueCampaigns.filter((campaign) => isCampaignRangeExpired(campaign, nowDate));
  for (const campaign of expiredCampaigns) {
    campaign.status = "range_completed";
    campaign.completedAt = nowDate;
    campaign.updatedAt = nowDate;
    await campaign.save();
  }

  const exhaustedCampaigns = activeDueCampaigns.filter(
    (campaign) =>
      campaign.status === "scheduled" &&
      hasDeliveredToday(campaign, nowDate) &&
      !hasFutureEligibleDeliveryDay(campaign, nowDate)
  );

  for (const campaign of exhaustedCampaigns) {
    campaign.status = "range_completed";
    campaign.completedAt = nowDate;
    campaign.updatedAt = nowDate;
    await campaign.save();
  }

  const results = [];
  for (const campaign of eligibleCampaigns) {
    results.push(await runCampaign(campaign._id));
  }

  return results;
}

export async function manualRunCampaigns(campaignId) {
  if (campaignId) {
    return [await runCampaign(campaignId, { force: true })];
  }

  const dueCampaigns = await Campaign.find({ status: "scheduled" });
  const results = [];

  for (const campaign of dueCampaigns) {
    results.push(await runCampaign(campaign._id));
  }

  return results;
}

export async function getWhatsAppLinks(campaignId) {
  if (campaignId) {
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    return campaign.whatsappLinks;
  }

  const campaigns = await Campaign.find();
  return campaigns.flatMap((campaign) =>
    campaign.whatsappLinks.map((item) => ({
      campaignId: campaign._id.toString(),
      campaignName: campaign.name,
      ...item
    }))
  );
}

export async function updateWhatsAppJobStatus(campaignId, jobIndex, status, error = "") {
  const allowedStatuses = new Set(["ready", "sent", "skipped"]);
  if (!allowedStatuses.has(status)) {
    throw new Error("Invalid WhatsApp status");
  }

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const index = Number(jobIndex);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Invalid job index");
  }

  const results = Array.isArray(campaign.results) ? campaign.results : [];
  const result = results[index];
  if (!result) {
    throw new Error("WhatsApp job not found");
  }

  const channel = result.channel || campaign.channel || "email";
  if (channel !== "whatsapp") {
    throw new Error("Job is not a WhatsApp message");
  }

  result.whatsappStatus = status;
  result.error = error || "";

  campaign.updatedAt = new Date();
  await campaign.save();

  return result;
}

export function startScheduler() {
  if (schedulerState.started) {
    return;
  }

  schedulerState.started = true;
  schedulerState.startedAt = new Date();
  // Run every 5 seconds to reduce visibility delay for newly due campaigns.
  schedulerState.task = cron.schedule("*/5 * * * * *", () => {
    runDueCampaigns().catch((error) => {
      console.error("Scheduled run failed:", error.message);
    });
  });

  runDueCampaigns().catch((error) => {
    console.error("Initial scheduled run failed:", error.message);
  });
}

export function stopScheduler() {
  if (schedulerState.task) {
    schedulerState.task.stop();
  }
  schedulerState.started = false;
  schedulerState.task = null;
  schedulerState.startedAt = null;
}

export async function deleteCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const campaignName = campaign.name;
  const campaignChannel = campaign.channel;

  await Campaign.findByIdAndDelete(campaignId);

  return {
    message: `${campaignChannel} campaign "${campaignName}" deleted successfully`,
    deletedId: campaignId
  };
}

export async function terminateCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (campaign.status === "terminated") {
    return {
      message: `Campaign "${campaign.name}" is already terminated`,
      campaign: campaign.toObject()
    };
  }

  campaign.status = "terminated";
  campaign.completedAt = new Date();
  campaign.updatedAt = new Date();
  await campaign.save();

  return {
    message: `Campaign "${campaign.name}" terminated successfully`,
    campaign: campaign.toObject()
  };
}
