import { randomUUID } from "crypto";
import { Campaign } from "../models/Campaign.js";
import { Template } from "../models/Template.js";

export async function loadState() {
  try {
    const templates = await Template.find().sort({ createdAt: -1 });
    const campaigns = await Campaign.find().sort({ createdAt: -1 }).populate("templateId");

    return {
      templates: templates.map((template) => ({
        ...template.toObject(),
        id: template._id.toString()
      })),
      campaigns: campaigns.map((campaign) => ({
        ...campaign.toObject(),
        id: campaign._id.toString(),
        templateId: campaign.templateId?._id
          ? campaign.templateId._id.toString()
          : campaign.templateId
            ? String(campaign.templateId)
            : null
      }))
    };
  } catch (error) {
    console.error("Error loading state from MongoDB:", error);
    return {
      templates: [],
      campaigns: []
    };
  }
}

export async function saveState(state) {
  // This function is kept for backwards compatibility but not needed with MongoDB
  // MongoDB operations update documents directly
  return state;
}

export function createId() {
  return randomUUID();
}
