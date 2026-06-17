import {
  createCampaign,
  createReplyCampaign,
  createTemplate,
  deleteCampaign,
  deleteTemplate,
  getCampaignById,
  getCampaignSheetColumns,
  getWhatsAppLinks,
  listCampaigns,
  listTemplates,
  manualRunCampaigns,
  previewSheetColumns,
  terminateCampaign,
  updateCampaign,
  updateTemplate,
  updateWhatsAppJobStatus
} from "../services/campaignService.js";

function normalizeTemplate(template) {
  return {
    ...template,
    _id: template.id
  };
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  return {
    filename: attachment.filename || "attachment",
    contentType: attachment.contentType || "application/octet-stream"
  };
}

function normalizeReferenceId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    if (value._id && typeof value._id.toString === "function") {
      return value._id.toString();
    }

    if (value.id && typeof value.id.toString === "function") {
      return value.id.toString();
    }
  }

  if (typeof value.toString === "function") {
    return value.toString();
  }

  return null;
}

function normalizeCampaign(campaign) {
  const results = Array.isArray(campaign.results) ? campaign.results : [];
  const attachments = Array.isArray(campaign.attachments) ? campaign.attachments.map(normalizeAttachment).filter(Boolean) : [];
  const missedDeliveries = Array.isArray(campaign.missedDeliveries)
    ? campaign.missedDeliveries
        .map((item) => ({
          dayKey: item.dayKey || "",
          scheduledFor: item.scheduledFor || null,
          failedCount: Number(item.failedCount || 0),
          reason: item.reason || "",
          recordedAt: item.recordedAt || null
        }))
        .sort((a, b) => new Date(b.recordedAt || 0).getTime() - new Date(a.recordedAt || 0).getTime())
    : [];

  // Derive message counts from per-recipient statuses when available.
  // This keeps campaign details in sync with WhatsApp ready/sent/skipped updates.
  let totalMessages = campaign.totalUsers || 0;
  let sentMessages = campaign.successCount || 0;
  let failedMessages = campaign.failedCount || 0;
  let queuedMessages = campaign.status === "scheduled" ? totalMessages : 0;

  if (results.length) {
    totalMessages = results.length;
    sentMessages = 0;
    failedMessages = 0;
    queuedMessages = 0;

    results.forEach((result) => {
      const channel = result.channel || campaign.channel || "email";

      if (channel === "whatsapp") {
        const whatsappStatus = result.whatsappStatus || "ready";

        if (whatsappStatus === "sent") {
          sentMessages += 1;
        } else if (whatsappStatus === "skipped") {
          failedMessages += 1;
        } else {
          queuedMessages += 1;
        }

        return;
      }

      if (result.emailStatus === "sent") {
        sentMessages += 1;
      } else if (result.error) {
        failedMessages += 1;
      } else {
        queuedMessages += 1;
      }
    });
  }

  if (campaign.status === "terminated" || campaign.status === "range_completed") {
    queuedMessages = 0;
  }

  return {
    ...campaign,
    _id: campaign.id,
    sourceCampaignId: normalizeReferenceId(campaign.sourceCampaignId),
    totalMessages,
    queuedMessages,
    sentMessages,
    failedMessages,
    attachments,
    missedDeliveries,
    channel: campaign.channel || "email"
  };
}

function normalizeRecentJobs(campaign) {
  const results = campaign.results || [];
  return results.slice(-25).map((result, index) => {
    const channel = result.channel || campaign.channel || "email";
    const isWhatsApp = channel === "whatsapp";

    let status = "failed";
    if (isWhatsApp) {
      if (result.whatsappStatus === "sent") {
        status = "sent";
      } else if (result.whatsappStatus === "ready") {
        status = "ready";
      } else {
        status = result.error ? "failed" : "skipped";
      }
    } else {
      status = result.emailStatus === "sent" ? "sent" : result.error ? "failed" : "skipped";
    }

    const explicitName =
      result.name ||
      result.Name ||
      result.fullName ||
      result.FullName ||
      result.firstName ||
      result.FirstName ||
      "";

    const derivedNameEntry = Object.entries(result).find(([key, value]) => {
      if (!value || typeof value !== "string") {
        return false;
      }

      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      return normalizedKey.includes("name") && !normalizedKey.includes("campaign");
    });

    const recipientName = explicitName || derivedNameEntry?.[1] || "Unknown";

    const recipientContact = isWhatsApp
      ? result.phone || result.Phone || result.mobile || result.whatsapp || result.email || ""
      : result.email || result.Email || result.phone || result.Phone || "";

    const recipient = recipientContact ? `${recipientName} (${recipientContact})` : recipientName;

    return {
      _id: `${campaign.id}-${index}`,
      recipient,
      recipientName,
      recipientContact,
      channel,
      status,
      scheduledFor: campaign.scheduledAt,
      error: result.error || ""
    };
  });
}

