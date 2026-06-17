import { google } from "googleapis";
import { parse } from "csv-parse/sync";
import { env } from "../config/env.js";

function extractSheetId(sheetUrl) {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new Error("Invalid Google Sheet URL");
  }
  return match[1];
}

function extractGid(sheetUrl) {
  try {
    const url = new URL(sheetUrl);
    const fromSearch = url.searchParams.get("gid");
    if (fromSearch) {
      return fromSearch;
    }

    const hash = String(url.hash || "").replace(/^#/, "");
    const hashParams = new URLSearchParams(hash);
    return hashParams.get("gid") || "0";
  } catch {
    return "0";
  }
}

function normalizeSheetHeader(header, index, usedKeys) {
  const fallbackKey = `column${index + 1}`;
  const cleaned = String(header || "").trim();

  if (!cleaned) {
    usedKeys.add(fallbackKey);
    return fallbackKey;
  }

  const parts = cleaned
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let key = parts.length
    ? parts
        .map((part, partIndex) => {
          const lower = part.toLowerCase();
          if (partIndex === 0) {
            return lower;
          }

          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join("")
    : fallbackKey;

  if (!/^[a-zA-Z_]/.test(key)) {
    key = `${fallbackKey}${key.replace(/[^a-zA-Z0-9_]/g, "")}`;
  }

  let uniqueKey = key;
  let suffix = 2;
  while (usedKeys.has(uniqueKey)) {
    uniqueKey = `${key}${suffix}`;
    suffix += 1;
  }

  usedKeys.add(uniqueKey);
  return uniqueKey;
}

function getColumnAliases(key) {
  const aliases = new Set([key]);
  const lowerKey = String(key || "").toLowerCase();

  if (lowerKey.includes("email")) {
    aliases.add("email");
  }

  if (lowerKey.includes("phone") || lowerKey.includes("mobile") || lowerKey.includes("whatsapp")) {
    aliases.add("phone");
  }

  if (lowerKey.includes("mobile")) {
    aliases.add("mobile");
  }

  if (lowerKey.includes("whatsapp")) {
    aliases.add("whatsapp");
  }

  if (lowerKey.includes("firstname") || lowerKey.startsWith("first")) {
    aliases.add("firstName");
  }

  if (lowerKey.includes("fullname") || lowerKey.startsWith("full")) {
    aliases.add("fullName");
  }

  return [...aliases];
}

function buildSheetData(values = []) {
  if (!values.length) {
    return { rows: [], columns: [] };
  }

  const [headers, ...rows] = values;
  const usedKeys = new Set();
  const columns = headers.map((header, index) => normalizeSheetHeader(header, index, usedKeys));

  const records = rows
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
    .map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        const value = row[index] ?? "";
        const normalizedKey = columns[index];
        const rawKey = String(header || "").trim();

        getColumnAliases(normalizedKey).forEach((alias) => {
          record[alias] = value;
        });

        if (rawKey && rawKey !== normalizedKey) {
          record[rawKey] = value;
        }
      });
      return record;
    });

  return { rows: records, columns };
}

function recordsFromCsv(csvText) {
  const rows = parse(csvText, {
    skip_empty_lines: true,
    trim: true
  });

  return Array.isArray(rows) ? rows : [];
}

async function fetchViaGoogleApi(sheetId, range) {
  const auth = env.google.serviceAccountEmail && env.google.privateKey
    ? new google.auth.JWT({
        email: env.google.serviceAccountEmail,
        key: env.google.privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
      })
    : undefined;

  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    key: env.google.apiKey || undefined
  });

  return buildSheetData(response.data.values || []);
}

function hasGoogleApiIdentity() {
  return Boolean(env.google.apiKey || (env.google.serviceAccountEmail && env.google.privateKey));
}

async function fetchViaPublicCsv(sheetId, gid = "0") {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`CSV fetch failed with status ${response.status}`);
  }

  const csvText = await response.text();
  return buildSheetData(recordsFromCsv(csvText));
}

export async function fetchSheetRows(sheetUrl, range = env.google.defaultRange) {
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractGid(sheetUrl);

  // If no API identity is configured, skip Sheets API and use public CSV directly.
  if (!hasGoogleApiIdentity()) {
    const { rows } = await fetchViaPublicCsv(sheetId, gid);
    return rows;
  }

  try {
    const { rows } = await fetchViaGoogleApi(sheetId, range);
    return rows;
  } catch (error) {
    console.info("Google API fetch failed, using public CSV fallback", error.message);
    const { rows } = await fetchViaPublicCsv(sheetId, gid);
    return rows;
  }
}

export async function fetchSheetColumns(sheetUrl, range = env.google.defaultRange) {
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractGid(sheetUrl);

  // If no API identity is configured, skip Sheets API and use public CSV directly.
  if (!hasGoogleApiIdentity()) {
    const { columns } = await fetchViaPublicCsv(sheetId, gid);
    return columns;
  }

  try {
    const { columns } = await fetchViaGoogleApi(sheetId, range);
    return columns;
  } catch (error) {
    console.info("Google API fetch failed, using public CSV fallback", error.message);
    const { columns } = await fetchViaPublicCsv(sheetId, gid);
    return columns;
  }
}
