const updateStatus = document.getElementById("update-status");
const latestTimestamp = document.getElementById("latest-timestamp");
const latestHeadline = document.getElementById("latest-headline");
const latestBody = document.getElementById("latest-body");
const latestId = document.getElementById("latest-id");
const latestTotal = document.getElementById("latest-total");
const latestLink = document.getElementById("latest-link");
const historyChart = document.getElementById("history-chart");
const historyEmpty = document.getElementById("history-empty");

const API_BASE = window.API_BASE_URL || "http://localhost:3000";
const POLL_INTERVAL_MS = 30000;

const formatTime = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatHour = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "numeric" }).toLowerCase();

const setStatus = (label) => {
  updateStatus.textContent = label;
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
  latestTimestamp.textContent = `As of ${formatTime(latest.timestamp)}`;
  latestHeadline.textContent = "Latest Truth Social post";
  latestBody.textContent = `Tracking post timestamps every polling cycle. Last capture at ${formatTime(
    latest.timestamp
  )}.`;
  latestId.textContent = latest.id;
  latestTotal.textContent = payload.totalPosts;
  latestLink.href = latest.id.startsWith("http")
    ? latest.id
    : "https://truthsocial.com/@realDonaldTrump";
};

const renderHistory = (payload) => {
  historyChart.innerHTML = "";
  const hours = payload?.hours || [];
  if (!hours.length) {
    historyEmpty.hidden = false;
    return;
  }

  historyEmpty.hidden = true;
  const recent = hours.slice(-12);
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
