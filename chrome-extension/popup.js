const SERVER_URL = "http://127.0.0.1:8765";
const STORAGE_KEY_OUTPUT_DIR = "mdlr_output_dir";
const STORAGE_KEY_HISTORY = "mdlr_history";
const MAX_HISTORY = 50;
const MISSAV_DOMAIN_SUFFIXES = [".missav.ws", ".missav.com", ".missav.ai", "missav.ws", "missav.com", "missav.ai"];

const dot = document.getElementById("dot");
const serverLabel = document.getElementById("server-label");
const statusEl = document.getElementById("status");
const urlInput = document.getElementById("url-input");
const urlError = document.getElementById("url-error");
const destInput = document.getElementById("dest-input");
const downloadBtn = document.getElementById("download-btn");
const cancelBtn = document.getElementById("cancel-btn");
const logContainer = document.getElementById("log-container");
const logLines = document.getElementById("log-lines");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history-btn");

let pollTimer = null;
let pollDelay = 1000;
let currentJobId = null;

// ── Server health check ──
async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { method: "GET" });
    if (res.ok) {
      dot.className = "dot online";
      serverLabel.textContent = "Server 已啟動 ✓";
    } else {
      throw new Error("not ok");
    }
  } catch {
    dot.className = "dot offline";
    serverLabel.textContent = "Server 未啟動 — 請執行 mdlr-server.py";
  }
}

// ── Persist output dir via chrome.storage.local ──
async function loadPreferences() {
  try {
    const items = await chrome.storage.local.get([STORAGE_KEY_OUTPUT_DIR]);
    if (items[STORAGE_KEY_OUTPUT_DIR]) {
      destInput.value = items[STORAGE_KEY_OUTPUT_DIR];
    }
  } catch { /* ignore */ }
}

async function saveOutputDir(dir) {
  if (dir) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_OUTPUT_DIR]: dir });
    } catch { /* ignore */ }
  }
}

// ── History ──
async function loadHistory() {
  try {
    const items = await chrome.storage.local.get([STORAGE_KEY_HISTORY]);
    return items[STORAGE_KEY_HISTORY] || [];
  } catch {
    return [];
  }
}

async function addHistory(entry) {
  let history = await loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_HISTORY]: history });
  } catch { /* ignore */ }
}

async function clearHistory() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_HISTORY]: [] });
  } catch { /* ignore */ }
  renderHistory([]);
}

function renderHistory(history) {
  if (!history.length) {
    historyList.innerHTML = '<div class="history-empty">暫無記錄</div>';
    return;
  }
  historyList.innerHTML = history
    .map(
      (h) => `
    <div class="history-item" data-url="${escapeAttr(h.url)}" title="${escapeAttr(h.url)}">
      <span class="job-id">${escapeHtml(h.job_id)}</span>
      <span class="job-url">${escapeHtml(truncateUrl(h.url, 30))}</span>
      <span class="job-status ${h.exit_code === 0 ? 'ok' : 'err'}">${h.exit_code === 0 ? '✓' : '✗'}</span>
    </div>`
    )
    .join("");

  document.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", () => {
      urlInput.value = el.dataset.url;
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateUrl(url, maxLen) {
  try {
    const u = new URL(url);
    const short = u.hostname + u.pathname;
    return short.length > maxLen ? short.slice(0, maxLen) + "..." : short;
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + "..." : url;
  }
}

// ── URL 校驗 ──
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      MISSAV_DOMAIN_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix)) &&
      parsed.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function validateUrlInput() {
  const url = urlInput.value.trim();
  if (!url) {
    urlError.style.display = "none";
    urlInput.classList.remove("invalid");
    return true;
  }
  if (isValidUrl(url)) {
    urlError.style.display = "none";
    urlInput.classList.remove("invalid");
    return true;
  }
  urlError.textContent = "URL 格式無效，必須係 missav.ws / missav.com / missav.ai";
  urlError.style.display = "block";
  urlInput.classList.add("invalid");
  return false;
}

urlInput.addEventListener("input", validateUrlInput);
urlInput.addEventListener("blur", validateUrlInput);

// ── Load current tab URL ──
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (tab?.url) {
    urlInput.value = tab.url;
    validateUrlInput();
  }
});

// ── Enter shortcut ──
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !downloadBtn.disabled) {
    e.preventDefault();
    downloadBtn.click();
  }
});

destInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !downloadBtn.disabled) {
    e.preventDefault();
    downloadBtn.click();
  }
});

// ── Cancel button ──
cancelBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  let cancelled = false;
  try {
    const res = await fetch(`${SERVER_URL}/jobs/${currentJobId}`, { method: "DELETE" });
    cancelled = res.ok;
  } catch { /* server may be down */ }
  stopPolling();
  if (cancelled) {
    resetUI();
    setStatus("已取消下載", "error");
  } else {
    resetProgress();
    setDownloadingState(false);
    setStatus("取消請求失敗，server 可能未回應", "error");
  }
  currentJobId = null;
});