export async function createTemplateHandler(req, res) {
  try {
    const template = await createTemplate(req.body);
    res.status(201).json(normalizeTemplate(template));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function listTemplatesHandler(_req, res) {
  try {
    const templates = await listTemplates();
    res.json(templates.map(normalizeTemplate));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function updateTemplateHandler(req, res) {
  try {
    const template = await updateTemplate(req.params.templateId, req.body || {});
    res.json(normalizeTemplate(template));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function deleteTemplateHandler(req, res) {
  try {
    const result = await deleteTemplate(req.params.templateId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function createCampaignHandler(req, res) {
  try {
    const campaign = await createCampaign(req.body);
    const normalized = normalizeCampaign(campaign);
    res.status(201).json({ campaign: normalized, queuedCount: normalized.totalMessages || 0 });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function updateCampaignHandler(req, res) {
  try {
    const campaign = await updateCampaign(req.params.campaignId, req.body || {});
    const normalized = normalizeCampaign(campaign);
    res.json({ campaign: normalized, queuedCount: normalized.totalMessages || 0 });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function listCampaignsHandler(_req, res) {
  try {
    const campaigns = await listCampaigns();
    res.json(campaigns.map(normalizeCampaign));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function campaignStatusHandler(req, res) {
  try {
    const campaign = await getCampaignById(req.params.campaignId);
    res.json({ campaign: normalizeCampaign(campaign), recentJobs: normalizeRecentJobs(campaign) });
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
}

export async function campaignColumnsHandler(req, res) {
  try {
    const columns = await getCampaignSheetColumns(req.params.campaignId);
    res.json({ campaignId: req.params.campaignId, columns });
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
}

export async function previewSheetColumnsHandler(req, res) {
  try {
    const columns = await previewSheetColumns(req.body || {});
    res.json({ columns });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function scheduleCampaignHandler(req, res) {
  try {
    const campaign = await createCampaign(req.body);
    const normalized = normalizeCampaign(campaign);
    res.status(201).json({ campaign: normalized, queuedCount: normalized.totalMessages || 0 });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function replyCampaignHandler(req, res) {
  try {
    const campaignId = req.params.campaignId;
    const campaign = await createReplyCampaign({
      ...req.body,
      sourceCampaignId: campaignId
    });
    const normalized = normalizeCampaign(campaign);
    res.status(201).json({ campaign: normalized, queuedCount: normalized.totalMessages || 0 });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function runCampaignHandler(req, res) {
  try {
    const campaignId = req.query.campaignId || req.body?.campaignId;
    const results = await manualRunCampaigns(campaignId);
    res.json({
      message: campaignId ? "Campaign run completed" : "Pending campaigns processed",
      results
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function whatsappLinksHandler(req, res) {
  try {
    const campaignId = req.query.campaignId;
    const links = await getWhatsAppLinks(campaignId);
    res.json({
      campaignId: campaignId || null,
      results: links
    });
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
}

export async function updateWhatsAppJobStatusHandler(req, res) {
  try {
    const { campaignId, jobIndex } = req.params;
    const { status, error = "" } = req.body || {};

    const job = await updateWhatsAppJobStatus(campaignId, jobIndex, status, error);
    res.json({ message: "WhatsApp job status updated", job });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function deleteCampaignHandler(req, res) {
  try {
    const campaignId = req.params.campaignId;
    const result = await deleteCampaign(campaignId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
}

export async function terminateCampaignHandler(req, res) {
  try {
    const campaignId = req.params.campaignId;
    const result = await terminateCampaign(campaignId);
    res.json(result);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
}
