#!/usr/bin/env node
/* eslint-disable no-console */
const DEFAULT_ACCOUNT_ID = "107780257626128497";
const DEFAULT_MONTHS = 6;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_DELAY_MS = 750;
const DEFAULT_BACKOFF_FACTOR = 1.5;
const DEFAULT_MAX_DELAY_MS = 15000;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
};

const hasFlag = (name) => args.includes(name);

const accountId = getArg("--account", DEFAULT_ACCOUNT_ID);
const months = Number.parseInt(getArg("--months", String(DEFAULT_MONTHS)), 10);
const outFile = getArg("--out", `truthsocial_${accountId}_${months}mo.csv`);
const maxPages = Number.parseInt(getArg("--max-pages", String(DEFAULT_MAX_PAGES)), 10);
const delayMs = Number.parseInt(getArg("--delay-ms", String(DEFAULT_DELAY_MS)), 10);
const backoffFactor = Number.parseFloat(getArg("--backoff-factor", String(DEFAULT_BACKOFF_FACTOR)));
const maxDelayMs = Number.parseInt(getArg("--max-delay-ms", String(DEFAULT_MAX_DELAY_MS)), 10);
const includeReplies = hasFlag("--include-replies");
const excludeReplies = hasFlag("--exclude-replies");

if (Number.isNaN(months) || months <= 0) {
  console.error("Invalid --months value");
  process.exit(1);
}

const now = new Date();
const cutoff = new Date(now);
cutoff.setMonth(cutoff.getMonth() - months);

const params = new URLSearchParams({
  exclude_replies: excludeReplies ? "true" : includeReplies ? "false" : "false",
  only_replies: "false",
  with_muted: "true",
  limit: String(DEFAULT_LIMIT),
});

const baseUrl = `https://truthsocial.com/api/v1/accounts/${accountId}/statuses?${params.toString()}`;

const cookie = process.env.TRUTHSOCIAL_COOKIE || process.env.COOKIE || "";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

if (cookie) {
  headers.Cookie = cookie;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseLinkHeader = (header) => {
  if (!header) return {};
  return header.split(",").reduce((links, part) => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      links[rel] = url;
    }
    return links;
  }, {});
};

const stripHtml = (html) => {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
};

const csvEscape = (value) => {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const toCsvRow = (row) => row.map(csvEscape).join(",");

const rows = [];
rows.push(
  toCsvRow([
    "id",
    "created_at",
    "url",
    "is_retruth",
    "retruth_of",
    "content_text",
    "content_html",
  ])
);

let pageUrl = baseUrl;
let page = 0;
let seenIds = new Set();
let currentDelay = delayMs;

const withinRange = (createdAt) => {
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp)) return false;
  return timestamp >= cutoff.getTime();
};

while (pageUrl && page < maxPages) {
  const response = await fetch(pageUrl, { headers });
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "0", 10);
      const retryAfterMs =
        Number.isNaN(retryAfter) || retryAfter <= 0 ? 0 : retryAfter * 1000;
      const waitMs = Math.max(currentDelay, retryAfterMs);
      console.warn(`429 rate limit. Waiting ${waitMs}ms before retrying...`);
      await sleep(waitMs);
      const nextDelay = Math.ceil(currentDelay * (Number.isFinite(backoffFactor) ? backoffFactor : DEFAULT_BACKOFF_FACTOR));
      currentDelay = Math.min(nextDelay, Number.isNaN(maxDelayMs) ? DEFAULT_MAX_DELAY_MS : maxDelayMs);
      continue;
    }
    throw new Error(`Request failed (${response.status}) for ${pageUrl}`);
  }

  page += 1;
  currentDelay = delayMs;
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) {
    break;
  }

  let keepPaging = false;

  for (const item of payload) {
    if (!item?.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);

    if (!withinRange(item.created_at)) {
      continue;
    }

    keepPaging = true;

    const isRetruth = Boolean(item.reblog);
    const retruthOf = item.reblog?.url || item.reblog?.uri || item.reblog?.id || "";
    const url = item.url || item.uri || "";
    const contentHtml = item.content || "";
    const contentText = stripHtml(contentHtml);

    rows.push(
      toCsvRow([
        item.id,
        item.created_at,
        url,
        isRetruth ? "true" : "false",
        retruthOf,
        contentText,
        contentHtml,
      ])
    );
  }

  const links = parseLinkHeader(response.headers.get("link"));
  pageUrl = links.next || "";

  if (!keepPaging) {
    break;
  }

  if (currentDelay > 0) {
    await sleep(currentDelay);
  }
}

const fs = await import("node:fs/promises");
await fs.writeFile(outFile, rows.join("\n"), "utf8");

console.log(`Exported ${rows.length - 1} posts to ${outFile}`);
