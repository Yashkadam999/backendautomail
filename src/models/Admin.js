import mongoose from "mongoose";

const adminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    gmailUser: {
      type: String,
      default: "",
      trim: true
    },
    gmailAppPassword: {
      type: String,
      default: "",
      trim: true
    },
    gmailFromName: {
      type: String,
      default: "Skeduloo Notifications",
      trim: true
    },
    authTokenHash: {
      type: String,
      default: ""
    },
    authTokenExpiresAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

export const Admin = mongoose.model("Admin", adminSchema);
