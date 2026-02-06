import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, "data", "posts.json");
const FEED_URL =
  process.env.TRUTHSOCIAL_FEED_URL || "https://truthsocial.com/@realDonaldTrump.rss";
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS || "300000", 10);
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

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

function toHourKey(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function computeHourly(posts) {
  const buckets = new Map();
  for (const post of posts) {
    const hourKey = toHourKey(post.timestamp);
    buckets.set(hourKey, (buckets.get(hourKey) || 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => new Date(a.hour) - new Date(b.hour));
}

function computeLatest(posts) {
  if (!posts.length) return null;
  return posts.reduce((latest, post) => {
    if (!latest) return post;
    return new Date(post.timestamp) > new Date(latest.timestamp) ? post : latest;
  }, null);
}

async function pollFeed() {
  try {
    const response = await fetch(FEED_URL);
    if (!response.ok) {
      throw new Error(`Feed request failed: ${response.status}`);
    }
    const xml = await response.text();
    const incoming = parseFeed(xml);
    if (!incoming.length) {
      return;
    }
    const data = await loadData();
    const seen = new Set(data.posts.map((post) => post.id));
    const merged = [...data.posts];
    for (const post of incoming) {
      if (!seen.has(post.id)) {
        merged.push(post);
        seen.add(post.id);
      }
    }
    merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    await saveData({ posts: merged });
  } catch (error) {
    console.error("Failed to poll Truth Social feed", error);
  }
}

app.get("/latest", async (_request, response) => {
  const data = await loadData();
  const latest = computeLatest(data.posts);
  response.json({
    latest,
    totalPosts: data.posts.length,
    polledAt: new Date().toISOString(),
  });
});

app.get("/history/hourly", async (_request, response) => {
  const data = await loadData();
  response.json({
    hours: computeHourly(data.posts),
  });
});

app.get("/posts", async (_request, response) => {
  const data = await loadData();
  response.json({ posts: data.posts });
});

app.listen(PORT, () => {
  console.log(`TruthSocial service listening on ${PORT}`);
});

pollFeed();
setInterval(pollFeed, POLL_INTERVAL_MS);
