#!/usr/bin/env python3
"""
project: neptune — Build Script v3.0.0
Compiles Rust→WASM, embeds all JS modules into a single SVG cartridge.
Usage: python3 build.py
"""

import subprocess
import base64
import sys
import os

PROJ = os.path.dirname(os.path.abspath(__file__))

def run(cmd, **kw):
    print(f"  > {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if result.returncode != 0:
        print("STDOUT:", result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
        print("STDERR:", result.stderr[-2000:] if len(result.stderr) > 2000 else result.stderr)
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return result

def b64_file(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")

def b64_file_optional(path, name):
    """Base64 encode a file, warn if missing (non-critical modules)."""
    if not os.path.exists(path):
        print(f"  [WARN] Optional module not found: {name} ({path}) — skipping")
        return ""
    b64 = b64_file(path)
    print(f"  {name:30s} {len(b64):>8} base64 chars ({os.path.getsize(path):>6} bytes)")
    return b64

def main():
    os.chdir(PROJ)

    print("=" * 60)
    print("  project: neptune — Build v3.0.0")
    print("=" * 60)

    # 1. Compile Rust → WASM
    print("\n[1/6] Compiling Rust WASM kernel...")
    try:
        run(["wasm-pack", "build", "--target", "web", "--out-dir", "pkg",
             "--no-typescript", "--no-opt"])
    except FileNotFoundError:
        print("\nERROR: wasm-pack not found.")
        print("  Install:  curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh")
        sys.exit(1)

    # 2. Read all artifacts
    print("\n[2/6] Reading build artifacts...")
    sw_path = os.path.join(PROJ, "sw.js")
    wasm_js_path = os.path.join(PROJ, "pkg", "neptune_kernel.js")
    wasm_bin_path = os.path.join(PROJ, "pkg", "neptune_kernel_bg.wasm")
    netadapt_path = os.path.join(PROJ, "network_adapter.js")
    fingerprint_path = os.path.join(PROJ, "fingerprint.js")

    # Core required artifacts
    for p in [sw_path, wasm_js_path, wasm_bin_path, netadapt_path, fingerprint_path]:
        if not os.path.exists(p):
            print(f"\nERROR: Missing required artifact: {p}")
            sys.exit(1)

    sw_b64 = b64_file(sw_path)
    wasm_js_b64 = b64_file(wasm_js_path)
    wasm_bin_b64 = b64_file(wasm_bin_path)
    netadapt_b64 = b64_file(netadapt_path)
    fingerprint_b64 = b64_file(fingerprint_path)

    print(f"  {'SW code':30s} {len(sw_b64):>8} base64 chars ({os.path.getsize(sw_path):>6} bytes)")
    print(f"  {'WASM JS glue':30s} {len(wasm_js_b64):>8} base64 chars ({os.path.getsize(wasm_js_path):>6} bytes)")
    print(f"  {'WASM binary':30s} {len(wasm_bin_b64):>8} base64 chars ({os.path.getsize(wasm_bin_path):>6} bytes)")
    print(f"  {'Network adapter':30s} {len(netadapt_b64):>8} base64 chars ({os.path.getsize(netadapt_path):>6} bytes)")
    print(f"  {'Fingerprint JS':30s} {len(fingerprint_b64):>8} base64 chars ({os.path.getsize(fingerprint_path):>6} bytes)")

    # Bootloader
    print("\n  -- Bootloader --")
    bootloader_b64 = b64_file_optional(os.path.join(PROJ, "src", "bootloader.js"), "Bootloader")

    # Transport modules
    print("\n  -- Transport Layer --")
    transports_dir = os.path.join(PROJ, "src", "transports")
    transport_base_b64 = b64_file_optional(os.path.join(transports_dir, "transport.js"), "Transport base")
    transport_detector_b64 = b64_file_optional(os.path.join(transports_dir, "detector.js"), "Transport detector")
    transport_turn_b64 = b64_file_optional(os.path.join(transports_dir, "turn.js"), "TURN relay")
    transport_webrtc_b64 = b64_file_optional(os.path.join(transports_dir, "webrtc.js"), "WebRTC DataChannel")
    transport_smoltcp_b64 = b64_file_optional(os.path.join(transports_dir, "smoltcp.js"), "smoltcp WASM")
    transport_houdini_b64 = b64_file_optional(os.path.join(transports_dir, "houdini.js"), "CSS Houdini")
    transport_tor_b64 = b64_file_optional(os.path.join(transports_dir, "tor.js"), "Tor WASM")
    transport_locks_b64 = b64_file_optional(os.path.join(transports_dir, "locks.js"), "Web Locks")
    transport_svg_gpu_b64 = b64_file_optional(os.path.join(transports_dir, "svg_gpu.js"), "SVG GPU pipeline")
    transport_webcodecs_b64 = b64_file_optional(os.path.join(transports_dir, "webcodecs.js"), "WebCodecs")
    storage_fs_b64 = b64_file_optional(os.path.join(PROJ, "src", "storage", "fs.js"), "File System Access")

    # Engine modules
    print("\n  -- Engine Modules --")
    engine_dir = os.path.join(PROJ, "src", "engine")
    engine_rewriter_b64 = b64_file_optional(os.path.join(engine_dir, "rewriter.js"), "HTML rewriter")
    engine_security_b64 = b64_file_optional(os.path.join(engine_dir, "security.js"), "Security")
    engine_tracker_b64 = b64_file_optional(os.path.join(engine_dir, "tracker.js"), "Tracker blocking")
    engine_cookies_b64 = b64_file_optional(os.path.join(engine_dir, "cookies.js"), "Cookie jar")
    engine_cache_b64 = b64_file_optional(os.path.join(engine_dir, "cache.js"), "Cache API")
    engine_obfuscator_b64 = b64_file_optional(os.path.join(engine_dir, "obfuscator.js"), "Obfuscator")
    engine_logger_b64 = b64_file_optional(os.path.join(engine_dir, "logger.js"), "Logger")
    engine_streaming_rewriter_b64 = b64_file_optional(os.path.join(engine_dir, "streaming-rewriter.js"), "Streaming rewriter")

    # 3. Read template and inject
    print("\n[3/6] Embedding into SVG template...")
    template_path = os.path.join(PROJ, "template.svg")
    with open(template_path, "r") as f:
        svg = f.read()

    # Replace all placeholders
    replacements = {
        '"{{SW_CODE}}"': f'"{sw_b64}"',
        '"{{WASM_JS}}"': f'"{wasm_js_b64}"',
        '"{{WASM_BIN}}"': f'"{wasm_bin_b64}"',
        '"{{NETWORK_ADAPTER}}"': f'"{netadapt_b64}"',
        '"{{FINGERPRINT_JS}}"': f'"{fingerprint_b64}"',
        '"{{BOOTLOADER}}"': f'"{bootloader_b64}"',
        '"{{TRANSPORT_BASE}}"': f'"{transport_base_b64}"',
        '"{{TRANSPORT_DETECTOR}}"': f'"{transport_detector_b64}"',
        '"{{TRANSPORT_TURN}}"': f'"{transport_turn_b64}"',
        '"{{TRANSPORT_WEBRTC}}"': f'"{transport_webrtc_b64}"',
        '"{{TRANSPORT_SMOLTCP_JS}}"': f'"{transport_smoltcp_b64}"',
        '"{{TRANSPORT_HOUDINI}}"': f'"{transport_houdini_b64}"',
        '"{{TRANSPORT_TOR}}"': f'"{transport_tor_b64}"',
        '"{{TRANSPORT_LOCKS}}"': f'"{transport_locks_b64}"',
        '"{{TRANSPORT_SVG_GPU}}"': f'"{transport_svg_gpu_b64}"',
        '"{{TRANSPORT_WEBCODECS}}"': f'"{transport_webcodecs_b64}"',
        '"{{STORAGE_FS}}"': f'"{storage_fs_b64}"',
        '"{{ENGINE_STREAMING_REWRITER}}"': f'"{engine_streaming_rewriter_b64}"',
        '"{{ENGINE_REWRITER}}"': f'"{engine_rewriter_b64}"',
        '"{{ENGINE_SECURITY}}"': f'"{engine_security_b64}"',
        '"{{ENGINE_TRACKER}}"': f'"{engine_tracker_b64}"',
        '"{{ENGINE_COOKIES}}"': f'"{engine_cookies_b64}"',
        '"{{ENGINE_CACHE}}"': f'"{engine_cache_b64}"',
        '"{{ENGINE_OBFUSCATOR}}"': f'"{engine_obfuscator_b64}"',
        '"{{ENGINE_LOGGER}}"': f'"{engine_logger_b64}"',
    }

    for old, new in replacements.items():
        svg = svg.replace(old, new)

    # Verify all placeholders replaced
    all_placeholders = [
        "{{SW_CODE}}", "{{WASM_JS}}", "{{WASM_BIN}}", "{{NETWORK_ADAPTER}}", "{{FINGERPRINT_JS}}",
        "{{BOOTLOADER}}",
        "{{TRANSPORT_BASE}}", "{{TRANSPORT_DETECTOR}}", "{{TRANSPORT_TURN}}",
        "{{TRANSPORT_WEBRTC}}", "{{TRANSPORT_SMOLTCP_JS}}", "{{TRANSPORT_HOUDINI}}",
        "{{TRANSPORT_TOR}}", "{{TRANSPORT_LOCKS}}", "{{TRANSPORT_SVG_GPU}}", "{{TRANSPORT_WEBCODECS}}",
        "{{STORAGE_FS}}", "{{ENGINE_STREAMING_REWRITER}}",
        "{{ENGINE_REWRITER}}", "{{ENGINE_SECURITY}}", "{{ENGINE_TRACKER}}",
        "{{ENGINE_COOKIES}}", "{{ENGINE_CACHE}}", "{{ENGINE_OBFUSCATOR}}", "{{ENGINE_LOGGER}}",
        "{{ENGINE_STREAMING_REWRITER}}",
    ]

    unreplaced = [p for p in all_placeholders if p in svg]
    expected_missing = []  # Optional modules not built yet
    truly_unreplaced = [p for p in unreplaced if p not in expected_missing]

    if truly_unreplaced:
        print(f"\nERROR: Template placeholders not replaced: {truly_unreplaced}")
        sys.exit(1)

    if unreplaced:
        print(f"  [NOTE] Some optional modules not embedded (placeholders left empty): {len(unreplaced)}")
    else:
        print("  OK — all placeholders replaced")

    # 4. Write output
    output_path = os.path.join(PROJ, "neptune.svg")
    with open(output_path, "w") as f:
        f.write(svg)

    size_kb = len(svg) / 1024
    size_mb = size_kb / 1024
    print(f"\n[4/6] Output: {output_path}")
    print(f"  SVG size: {size_kb:.1f} KB ({size_mb:.2f} MB) — {len(svg):,} bytes")

    # 5. Verify no external URLs in cartridge
    print("\n[5/6] Verifying no external references...")
    ext_urls = ["fonts.googleapis", "cdn.jsdelivr", "unpkg.com", "jsdelivr"]
    found = [u for u in ext_urls if u in svg]
    if found:
        print(f"  WARNING: Found external URLs: {found}")
    else:
        print("  OK — no external URLs embedded")

    # 6. Size breakdown
    print("\n[6/6] Final size breakdown:")
    total_chars = 0
    for label, b64str in [
        ("SW Code", sw_b64),
        ("WASM JS", wasm_js_b64),
        ("WASM Bin", wasm_bin_b64),
        ("Network Adapter", netadapt_b64),
        ("Fingerprint", fingerprint_b64),
        ("Bootloader", bootloader_b64),
        ("Transport Base", transport_base_b64),
        ("Transport Detector", transport_detector_b64),
        ("TURN Relay", transport_turn_b64),
        ("WebRTC", transport_webrtc_b64),
        ("smoltcp JS", transport_smoltcp_b64),
        ("Houdini", transport_houdini_b64),
        ("Tor WASM", transport_tor_b64),
        ("Web Locks", transport_locks_b64),
        ("SVG GPU", transport_svg_gpu_b64),
        ("WebCodecs", transport_webcodecs_b64),
        ("File System", storage_fs_b64),
        ("Streaming Rewriter", engine_streaming_rewriter_b64),
        ("Rewriter", engine_rewriter_b64),
        ("Security", engine_security_b64),
        ("Tracker", engine_tracker_b64),
        ("Cookies", engine_cookies_b64),
        ("Cache", engine_cache_b64),
        ("Obfuscator", engine_obfuscator_b64),
        ("Logger", engine_logger_b64),
        ("Streaming Rewriter", engine_streaming_rewriter_b64),
    ]:
        l = len(b64str) if b64str else 0
        total_chars += l
        if l > 0:
            print(f"  {label:25s} {l:>8,} chars  (~{l // 1024:>4} KB)")

    svg_overhead = len(svg) - total_chars
    print(f"  {'─' * 45}")
    print(f"  {'Code total':25s} {total_chars:>8,} chars  (~{total_chars // 1024:>4} KB)")
    print(f"  {'SVG UI/overhead':25s} {svg_overhead:>8,} chars  (~{svg_overhead // 1024:>4} KB)")
    print()
    print("=" * 60)
    print("  BUILD COMPLETE")
    print("=" * 60)
    print()
    print("  The cartridge is a SINGLE FILE:")
    print("    neptune.svg  — embeds SW + WASM + Network Adapter + Fingerprint")
    print("                   + Bootloader + 6 Transports + 7 Engine Modules")
    print()
    print("  Transport Layer (auto-detected at boot):")
    print("    - TURN Relay:     Public STUN/TURN as free TCP relay")
    print("    - smoltcp WASM:   In-browser TCP/IP stack + SW bridge")
    print("    - WebRTC DataCh:  P2P mesh between Neptune instances")
    print("    - CSS Houdini:    Experimental cross-origin reader")
    print()
    print("  Engine Layer:")
    print("    - HTML/CSS/JS rewriter, header sanitization, CSP injection")
    print("    - Tracker blocking, cookie isolation, request caching")
    print("    - Traffic obfuscation, request logging & statistics")
    print()
    print("  To run locally:")
    print("    python3 server.py")
    print("    http://localhost:8080/neptune.svg")
    print()
    print("  To deploy to GitHub Pages / jsDelivr:")
    print("    git add neptune.svg && git commit && git push")
    print("    The SVG is self-contained — no other files needed")
    print("=" * 60)


if __name__ == "__main__":
    main()
