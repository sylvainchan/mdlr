#!/usr/bin/env bash
# MDLR Server - launchd 管理腳本
# 用法：./mdlr-agent.sh [install|uninstall|start|stop|restart|status|log]

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.mdlr.server.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.mdlr.server.plist"
LABEL="com.mdlr.server"
LOG="$HOME/Library/Logs/mdlr-server.log"

case "$1" in
  install)
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load -w "$PLIST_DST"
    echo "✓ MDLR Server 已安裝並啟動（登入後自動執行）"
    ;;
  uninstall)
    launchctl unload -w "$PLIST_DST" 2>/dev/null
    rm -f "$PLIST_DST"
    echo "✓ MDLR Server 已移除"
    ;;
  start)
    launchctl start "$LABEL"
    echo "✓ 已啟動"
    ;;
  stop)
    launchctl stop "$LABEL"
    echo "✓ 已停止"
    ;;
  restart)
    launchctl stop "$LABEL"
    sleep 1
    launchctl start "$LABEL"
    echo "✓ 已重啟"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "（未載入）"
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "用法：$0 [install|uninstall|start|stop|restart|status|log]"
    ;;
esac
