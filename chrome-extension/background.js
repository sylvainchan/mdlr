const SERVER_URL = "http://localhost:8765";

const MISSAV_URL_PATTERNS = [
  "*://*.missav.ws/*",
  "*://*.missav.com/*",
  "*://*.missav.ai/*",
];

// 安裝時建立 context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mdlr-download-page",
    title: "⬇️ MDLR: Download this video",
    contexts: ["page", "link"],
    documentUrlPatterns: MISSAV_URL_PATTERNS,
  });
});

// 處理 context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "mdlr-download-page") return;

  // 優先用 link URL，否則用當前頁面 URL
  const targetUrl = info.linkUrl || info.pageUrl || tab.url;

  if (!targetUrl) {
    notifyUser("錯誤", "無法取得 URL");
    return;
  }

  try {
    const response = await fetch(`${SERVER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });

    const data = await response.json();

    if (response.ok) {
      notifyUser("MDLR 下載已開始", `${data.message}\n${truncate(targetUrl, 60)}`);
    } else {
      notifyUser("MDLR 錯誤", data.error || "Server 回傳錯誤");
    }
  } catch (err) {
    notifyUser(
      "MDLR: 無法連接 Server",
      "請確認 mdlr-server.py 已啟動（port 8765）"
    );
  }
});

function notifyUser(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message,
  });
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}
