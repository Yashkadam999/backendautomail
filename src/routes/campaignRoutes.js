import { Router } from "express";
import {
  campaignStatusHandler,
  campaignColumnsHandler,
  previewSheetColumnsHandler,
  createCampaignHandler,
  updateCampaignHandler,
  createTemplateHandler,
  updateTemplateHandler,
  deleteTemplateHandler,
  deleteCampaignHandler,
  terminateCampaignHandler,
  listCampaignsHandler,
  listTemplatesHandler,
  runCampaignHandler,
  scheduleCampaignHandler,
  replyCampaignHandler,
  updateWhatsAppJobStatusHandler,
  whatsappLinksHandler
} from "../controllers/campaignController.js";

const router = Router();

router.post("/templates", createTemplateHandler);
router.get("/templates", listTemplatesHandler);
router.put("/templates/:templateId", updateTemplateHandler);
router.delete("/templates/:templateId", deleteTemplateHandler);
router.post("/campaigns", createCampaignHandler);
router.post("/campaigns/queue", createCampaignHandler);
router.put("/campaigns/:campaignId", updateCampaignHandler);
router.post("/sheet-columns", previewSheetColumnsHandler);
router.post("/campaigns/:campaignId/reply", replyCampaignHandler);
router.get("/campaigns/:campaignId/columns", campaignColumnsHandler);
router.delete("/campaigns/:campaignId", deleteCampaignHandler);
router.post("/campaigns/:campaignId/terminate", terminateCampaignHandler);
router.get("/campaigns", listCampaignsHandler);
router.get("/campaigns/:campaignId/status", campaignStatusHandler);
router.post("/schedule", scheduleCampaignHandler);
router.get("/run", runCampaignHandler);
router.get("/whatsapp-links", whatsappLinksHandler);
router.post("/campaigns/:campaignId/whatsapp-jobs/:jobIndex/status", updateWhatsAppJobStatusHandler);

export default router;
