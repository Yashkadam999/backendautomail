import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema({
  filename: String,
  contentType: String,
  content: String
});

const whatsappLinkSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  whatsappLink: String,
  message: String
});

const emailThreadSchema = new mongoose.Schema({
  recipient: String,
  lastMessageId: String,
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const missedDeliverySchema = new mongoose.Schema({
  dayKey: String,
  scheduledFor: Date,
  failedCount: Number,
  reason: String,
  recordedAt: {
    type: Date,
    default: Date.now
  }
});

const resultSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  channel: String,
  subject: String,
  message: String,
  emailStatus: String,
  emailMessageId: String,
  emailMode: String,
  emailInReplyTo: String,
  emailReferences: [String],
  sourceCampaignId: String,
  sourceResultIndex: Number,
  emailAttachments: [
    {
      filename: String,
      contentType: String
    }
  ],
  whatsappLink: String,
  whatsappStatus: String,
  error: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const campaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      required: true
    },
    channel: {
      type: String,
      enum: ["email", "whatsapp"],
      default: "email"
    },
    sheetUrl: {
      type: String,
      required: true
    },
    sheetRange: {
      type: String,
      default: "A1:Z1000"
    },
    templateSnapshot: {
      name: String,
      channel: String,
      subject: String,
      body: String,
      sheetUrl: String,
      sheetRange: String,
      capturedAt: Date
    },
    recipientSnapshot: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    sourceCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null
    },
    sourceResultIndexes: {
      type: [Number],
      default: []
    },
    replyTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      default: null
    },
    replyBody: {
      type: String,
      default: ""
    },
    replySourceSubject: {
      type: String,
      default: ""
    },
    replyRecipients: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    replyMode: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      enum: [
        "scheduled",
        "running",
        "processing",
        "completed",
        "failed",
        "partial_completed",
        "terminated",
        "range_completed"
      ],
      default: "scheduled"
    },
    scheduledAt: Date,
    deliveryRangeStart: Date,
    deliveryRangeEnd: Date,
    scheduleMode: {
      type: String,
      enum: ["all", "weekdays", "weekends", "custom"],
      default: "all"
    },
    scheduleInSameThread: {
      type: Boolean,
      default: false
    },
    scheduledDays: {
      type: [Number],
      default: []
    },
    startedAt: Date,
    completedAt: Date,
    lastDeliveredOn: {
      type: String,
      default: ""
    },
    totalUsers: {
      type: Number,
      default: 0
    },
    successCount: {
      type: Number,
      default: 0
    },
    failedCount: {
      type: Number,
      default: 0
    },
    missedDeliveries: {
      type: [missedDeliverySchema],
      default: []
    },
    emailThreads: {
      type: [emailThreadSchema],
      default: []
    },
    attachments: [attachmentSchema],
    whatsappLinks: [whatsappLinkSchema],
    results: [resultSchema]
  },
  {
    timestamps: true
  }
);

export const Campaign = mongoose.model("Campaign", campaignSchema);
