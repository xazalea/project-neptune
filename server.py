#!/usr/bin/env python3
"""
project: neptune — Local Dev Server + Friendly Proxy + WebRTC Signaling
No external APIs. Serves static files, proxies requests, and handles WebRTC signaling.
"""

import http.server
import urllib.request
import urllib.parse
import ssl
import sys
import os
import json
import threading
import time

PORT = 8080
PROXY_PATH = "/proxy"
SIGNAL_PATH = "/signal"

# Headers stripped from proxied responses because they block iframe embedding
# or interfere with the proxy's security model.
PROXY_BLOCKED_RESPONSE_HEADERS = {
    "transfer-encoding", "content-encoding", "content-length",
    "x-frame-options", "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "cross-origin-embedder-policy", "cross-origin-opener-policy",
    "permissions-policy", "set-cookie", "x-content-type-options",
}

# In-memory signal store for WebRTC
signals = {}
signal_lock = threading.Lock()

class NeptuneHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {args[0]} {args[1]}", flush=True)

    def end_headers(self):
        # NOTE: Cross-Origin-Embedder-Policy: credentialless prevents the Service
        # Worker from claiming the page (separate network partition). Removed.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == PROXY_PATH:
            self._handle_proxy(parsed.query)
            return
        if parsed.path == SIGNAL_PATH:
            self._handle_signal_get(parsed.query)
            return
        if parsed.path == '/sw.js':
            self._serve_sw_js()
            return

        super().do_GET()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == PROXY_PATH:
            self._handle_proxy(parsed.query, head_only=True)
            return
        if parsed.path == '/sw.js':
            self._serve_sw_js(head_only=True)
            return
        super().do_HEAD()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == PROXY_PATH:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length else b""
            self._handle_proxy(parsed.query, body)
            return
        if parsed.path == SIGNAL_PATH:
            self._handle_signal_post()
            return

        # Unmatched POST — drain body to avoid TCP RST, then return 405
        content_length = int(self.headers.get("Content-Length", 0))
        while content_length > 0:
            chunk = self.rfile.read(min(content_length, 65536))
            if not chunk:
                break
            content_length -= len(chunk)
        self.send_response(405)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Method Not Allowed\n")

    def _handle_proxy(self, query, body=None, head_only=False):
        params = urllib.parse.parse_qs(query)
        target = params.get("url", [None])[0]

        if not target:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Missing ?url= parameter\n")
            return

        try:
            req_headers = dict(self.headers)
            req_headers.pop("Host", None)
            req_headers.pop("Origin", None)
            req_headers.pop("Referer", None)

            req = urllib.request.Request(
                target,
                headers=req_headers,
                method="POST" if body else "GET",
                data=body
            )

            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in PROXY_BLOCKED_RESPONSE_HEADERS:
                        self.send_header(k, v)
                self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
                self.end_headers()
                if not head_only:
                    self.wfile.write(resp.read())

        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(f"""<html>
<body style="background:#0a0a0f;color:#ff4444;font-family:monospace;padding:20px;">
<h1>Proxy Error</h1>
<pre>{type(e).__name__}: {e}</pre>
<p style="color:#888;">Target: {target}</p>
</body></html>""".encode())

    def _handle_signal_get(self, query):
        """Long-poll for WebRTC signals."""
        params = urllib.parse.parse_qs(query)
        peer_id = params.get("peer", [None])[0]
        if not peer_id:
            self.send_response(400)
            self.end_headers()
            return

        # Wait up to 30s for a signal
        start = time.time()
        while time.time() - start < 30:
            with signal_lock:
                if peer_id in signals and signals[peer_id]:
                    signal = signals[peer_id].pop(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(signal).encode())
                    return
            time.sleep(0.5)

        # Timeout — return empty
        self.send_response(204)
        self.end_headers()

    def _serve_sw_js(self, head_only=False):
        sw_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sw.js')
        if not os.path.exists(sw_path):
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript; charset=utf-8')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(os.path.getsize(sw_path)))
        self.end_headers()
        if not head_only:
            with open(sw_path, 'rb') as f:
                self.wfile.write(f.read())

    def _handle_signal_post(self):
        """Post a WebRTC signal."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)

        target_peer = data.get("target")
        if not target_peer:
            self.send_response(400)
            self.end_headers()
            return

        with signal_lock:
            if target_peer not in signals:
                signals[target_peer] = []
            signals[target_peer].append(data)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def run():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"=" * 60, flush=True)
    print(f"  project: neptune — Local Dev Server", flush=True)
    print(f"  http://localhost:{PORT}/", flush=True)
    print(f"  Proxy:   http://localhost:{PORT}{PROXY_PATH}?url=...", flush=True)
    print(f"  Signal:  http://localhost:{PORT}{SIGNAL_PATH}", flush=True)
    print(f"=" * 60, flush=True)
    print(flush=True)
    print(f"  Quick start:", flush=True)
    print(f"    1. Build:    python3 build.py", flush=True)
    print(f"    2. Open:     http://localhost:{PORT}/neptune.svg?url=https://example.com", flush=True)
    print(f"=" * 60, flush=True)
    httpd = http.server.ThreadingHTTPServer(("", PORT), NeptuneHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\nShutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run()
