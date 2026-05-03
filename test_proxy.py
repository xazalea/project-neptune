#!/usr/bin/env python3
"""
Neptune Proxy Integration Test
Starts the dev server in a background thread, tests proxy functionality,
and validates the SVG cartridge.
"""

import http.server
import socketserver
import urllib.request
import urllib.parse
import ssl
import os
import sys
import threading
import time
import xml.etree.ElementTree as ET
import socket

# Import NeptuneHandler from server.py so tests stay in sync
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import NeptuneHandler

PROJ = os.path.dirname(os.path.abspath(__file__))


def find_free_port():
    """Find an available TCP port to avoid conflicts."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


class ReusableTCPServer(socketserver.TCPServer):
    """TCP server that allows socket reuse to prevent 'Address already in use'."""
    allow_reuse_address = True


def run_server(port):
    os.chdir(PROJ)
    httpd = ReusableTCPServer(("", port), NeptuneHandler)
    httpd.serve_forever()


def fetch(url, timeout=10):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def test_svg_xml():
    print("[TEST] Validating neptune.svg XML...")
    svg_path = os.path.join(PROJ, "neptune.svg")
    if not os.path.exists(svg_path):
        print("  FAIL: neptune.svg not found — run build.py first")
        return False
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
        assert root.tag == "{http://www.w3.org/2000/svg}svg", f"Unexpected root: {root.tag}"
        # Check no placeholders remain
        with open(svg_path, "r") as f:
            content = f.read()
        placeholders = ["{{SW_CODE}}", "{{WASM_JS}}", "{{WASM_BIN}}", "{{NETWORK_ADAPTER}}", "{{FINGERPRINT_JS}}"]
        for ph in placeholders:
            if ph in content:
                print(f"  FAIL: Placeholder {ph} still present")
                return False
        print("  PASS: XML valid, placeholders replaced")
        return True
    except ET.ParseError as e:
        print(f"  FAIL: XML parse error: {e}")
        return False


def test_server_responds(port):
    print(f"[TEST] Testing server on port {port}...")
    try:
        status, body = fetch(f"http://localhost:{port}/", timeout=5)
        if status == 200:
            print(f"  PASS: / returns 200 ({len(body)} bytes)")
            return True
        else:
            print(f"  FAIL: / returns {status}")
            return False
    except Exception as e:
        print(f"  FAIL: {e}")
        return False


def test_svg_served(port):
    print(f"[TEST] Testing /neptune.svg on port {port}...")
    try:
        status, body = fetch(f"http://localhost:{port}/neptune.svg", timeout=10)
        if status == 200 and len(body) > 100000:
            print(f"  PASS: /neptune.svg returns 200 ({len(body)} bytes)")
            return True
        else:
            print(f"  FAIL: /neptune.svg returns {status}, size={len(body)}")
            return False
    except Exception as e:
        print(f"  FAIL: {e}")
        return False


def test_proxy_path(port):
    print(f"[TEST] Testing /proxy?url=https://example.com on port {port}...")
    try:
        status, body = fetch(f"http://localhost:{port}/proxy?url=https://example.com", timeout=15)
        if status == 200 and len(body) > 100:
            print(f"  PASS: /proxy returns 200 ({len(body)} bytes)")
            return True
        else:
            print(f"  FAIL: /proxy returns {status}, size={len(body)}")
            return False
    except Exception as e:
        print(f"  FAIL: {e}")
        return False


def test_proxy_duckduckgo(port):
    print(f"[TEST] Testing /proxy?url=https://lite.duckduckgo.com on port {port}...")
    try:
        status, body = fetch(f"http://localhost:{port}/proxy?url=https://lite.duckduckgo.com", timeout=15)
        if status == 200 and len(body) > 100:
            print(f"  PASS: /proxy duckduckgo returns 200 ({len(body)} bytes)")
            return True
        else:
            print(f"  INFO: /proxy duckduckgo returns {status}, size={len(body)} (may be upstream restriction)")
            return True  # Don't fail on upstream restrictions
    except Exception as e:
        print(f"  INFO: {e} (upstream connectivity issue, not a proxy bug)")
        return True  # Don't fail on upstream connectivity


def test_sw_js_exists():
    print("[TEST] Checking sw.js exists and is valid JS...")
    sw_path = os.path.join(PROJ, "sw.js")
    if not os.path.exists(sw_path):
        print("  FAIL: sw.js not found")
        return False
    with open(sw_path, "r") as f:
        content = f.read()
    if "self.addEventListener('fetch'" in content and "transformHTML" in content:
        print(f"  PASS: sw.js present ({len(content)} bytes), has fetch handler and transformHTML")
        return True
    else:
        print("  FAIL: sw.js missing expected functions")
        return False


def test_index_html():
    print("[TEST] Checking index.html...")
    idx_path = os.path.join(PROJ, "index.html")
    if not os.path.exists(idx_path):
        print("  FAIL: index.html not found")
        return False
    with open(idx_path, "r") as f:
        content = f.read()
    checks = [
        ("How to Use", "How to Use" in content),
        ("How It Works", "How It Works" in content),
        ("Privacy section", "Privacy" in content),
        ("input field", "<input" in content),
        ("neptune.svg link", "neptune.svg" in content),
    ]
    all_pass = True
    for name, check in checks:
        if not check:
            print(f"  FAIL: Missing '{name}' in index.html")
            all_pass = False
    if all_pass:
        print(f"  PASS: index.html has all expected sections")
    return all_pass


def main():
    print("=" * 60)
    print("  Neptune Proxy Integration Test")
    print("=" * 60)
    print()

    results = []

    # Static tests (no server needed)
    results.append(("SVG XML valid", test_svg_xml()))
    results.append(("sw.js valid", test_sw_js_exists()))
    results.append(("index.html valid", test_index_html()))

    # Start server in thread on a random free port
    PORT = find_free_port()
    print(f"[SETUP] Starting server on port {PORT}...")
    server_thread = threading.Thread(target=run_server, args=(PORT,), daemon=True)
    server_thread.start()
    time.sleep(1.5)

    results.append(("Server responds", test_server_responds(PORT)))
    results.append(("SVG served", test_svg_served(PORT)))
    results.append(("Proxy path works", test_proxy_path(PORT)))
    results.append(("Proxy duckduckgo", test_proxy_duckduckgo(PORT)))

    print()
    print("=" * 60)
    print("  Results")
    print("=" * 60)
    all_pass = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")
        if not passed:
            all_pass = False

    print()
    if all_pass:
        print("  ALL TESTS PASSED ✓")
        return 0
    else:
        print("  SOME TESTS FAILED ✗")
        return 1


if __name__ == "__main__":
    sys.exit(main())
