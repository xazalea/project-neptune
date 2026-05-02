#!/usr/bin/env python3
"""
project: neptune — Local Dev Server + Friendly Proxy
No external APIs. Serves static files and handles proxy requests locally.
"""

import http.server
import socketserver
import urllib.request
import urllib.parse
import ssl
import sys
import os

PORT = 8080
PROXY_PATH = "/proxy"

class NeptuneHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Clean logs
        print(f"[{self.log_date_time_string()}] {args[0]} {args[1]}")

    def end_headers(self):
        # Always allow CORS for local dev
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

        # Serve static files
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == PROXY_PATH:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length else b""
            self._handle_proxy(parsed.query, body)
            return

        super().do_GET()

    def _handle_proxy(self, query, body=None):
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

            # Disable SSL verification for testing
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ("transfer-encoding", "content-encoding", "content-length"):
                        self.send_header(k, v)
                self.end_headers()
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


def run():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with socketserver.TCPServer(("", PORT), NeptuneHandler) as httpd:
        print(f"=" * 50)
        print(f"  project: neptune — Local Dev Server")
        print(f"  http://localhost:{PORT}/")
        print(f"  Proxy endpoint: http://localhost:{PORT}{PROXY_PATH}?url=...")
        print(f"=" * 50)
        print()
        print(f"  Quick start:")
        print(f"    1. Build:    python3 build.py")
        print(f"    2. Open:     http://localhost:{PORT}/neptune.svg?url=https://example.com")
        print(f"=" * 50)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\nShutting down.")


if __name__ == "__main__":
    run()
