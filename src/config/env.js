import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT || 5000),
  appName: process.env.APP_NAME || "Skeduloo Message Scheduling",
  mongodb: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017/skeduloo-message-scheduling",
    retryWrites: true,
    connectTimeoutMS: 10000
  },
  gmail: {
    user: process.env.GMAIL_USER || "",
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
    fromName: process.env.GMAIL_FROM_NAME || "Skeduloo Notifications"
  },
  google: {
    apiKey: process.env.GOOGLE_API_KEY || "",
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    defaultRange: process.env.GOOGLE_SHEET_RANGE || "A1:Z1000"
  }
};
