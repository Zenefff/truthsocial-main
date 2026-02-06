import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, "data", "posts.json");
const DEFAULT_API_URL =
  "https://truthsocial.com/api/v1/accounts/107780257626128497/statuses?exclude_replies=true&only_replies=false&with_muted=true";
const SOURCE_URL =
  process.env.TRUTHSOCIAL_SOURCE_URL ||
  process.env.TRUTHSOCIAL_API_URL ||
  process.env.TRUTHSOCIAL_FEED_URL ||
  DEFAULT_API_URL;
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS || "45000", 10);
const HISTORY_WINDOW_HOURS = Number.parseInt(process.env.HISTORY_WINDOW_HOURS || "24", 10);
const MAX_STATUS_PAGES = Number.parseInt(process.env.TRUTHSOCIAL_MAX_PAGES || "5", 10);
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
let lastSeedAttempt = 0;
let lastPollAt = null;

const app = express();
app.use(cors());
app.use(express.json());

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { posts: Array.isArray(parsed.posts) ? parsed.posts : [] };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { posts: [] };
    }
    throw error;
  }
}

async function saveData(data) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
}

function normalizeCdata(value) {
  if (!value) return "";
  return value.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1").trim();
}

function extractTag(tagName, blob) {
  const matcher = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = blob.match(matcher);
  return match ? normalizeCdata(match[1]) : "";
}

function parseFeed(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match = itemRegex.exec(xml);
  while (match) {
    const chunk = match[1];
    const guid = extractTag("guid", chunk);
    const link = extractTag("link", chunk);
    const pubDate = extractTag("pubDate", chunk);
    const id = guid || link;
    if (id && pubDate) {
      const timestamp = new Date(pubDate).toISOString();
      if (!Number.isNaN(Date.parse(timestamp))) {
        items.push({ id, timestamp });
      }
    }
    match = itemRegex.exec(xml);
  }
  return items;
}

function parseStatusList(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => {
      const timestamp = item?.created_at;
      const id = item?.id || item?.url || item?.uri;
      const url = item?.url || item?.uri || "";
      const content = item?.content || "";
      if (!timestamp || !id) return null;
      const iso = new Date(timestamp).toISOString();
      if (Number.isNaN(Date.parse(iso))) return null;
      return { id: String(id), timestamp: iso, url, content };
    })
    .filter(Boolean);
}

function extractNumericId(value) {
  if (!value) return "";
  const match = String(value).match(/\/(\d+)(?:\b|$)/);
  return match ? match[1] : "";
}

function canonicalId(post) {
  if (!post) return "";
  const direct = post.id ? String(post.id) : "";
  if (direct && /^\d+$/.test(direct)) return direct;
  const fromDirect = extractNumericId(direct);
  if (fromDirect) return fromDirect;
  const fromUrl = extractNumericId(post.url || post.uri);
  if (fromUrl) return fromUrl;
  return direct || String(post.url || post.uri || "");
}

function normalizePosts(posts) {
  const byId = new Map();
  for (const post of posts) {
    const id = canonicalId(post);
    if (!id) continue;
    const normalized = { ...post, id };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, normalized);
      continue;
    }
    const merged = { ...existing };
    const existingTime = Date.parse(existing.timestamp);
    const incomingTime = Date.parse(normalized.timestamp);
    if (!Number.isNaN(incomingTime) && (Number.isNaN(existingTime) || incomingTime > existingTime)) {
      merged.timestamp = normalized.timestamp;
    }
    if (!merged.url && normalized.url) merged.url = normalized.url;
    if (!merged.uri && normalized.uri) merged.uri = normalized.uri;
    if (!merged.content && normalized.content) merged.content = normalized.content;
    byId.set(id, merged);
  }
  return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function parseLinkHeader(header) {
  if (!header) return {};
  return header.split(",").reduce((links, part) => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      links[rel] = url;
    }
    return links;
  }, {});
}

function shouldFetchMore(items) {
  if (!items.length) return false;
  const oldest = Math.min(...items.map((item) => Date.parse(item.timestamp)));
  if (Number.isNaN(oldest)) return false;
  return Date.now() - oldest < HISTORY_WINDOW_HOURS * 60 * 60 * 1000;
}

function toHourKey(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function computeHourly(posts) {
  const normalized = normalizePosts(posts);
  const buckets = new Map();
  for (const post of normalized) {
    const hourKey = toHourKey(post.timestamp);
    buckets.set(hourKey, (buckets.get(hourKey) || 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => new Date(a.hour) - new Date(b.hour));
}

function computeLatest(posts) {
  const normalized = normalizePosts(posts);
  if (!normalized.length) return null;
  return normalized.reduce((latest, post) => {
    if (!latest) return post;
    return new Date(post.timestamp) > new Date(latest.timestamp) ? post : latest;
  }, null);
}

async function fetchStatusPages(headers) {
  const collected = [];
  let pageUrl = SOURCE_URL;
  for (let page = 0; page < MAX_STATUS_PAGES && pageUrl; page += 1) {
    const response = await fetch(pageUrl, { headers });
    if (!response.ok) {
      throw new Error(`Feed request failed: ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    if (!contentType.includes("application/json")) {
      throw new Error("Expected JSON response from Truth Social API");
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new Error("Failed to parse Truth Social JSON response");
    }
    const items = parseStatusList(payload);
    if (!items.length) {
      break;
    }
    collected.push(...items);
    const linkHeader = response.headers.get("link");
    const links = parseLinkHeader(linkHeader);
    pageUrl = links.next;
    if (!shouldFetchMore(collected)) {
      break;
    }
  }
  return collected;
}

async function pollFeed() {
  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (process.env.TRUTHSOCIAL_COOKIE) {
      headers.Cookie = process.env.TRUTHSOCIAL_COOKIE;
    }

    let incoming = [];
    if (SOURCE_URL.includes("/api/")) {
      incoming = await fetchStatusPages(headers);
    } else {
      const response = await fetch(SOURCE_URL, { headers });
      if (!response.ok) {
        throw new Error(`Feed request failed: ${response.status}`);
      }
      const body = await response.text();
      if (response.headers.get("content-type")?.includes("application/json")) {
        incoming = parseStatusList(JSON.parse(body));
      } else {
        incoming = parseFeed(body);
      }
    }
    if (incoming.length) {
      const data = await loadData();
      const merged = normalizePosts([...data.posts, ...incoming]);
      await saveData({ posts: merged });
    }
    lastPollAt = new Date().toISOString();
  } catch (error) {
    console.error("Failed to poll Truth Social feed", error);
  }
}

async function ensureSeeded() {
  const data = await loadData();
  if (data.posts.length) return data;
  const now = Date.now();
  if (now - lastSeedAttempt < POLL_INTERVAL_MS) {
    return data;
  }
  lastSeedAttempt = now;
  await pollFeed();
  return loadData();
}

app.get("/latest", async (_request, response) => {
  const data = await ensureSeeded();
  const latest = computeLatest(data.posts);
  const total = normalizePosts(data.posts).length;
  response.json({
    latest,
    totalPosts: total,
    polledAt: lastPollAt || null,
  });
});

app.get("/history/hourly", async (_request, response) => {
  const data = await ensureSeeded();
  response.json({
    hours: computeHourly(data.posts),
  });
});

app.get("/posts", async (_request, response) => {
  const data = await loadData();
  response.json({ posts: normalizePosts(data.posts) });
});

app.listen(PORT, () => {
  console.log(`TruthSocial service listening on ${PORT}`);
});

pollFeed();
setInterval(pollFeed, POLL_INTERVAL_MS);
