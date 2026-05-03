const SERVER_URL = "http://localhost:8765";

const dot = document.getElementById("dot");
const serverLabel = document.getElementById("server-label");
const statusEl = document.getElementById("status");
const urlInput = document.getElementById("url-input");
const destInput = document.getElementById("dest-input");
const downloadBtn = document.getElementById("download-btn");
const logContainer = document.getElementById("log-container");
const logLines = document.getElementById("log-lines");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");

let pollTimer = null;

// ── Server health check ──
async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { method: "GET" });
    if (res.ok) {
      dot.className = "dot online";
      serverLabel.textContent = "Server 已啟動 ✓";
    } else {
      throw new Error();
    }
  } catch {
    dot.className = "dot offline";
    serverLabel.textContent = "Server 未啟動 — 請執行 mdlr-server.py";
  }
}

async function loadConfig() {
  try {
    const res = await fetch(`${SERVER_URL}/config`);
    if (res.ok) {
      const data = await res.json();
      if (data.output_dir && !destInput.value) {
        destInput.value = data.output_dir;
      }
    }
  } catch { /* silent — user 可手動填入 */ }
}

// 載入當前 tab URL
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.url) urlInput.value = tab.url;
});

// ── 下載按鈕 ──
downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("請輸入 URL", "error");
    return;
  }

  stopPolling();
  resetProgress();
  downloadBtn.disabled = true;
  setStatus("發送下載請求...", "");

  try {
    const dest = destInput.value.trim();
    const res = await fetch(`${SERVER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...(dest && { output_dir: dest }) }),
    });
    const data = await res.json();

    if (res.ok) {
      setStatus(`⏳ 下載中... (job: ${data.job_id})`, "");
      showProgress();
      startPolling(data.job_id);
    } else {
      setStatus(`✗ ${data.error || "未知錯誤"}`, "error");
      downloadBtn.disabled = false;
    }
  } catch {
    setStatus("✗ 連接失敗，請確認 Server 已啟動", "error");
    downloadBtn.disabled = false;
  }
});

// ── Polling ──
function startPolling(jobId) {
  pollTimer = setInterval(() => pollJob(jobId), 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`${SERVER_URL}/jobs/${jobId}/log`);
    if (!res.ok) return;
    const data = await res.json();

    renderLog(data.lines);
    parseProgress(data.lines);

    if (data.done) {
      stopPolling();
      downloadBtn.disabled = false;
      if (data.exit_code === 0) {
        setStatus("✓ 下載完成！", "success");
        progressBar.style.width = "100%";
      } else {
        setStatus(`✗ 下載失敗（exit code: ${data.exit_code}）`, "error");
      }
    }
  } catch {
    // server 暫時唔響應，繼續等
  }
}

// ── Log 渲染 ──
function renderLog(lines) {
  if (!lines.length) return;
  logLines.textContent = lines.join("\n");
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ── Progress 解析 ──
// miyuki 輸出格式：[label] [####----] 32/128 (25%)
const MIYUKI_RE = /\[.+?\]\s*\[.+?\]\s*(\d+)\/(\d+)\s*\((\d+)%\)/;
const SEGMENT_RE = /\[(\d+)\/(\d+)\]/;
const PERCENT_RE = /\((\d+)%\)/;

function parseProgress(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i];

    // 優先匹配 miyuki 完整格式：[label] [####----] 32/128 (25%)
    const miyukiMatch = line.match(MIYUKI_RE);
    if (miyukiMatch) {
      const done = parseInt(miyukiMatch[1]);
      const total = parseInt(miyukiMatch[2]);
      const pct = parseInt(miyukiMatch[3]);
      setProgressPct(pct, `${done} / ${total} segments (${pct}%)`);
      return;
    }

    // fallback: [32/128]
    const segMatch = line.match(SEGMENT_RE);
    if (segMatch) {
      const done = parseInt(segMatch[1]);
      const total = parseInt(segMatch[2]);
      const pct = Math.round((done / total) * 100);
      setProgressPct(pct, `${done} / ${total} segments (${pct}%)`);
      return;
    }

    // fallback: (25%)
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

// ── Helpers ──
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

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls;
}


checkServer();
loadConfig();
