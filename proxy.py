#!/usr/bin/env python3
"""大盘云图（dpyt.org）复刻版 —— 本地服务 + 自建行情后端。

两条链路：
  1. 静态文件：托管 dpyt-clone 目录（index.html / assets/*）；
  2. 行情接口：/api/heatmap/* 由本进程用 datasource.py 现场聚合，
     数据来自腾讯行情（qt.gtimg.cn），**不依赖 dpyt.org**。

接口与原站同构，前端无需改动：
    GET /api/heatmap/treemap?period=day&market=all
    GET /api/heatmap/overview?period=day
    GET /api/heatmap/quotes/stream?period=day      # NDJSON，三帧
    GET /api/heatmap/quotes?period=day&codes=600519,000001
    GET /api/heatmap/status                        # 自建：后端健康度

上游行情整体失效时返回 502，前端会自动降级到 assets/data 打包快照。

用法：
    python3 proxy.py            # http://127.0.0.1:8000
    python3 proxy.py 9000       # 指定端口
    DPYT_UPSTREAM=https://dpyt.org python3 proxy.py   # 可选：改回转发原站
"""
from __future__ import annotations

import gzip
import http.server
import json
import os
import socketserver
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import datasource as DS

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
# 设置该环境变量则退回「反向代理 dpyt.org」模式，默认关闭（完全自建）
UPSTREAM = os.environ.get("DPYT_UPSTREAM", "").rstrip("/")
TIMEOUT = 25
CN_TZ = timezone(timedelta(hours=8))

PASSTHROUGH_HEADERS = {
    "content-type",
    "content-length",
    "x-heatmap-cache",
    "x-heatmap-coverage",
    "x-heatmap-excluded-count",
    "x-heatmap-generated-at",
    "x-heatmap-quote-at",
    "x-heatmap-quote-count",
    "x-heatmap-snapshot",
    "x-heatmap-universe-count",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ------------------------------------------------------------ 响应工具
    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self._common_headers()
        for k, v in (extra or {}).items():
            if v is not None:
                self.send_header(k, str(v))
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload, extra: dict | None = None, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _common_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", ",".join(sorted(PASSTHROUGH_HEADERS)))
        self.send_header("Cache-Control", "no-store")

    # ------------------------------------------------------------ 行情接口
    def _meta_headers(self) -> dict:
        snap = dict(DS.SNAPSHOT)
        ok = bool(snap.get("quotes"))
        return {
            "x-heatmap-snapshot": "live" if ok else "stale",
            "x-heatmap-quote-at": snap.get("updatedAt"),
            "x-heatmap-quote-count": snap.get("count") or 0,
            "x-heatmap-universe-count": len(DS.universe()) if DS._universe else 0,
            "x-heatmap-generated-at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
            "x-heatmap-source": "tencent",
        }

    def _api(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        period = (params.get("period", ["day"])[0] or "day").lower()
        market = (params.get("market", ["all"])[0] or "all").lower()
        if period not in DS.PERIOD_FIELD:
            period = "day"
        route = parsed.path.rstrip("/")

        try:
            if route == "/api/heatmap/status":
                self._json(DS.status())
                return

            if route == "/api/heatmap/treemap":
                data = DS.build_treemap(market, period)
                if not data["stockCount"]:
                    self._degrade("market_not_found", market=market)
                    return
                self._json(data, self._meta_headers())
                return

            if route == "/api/heatmap/overview":
                self._json(DS.build_overview(period), self._meta_headers())
                return

            if route == "/api/heatmap/quotes/stream":
                body = DS.build_stream(period).encode("utf-8")
                self._send(200, body, "application/x-ndjson; charset=utf-8", self._meta_headers())
                return

            if route == "/api/heatmap/quotes":
                codes = params.get("codes", [""])[0]
                wanted = [c.strip() for c in codes.split(",") if c.strip()] or None
                self._json(DS.build_quotes(period, wanted), self._meta_headers())
                return
        except Exception as exc:            # 聚合过程异常：让前端降级
            self._degrade("internal_error", detail=str(exc))
            return

        self._degrade("unknown_route", detail=parsed.path, status=404)

    def _degrade(self, reason: str, status: int = 502, **extra):
        payload = {"error": reason, **extra}
        self._json(payload, self._meta_headers(), status=status)

    # ------------------------------------------------------------ 可选转发
    def _proxy_upstream(self, body: bool) -> None:
        req = urllib.request.Request(UPSTREAM + self.path, method="GET")
        req.add_header("User-Agent", "dpyt-clone-proxy/2.0")
        req.add_header("Accept-Encoding", "identity")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read() if body else b""
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in PASSTHROUGH_HEADERS:
                        self.send_header(k, v)
                self._common_headers()
                if not body:
                    self.send_header("Content-Length", "0")
                self.end_headers()
                if body:
                    self.wfile.write(data)
        except Exception as exc:
            self._degrade("upstream_unreachable", detail=str(exc))

    # ------------------------------------------------------------ 入口
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._common_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        if self.path.startswith("/api/"):
            if UPSTREAM:
                self._proxy_upstream(body=False)
            else:
                self._api()
        else:
            super().do_HEAD()

    def do_GET(self) -> None:
        if self.path.startswith("/api/"):
            if UPSTREAM:
                self._proxy_upstream(body=True)
            else:
                self._api()
        else:
            super().do_GET()

    def end_headers(self) -> None:
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def refresher(stop: threading.Event) -> None:
    """后台定时刷新：交易时段每 8 秒，其余每 5 分钟。"""
    while not stop.is_set():
        try:
            DS.refresh()
        except Exception as exc:
            sys.stderr.write("[refresh] %s\n" % exc)
        stop.wait(8 if DS.is_trading_time() else 300)


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    print("大盘云图复刻版（自建行情后端）")
    print("  数据源: 腾讯行情 qt.gtimg.cn（股票池 %d 只，来自打包快照）" % len(DS.universe()))
    if UPSTREAM:
        print("  模式: 反向代理 %s" % UPSTREAM)
    else:
        print("  模式: 本地聚合（不依赖 dpyt.org）")
    print("  地址: http://127.0.0.1:%d/" % PORT)
    DS.warm_up()
    stop = threading.Event()
    threading.Thread(target=refresher, args=(stop,), daemon=True).start()
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print("Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            stop.set()
            print("\n已停止")