// ── Download ──
downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("請輸入 URL", "error");
    return;
  }
  if (!isValidUrl(url)) {
    setStatus("URL 格式無效", "error");
    return;
  }

  stopPolling();
  resetProgress();
  setStatus("發送下載請求...", "");

  try {
    const dest = destInput.value.trim();
    await saveOutputDir(dest);

    const res = await fetch(`${SERVER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...(dest && { output_dir: dest }) }),
    });
    const data = await res.json();

    if (res.ok) {
      currentJobId = data.job_id;
      setDownloadingState(true);
      setStatus(`⏳ 下載中... (job: ${data.job_id})`, "");
      showProgress();
      pollDelay = 1000;
      startPolling(data.job_id);

      await addHistory({
        job_id: data.job_id,
        url,
        exit_code: null,
        timestamp: Date.now(),
      });
      renderHistory(await loadHistory());
    } else {
      setStatus(`✗ ${data.error || "未知錯誤"}`, "error");
    }
  } catch {
    setStatus("✗ 連接失敗，請確認 Server 已啟動", "error");
  }
});

// ── Polling (exponential backoff on network failure) ──
function startPolling(jobId) {
  pollTimer = setTimeout(() => pollJob(jobId), pollDelay);
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function pollJob(jobId) {
  let res;
  try {
    res = await fetch(`${SERVER_URL}/jobs/${jobId}/log`);
  } catch {
    pollDelay = Math.min(pollDelay * 2, 16000);
    startPolling(jobId);
    return;
  }

  pollDelay = 1000;

  if (!res.ok) {
    if (res.status === 404) {
      stopPolling();
      setDownloadingState(false);
      currentJobId = null;
      setStatus("下載記錄已遺失（job 不再存在）", "error");
      return;
    }
    startPolling(jobId);
    return;
  }

  const data = await res.json();

  renderLog(data.lines);
  parseProgress(data.lines);

  if (data.done) {
    stopPolling();
    setDownloadingState(false);
    updateHistoryExitCode(jobId, data.exit_code);

    if (data.exit_code === 0) {
      setStatus("✓ 下載完成！", "success");
      progressBar.style.width = "100%";
    } else if (data.exit_code === -15) {
      setStatus("已取消下載", "error");
    } else {
      setStatus(`✗ 下載失敗（exit code: ${data.exit_code}）`, "error");
    }
    currentJobId = null;
    return;
  }

  startPolling(jobId);
}

async function updateHistoryExitCode(jobId, exitCode) {
  let history = await loadHistory();
  const entry = history.find((h) => h.job_id === jobId);
  if (entry) {
    entry.exit_code = exitCode;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_HISTORY]: history });
    } catch { /* ignore */ }
    renderHistory(history);
  }
}

// ── Log 渲染 ──
function renderLog(lines) {
  if (!lines.length) return;
  logLines.textContent = lines.join("\n");
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ── Progress 解析 ──
const MIYUKI_RE = /\[.+?\]\s*\[.+?\]\s*(\d+)\/(\d+)\s*\((\d+)%\)/;
const SEGMENT_RE = /\[(\d+)\/(\d+)\]/;
const PERCENT_RE = /\((\d+)%\)/;

function parseProgress(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i];

    const miyukiMatch = line.match(MIYUKI_RE);
    if (miyukiMatch) {
      const done = parseInt(miyukiMatch[1]);
      const total = parseInt(miyukiMatch[2]);
      const pct = parseInt(miyukiMatch[3]);
      setProgressPct(pct, `${done} / ${total} segments (${pct}%)`);
      return;
    }

    const segMatch = line.match(SEGMENT_RE);
    if (segMatch) {
      const done = parseInt(segMatch[1]);
      const total = parseInt(segMatch[2]);
      const pct = Math.round((done / total) * 100);
      setProgressPct(pct, `${done} / ${total} segments (${pct}%)`);
      return;
    }

    const pctMatch = line.match(PERCENT_RE);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]);
      if (pct >= 0 && pct <= 100) {
        setProgressPct(pct, `${pct}%`);
        return;
      }
    }
  }
}

function setProgressPct(pct, label) {
  progressBar.style.width = `${Math.min(pct, 99)}%`;
  progressLabel.textContent = label;
  progressLabel.classList.add("visible");
}

// ── UI helpers ──
function setDownloadingState(active) {
  downloadBtn.disabled = active;
  if (active) {
    cancelBtn.classList.add("visible");
  } else {
    cancelBtn.classList.remove("visible");
  }
}

function showProgress() {
  progressWrap.classList.add("visible");
  logContainer.classList.add("visible");
}

function resetProgress() {
  progressBar.style.width = "0%";
  progressWrap.classList.remove("visible");
  progressLabel.classList.remove("visible");
  progressLabel.textContent = "";
  logContainer.classList.remove("visible");
  logLines.textContent = "";
}

function resetUI() {
  setDownloadingState(false);
  resetProgress();
}

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

// ── Clear history ──
clearHistoryBtn.addEventListener("click", clearHistory);

// ── Init ──
async function init() {
  checkServer();
  await loadPreferences();
  renderHistory(await loadHistory());
}

init();
