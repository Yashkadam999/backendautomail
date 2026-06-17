import mongoose from "mongoose";

const templateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: false
    },
    channel: {
      type: String,
      required: true,
      enum: ["email", "whatsapp"],
      default: "email"
    },
    subject: {
      type: String,
      default: ""
    },
    body: {
      type: String,
      required: true
    },
    sheetUrl: {
      type: String,
      required: true
    },
    sheetRange: {
      type: String,
      default: "A1:Z1000"
    },
    variables: {
      type: [String],
      default: []
    }
  },
  {
    timestamps: true
  }
);

export const Template = mongoose.model("Template", templateSchema);
