"""
MDLR Local Download Server
===========================
啟動後監聽 localhost:8765，接受 Chrome Extension 的下載請求，
並在背景 spawn miyuki 執行下載。

用法：
    python mdlr-server.py [--host 127.0.0.1] [--port 8765] [--output ./downloads]
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mdlr-server")

# ──────────────────────────────────────────────
# 設定
# ──────────────────────────────────────────────
ALLOWED_ORIGINS = {"chrome-extension://"}  # 前綴比對，容許所有 extension ID
ALLOWED_HOSTS = {"missav.ws", "missav.com", "missav.ai"}  # 限制只接受這些 domain

DEFAULT_OUTPUT_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "mdlr")
active_jobs: dict[str, subprocess.Popen] = {}
job_logs: dict[str, dict] = {}  # job_id -> {lines: [], done: bool, exit_code: int|None}
LOG_BUFFER_SIZE = 200
jobs_lock = threading.Lock()

ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

# mdlr-server.py 所在目錄（即 project root），加入 PYTHONPATH 讓 miyuki 可以被找到
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


# ──────────────────────────────────────────────
# 安全檢查
# ──────────────────────────────────────────────
def is_valid_url(url: str) -> bool:
    """基本 URL 驗證：必須是 http/https，且 host 在白名單內。"""
    try:
        parsed = urlparse(url)
        return (
            parsed.scheme in ("http", "https")
            and parsed.netloc in ALLOWED_HOSTS
            and bool(parsed.path)
        )
    except Exception:
        return False


def is_safe_output_dir(path: str) -> bool:
    """確保路徑係絕對路徑，且唔含路徑穿越字符。"""
    try:
        resolved = os.path.realpath(os.path.abspath(path))
        # 拒絕系統關鍵目錄
        forbidden = (
            "/etc",
            "/bin",
            "/sbin",
            "/usr/bin",
            "/usr/sbin",
            "/System",
            "/private/etc",
        )
        return not any(
            resolved == f or resolved.startswith(f + os.sep) for f in forbidden
        )
    except Exception:
        return False


def is_allowed_origin(origin: str) -> bool:
    """只接受 Chrome Extension 發出的請求。"""
    return any(origin.startswith(prefix) for prefix in ALLOWED_ORIGINS)


# ──────────────────────────────────────────────
# 下載邏輯
# ──────────────────────────────────────────────
def start_download(url: str, output_dir: str) -> str:
    """在背景執行 miyuki，回傳 job id。"""
    import uuid

    job_id = uuid.uuid4().hex[:8]
    os.makedirs(output_dir, exist_ok=True)

    cmd = [sys.executable, "-m", "miyuki", "-urls", url]
    log.info("[job:%s] Starting: %s", job_id, " ".join(cmd))

    # 注入 PROJECT_ROOT 到 PYTHONPATH，確保 miyuki package 可被找到
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        PROJECT_ROOT + os.pathsep + existing_pythonpath
        if existing_pythonpath
        else PROJECT_ROOT
    )

    proc = subprocess.Popen(
        cmd,
        cwd=output_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    with jobs_lock:
        job_logs[job_id] = {"lines": [], "done": False, "exit_code": None}

    # 背景 thread 讀取 log 輸出
    def _stream_log():
        for raw_line in proc.stdout:
            clean = ANSI_ESCAPE.sub("", raw_line).rstrip()
            if not clean:
                continue
            log.info("[job:%s] %s", job_id, clean)
            with jobs_lock:
                buf = job_logs[job_id]["lines"]
                buf.append(clean)
                if len(buf) > LOG_BUFFER_SIZE:
                    buf.pop(0)
        rc = proc.wait()
        log.info("[job:%s] Finished with code %d", job_id, rc)
        with jobs_lock:
            active_jobs.pop(job_id, None)
            if job_id in job_logs:
                job_logs[job_id]["done"] = True
                job_logs[job_id]["exit_code"] = rc

    t = threading.Thread(target=_stream_log, daemon=True)
    t.start()

    with jobs_lock:
        active_jobs[job_id] = proc

    return job_id


# ──────────────────────────────────────────────
# HTTP Handler
# ──────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    output_dir: str = DEFAULT_OUTPUT_DIR

    # ── CORS headers ──
    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        if is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ── GET /health ──
    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "active_jobs": len(active_jobs)})
        elif self.path == "/config":
            self._json_response(200, {"output_dir": self.output_dir})
        elif self.path == "/jobs":
            with jobs_lock:
                self._json_response(200, {"jobs": list(active_jobs.keys())})
        elif self.path.startswith("/jobs/") and self.path.endswith("/log"):
            job_id = self.path[len("/jobs/") : -len("/log")]
            with jobs_lock:
                info = job_logs.get(job_id)
            if info is None:
                self._json_response(404, {"error": "Job not found"})
            else:
                self._json_response(
                    200,
                    {
                        "job_id": job_id,
                        "lines": info["lines"],
                        "done": info["done"],
                        "exit_code": info["exit_code"],
                    },
                )
        else:
            self._json_response(404, {"error": "Not found"})

    # ── POST /download ──
    def do_POST(self):
        if self.path != "/download":
            self._json_response(404, {"error": "Not found"})
            return

        # 驗證 Origin
        origin = self.headers.get("Origin", "")
        if not is_allowed_origin(origin):
            log.warning("Rejected request from origin: %s", origin)
            self._json_response(403, {"error": "Forbidden origin"})
            return

        # 讀取 body
        length = int(self.headers.get("Content-Length", 0))
        if length > 4096:
            self._json_response(400, {"error": "Request too large"})
            return

        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"error": "Invalid JSON"})
            return

        url = body.get("url", "").strip()
        custom_dir = body.get("output_dir", "").strip()

        if not url:
            self._json_response(400, {"error": "Missing url"})
            return

        if not is_valid_url(url):
            log.warning("Rejected invalid/disallowed URL: %s", url)
            self._json_response(400, {"error": "Invalid or disallowed URL"})
            return

        # 若 client 指定了 output_dir，驗證後使用；否則用 server 預設
        if custom_dir:
            if not os.path.isabs(custom_dir):
                self._json_response(400, {"error": "output_dir 必須係絕對路徑"})
                return
            if not is_safe_output_dir(custom_dir):
                self._json_response(400, {"error": "output_dir 不允許"})
                return
            output_dir = custom_dir
        else:
            output_dir = self.output_dir

        job_id = start_download(url, output_dir)
        self._json_response(
            202,
            {
                "message": f"下載已開始 (job: {job_id})",
                "job_id": job_id,
                "output_dir": output_dir,
            },
        )

    def _json_response(self, code: int, data: dict):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        log.info(fmt, *args)


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="MDLR Local Download Server")
    parser.add_argument("--host", default="127.0.0.1", help="綁定 IP（預設 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8765, help="Port（預設 8765）")
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT_DIR,
        help=f"下載儲存路徑（預設 {DEFAULT_OUTPUT_DIR}）",
    )
    args = parser.parse_args()

    # 確保 output dir 存在
    os.makedirs(args.output, exist_ok=True)

    # 注入 output_dir 到 handler class
    Handler.output_dir = args.output

    server = HTTPServer((args.host, args.port), Handler)
    log.info("MDLR Server 已啟動：http://%s:%d", args.host, args.port)
    log.info("下載儲存路徑：%s", args.output)
    log.info("按 Ctrl+C 停止")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Server 已停止")
        server.server_close()


if __name__ == "__main__":
    main()
