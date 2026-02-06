const updateStatus = document.getElementById("update-status");
const updateCountdown = document.getElementById("update-countdown");
const latestTimestamp = document.getElementById("latest-timestamp");
const latestHeadline = document.getElementById("latest-headline");
const latestBody = document.getElementById("latest-body");
const latestId = document.getElementById("latest-id");
const latestTotal = document.getElementById("latest-total");
const latestLink = document.getElementById("latest-link");
const historyChart = document.getElementById("history-chart");
const historyEmpty = document.getElementById("history-empty");
const historyList = document.getElementById("history-list");

const API_BASE = window.API_BASE_URL || "http://localhost:3000";
const POLL_INTERVAL_MS = 45000;
const COUNTDOWN_TICK_MS = 1000;

const formatTime = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const formatHour = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", hour12: false });

const toUtcHourKey = (date) => {
  const utc = new Date(date);
  utc.setUTCMinutes(0, 0, 0);
  return utc.toISOString();
};

const getLastHours = (count) => {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const hours = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    hours.push(new Date(now.getTime() - i * 60 * 60 * 1000));
  }
  return hours;
};

const setStatus = (label) => {
  updateStatus.textContent = label;
};

const stripHtml = (html) => {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent?.trim() || "";
};

const formatCountdown = (ms) => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

let nextRefreshAt = Date.now() + POLL_INTERVAL_MS;

const updateCountdownLabel = () => {
  if (!updateCountdown) return;
  updateCountdown.textContent = `Refresh in ${formatCountdown(nextRefreshAt - Date.now())}`;
};

const renderLatest = (payload) => {
  if (!payload?.latest) {
    latestTimestamp.textContent = "Awaiting first poll";
    latestHeadline.textContent = "No post data yet";
    latestBody.textContent = "Once the backend fetches the feed, the latest post will appear here.";
    latestId.textContent = "--";
    latestTotal.textContent = payload?.totalPosts ?? 0;
    latestLink.href = "https://truthsocial.com/@realDonaldTrump";
    return;
  }

  const latest = payload.latest;
  const postUrl =
    latest.url ||
    (typeof latest.id === "string" && latest.id.startsWith("http")
      ? latest.id
      : `https://truthsocial.com/@realDonaldTrump/${latest.id}`);
  const contentText = stripHtml(latest.content);
  latestTimestamp.textContent = `As of ${formatTime(latest.timestamp)}`;
  latestHeadline.textContent = "Latest Truth Social post";
  latestBody.textContent =
    contentText ||
    `Tracking post timestamps every polling cycle. Last capture at ${formatTime(
      latest.timestamp
    )}.`;
  const idLink = document.createElement("a");
  idLink.href = postUrl;
  idLink.target = "_blank";
  idLink.rel = "noreferrer";
  idLink.textContent = "Open post";
  latestId.replaceChildren(idLink);
  latestTotal.textContent = payload.totalPosts;
  latestLink.href = postUrl;
};

const renderHistory = (payload) => {
  historyChart.innerHTML = "";
  historyList.innerHTML = "";
  const hours = payload?.hours || [];
  const hourMap = new Map(hours.map((entry) => [entry.hour, entry.count]));

  const recent = getLastHours(24).map((date) => {
    const hourKey = toUtcHourKey(date);
    return { hour: hourKey, count: hourMap.get(hourKey) || 0 };
  });

  const hasRecent = recent.some((entry) => entry.count > 0);
  historyEmpty.textContent = "No posts in the last 24 hours.";
  historyEmpty.hidden = hasRecent;
  const maxCount = Math.max(...recent.map((entry) => entry.count), 1);
  historyChart.style.gridTemplateColumns = `repeat(${recent.length}, 1fr)`;

  for (const entry of recent) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.setProperty("--value", `${Math.round((entry.count / maxCount) * 100)}%`);

    const label = document.createElement("span");
    label.textContent = formatHour(entry.hour);

    const count = document.createElement("strong");
    count.className = "bar-count";
    count.textContent = entry.count;

    bar.append(label, count);
    historyChart.append(bar);
  }

  const listEntries = [...recent].reverse();
  for (const entry of listEntries) {
    const row = document.createElement("div");
    row.className = "hour-row";

    const rowLabel = document.createElement("span");
    rowLabel.textContent = formatHour(entry.hour);

    const rowCount = document.createElement("strong");
    rowCount.textContent = `${entry.count} ${entry.count === 1 ? "post" : "posts"}`;

    row.append(rowLabel, rowCount);
    historyList.append(row);
  }
};

const fetchLatest = async () => {
  const response = await fetch(`${API_BASE}/latest`);
  if (!response.ok) {
    throw new Error("Failed to load latest");
  }
  return response.json();
};

const fetchHistory = async () => {
  const response = await fetch(`${API_BASE}/history/hourly`);
  if (!response.ok) {
    throw new Error("Failed to load history");
  }
  return response.json();
};

const refresh = async () => {
  nextRefreshAt = Date.now() + POLL_INTERVAL_MS;
  updateCountdownLabel();
  try {
    const [latest, history] = await Promise.all([fetchLatest(), fetchHistory()]);
    renderLatest(latest);
    renderHistory(history);
    setStatus(`Updated ${formatTime(latest.polledAt)}`);
  } catch (error) {
    console.error(error);
    setStatus("Backend unavailable");
  }
};

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
updateCountdownLabel();
setInterval(updateCountdownLabel, COUNTDOWN_TICK_MS);
