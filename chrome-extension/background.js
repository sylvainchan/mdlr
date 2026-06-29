const SERVER_URL = "http://127.0.0.1:8765";
const MISSAV_DOMAIN_SUFFIXES = [".missav.ws", ".missav.com", ".missav.ai", "missav.ws", "missav.com", "missav.ai"];

const MISSAV_URL_PATTERNS = [
  "*://*.missav.ws/*",
  "*://*.missav.com/*",
  "*://*.missav.ai/*",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mdlr-download-page",
    title: "⬇️ MDLR: Download this video",
    contexts: ["page", "link"],
    documentUrlPatterns: MISSAV_URL_PATTERNS,
  });
});

function isMissAVUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return MISSAV_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

async function submitDownload(url) {
  if (!isMissAVUrl(url)) {
    notifyUser("MDLR", "URL 唔係 MissAV 網站");
    return false;
  }

  try {
    const response = await fetch(`${SERVER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (response.ok) {
      notifyUser("MDLR 下載已開始", `${data.message}\n${truncate(url, 60)}`);
      updateBadge();
      return true;
    } else {
      notifyUser("MDLR 錯誤", data.error || "Server 回傳錯誤");
      return false;
    }
  } catch {
    notifyUser(
      "MDLR: 無法連接 Server",
      "請確認 mdlr-server.py 已啟動（port 8765）"
    );
    return false;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "mdlr-download-page") return;

  const targetUrl = info.linkUrl || info.pageUrl || tab.url;

  if (!targetUrl) {
    notifyUser("錯誤", "無法取得 URL");
    return;
  }

  await submitDownload(targetUrl);
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.windowId) {
      chrome.action.openPopup({ windowId: tab.windowId }).catch(() => {});
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "download-current-page") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  await submitDownload(tab.url);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "update-badge") {
    updateBadge();
  }
});

function notifyUser(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message,
    priority: 2,
  });
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

async function updateBadge() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { method: "GET" });
    if (res.ok) {
      const data = await res.json();
      const count = data.active_jobs || 0;
      if (count > 0) {
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: "#e94560" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
}

chrome.alarms.create("update-badge", { periodInMinutes: 0.1 });
updateBadge();
