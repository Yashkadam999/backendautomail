import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";
import { Admin } from "../models/Admin.js";

const TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envFilePath = path.resolve(__dirname, "../../.env");

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hashed = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hashed}`;
}

function verifyPassword(password, storedHash = "") {
  const [salt, existingHash] = String(storedHash).split(":");
  if (!salt || !existingHash) {
    return false;
  }

  const calculatedHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const existingBuffer = Buffer.from(existingHash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (existingBuffer.length !== calculatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(existingBuffer, calculatedBuffer);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateAuthToken() {
  return crypto.randomBytes(48).toString("hex");
}

function formatEnvValue(value = "") {
  const raw = String(value).replace(/\r?\n/g, " ").trim();
  if (!raw) {
    return "";
  }

  if (/[^a-zA-Z0-9_./@:-]/.test(raw)) {
    return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }

  return raw;
}

function upsertEnvVariable(content, key, value) {
  const line = `${key}=${formatEnvValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}${line}\n`;
}

async function persistGmailConfigToEnv({ gmailUser, gmailAppPassword, gmailFromName }) {
  let fileContent = "";

  try {
    fileContent = await fs.readFile(envFilePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let updated = upsertEnvVariable(fileContent, "GMAIL_USER", gmailUser);
  updated = upsertEnvVariable(updated, "GMAIL_APP_PASSWORD", gmailAppPassword);
  updated = upsertEnvVariable(updated, "GMAIL_FROM_NAME", gmailFromName);

  await fs.writeFile(envFilePath, updated, "utf8");
}

function applyRuntimeGmailConfig({ gmailUser, gmailAppPassword, gmailFromName }) {
  env.gmail.user = gmailUser;
  env.gmail.appPassword = gmailAppPassword;
  env.gmail.fromName = gmailFromName;

  process.env.GMAIL_USER = gmailUser;
  process.env.GMAIL_APP_PASSWORD = gmailAppPassword;
  process.env.GMAIL_FROM_NAME = gmailFromName;
}

function validateSignupPayload(payload) {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  const gmailUser = normalizeEmail(payload.gmailUser);
  const gmailAppPassword = String(payload.gmailAppPassword || "").trim();
  const gmailFromName = String(payload.gmailFromName || "").trim() || "Skeduloo Notifications";

  if (!email || !email.includes("@")) {
    throw createError("Valid admin email is required", 400);
  }

  if (password.length < 6) {
    throw createError("Password must be at least 6 characters long", 400);
  }

  if (!gmailUser || !gmailUser.includes("@")) {
    throw createError("Valid GMAIL_USER is required", 400);
  }

  if (!gmailAppPassword) {
    throw createError("GMAIL_APP_PASSWORD is required", 400);
  }

  return {
    email,
    password,
    gmailUser,
    gmailAppPassword,
    gmailFromName
  };
}

function issueSessionForAdmin(admin) {
  const token = generateAuthToken();
  admin.authTokenHash = hashToken(token);
  admin.authTokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
  return token;
}

export async function getSetupStatus() {
  const adminCount = await Admin.countDocuments({});
  return {
    isSetupComplete: adminCount > 0
  };
}

export async function signupAdmin(payload) {
  const existingAdmin = await Admin.findOne({}).sort({ createdAt: 1 });
  if (existingAdmin) {
    throw createError("Admin already exists. Please login.", 409);
  }

  const { email, password, gmailUser, gmailAppPassword, gmailFromName } = validateSignupPayload(payload);
  const admin = new Admin({
    email,
    passwordHash: hashPassword(password),
    gmailUser,
    gmailAppPassword,
    gmailFromName
  });

  const token = issueSessionForAdmin(admin);

  await persistGmailConfigToEnv({
    gmailUser,
    gmailAppPassword,
    gmailFromName
  });

  applyRuntimeGmailConfig({
    gmailUser,
    gmailAppPassword,
    gmailFromName
  });

  await admin.save();

  return { admin, token };
}

export async function loginAdmin(payload) {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");

  if (!email || !password) {
    throw createError("Email and password are required", 400);
  }

  const admin = await Admin.findOne({ email });
  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    throw createError("Invalid email or password", 401);
  }

  const token = issueSessionForAdmin(admin);
  await admin.save();

  if (admin.gmailUser && admin.gmailAppPassword) {
    applyRuntimeGmailConfig({
      gmailUser: admin.gmailUser,
      gmailAppPassword: admin.gmailAppPassword,
      gmailFromName: admin.gmailFromName || "Skeduloo Notifications"
    });
  }

  return { admin, token };
}

export async function logoutAdmin(adminId) {
  await Admin.findByIdAndUpdate(adminId, {
    authTokenHash: "",
    authTokenExpiresAt: null
  });
}

export async function getAdminFromToken(token) {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const admin = await Admin.findOne({
    authTokenHash: tokenHash,
    authTokenExpiresAt: { $gt: new Date() }
  });

  return admin || null;
}
