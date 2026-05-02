#!/usr/bin/env python3
"""
project: neptune — Build Script
Compiles Rust→WASM, embeds SW + JS glue + WASM binary into a single SVG cartridge.
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

def main():
    os.chdir(PROJ)

    print("=" * 50)
    print("  project: neptune — Build")
    print("=" * 50)

    # 1. Compile Rust → WASM
    print("\n[1/5] Compiling Rust WASM kernel...")
    try:
        run(["wasm-pack", "build", "--target", "web", "--out-dir", "pkg",
             "--no-typescript", "--no-opt"])
    except FileNotFoundError:
        print("\nERROR: wasm-pack not found.")
        print("  Install:  curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh")
        sys.exit(1)

    # 2. Read artifacts
    print("\n[2/5] Reading build artifacts...")
    sw_path = os.path.join(PROJ, "sw.js")
    wasm_js_path = os.path.join(PROJ, "pkg", "neptune_kernel.js")
    wasm_bin_path = os.path.join(PROJ, "pkg", "neptune_kernel_bg.wasm")

    for p in [sw_path, wasm_js_path, wasm_bin_path]:
        if not os.path.exists(p):
            print(f"\nERROR: Missing artifact: {p}")
            sys.exit(1)

    sw_b64 = b64_file(sw_path)
    wasm_js_b64 = b64_file(wasm_js_path)
    wasm_bin_b64 = b64_file(wasm_bin_path)

    print(f"  SW code:    {len(sw_b64)} base64 chars ({os.path.getsize(sw_path)} bytes)")
    print(f"  WASM JS:    {len(wasm_js_b64)} base64 chars ({os.path.getsize(wasm_js_path)} bytes)")
    print(f"  WASM binary: {len(wasm_bin_b64)} base64 chars ({os.path.getsize(wasm_bin_path)} bytes)")

    # 3. Read template and inject
    print("\n[3/5] Embedding into SVG template...")
    template_path = os.path.join(PROJ, "template.svg")
    with open(template_path, "r") as f:
        svg = f.read()

    # Replace placeholders
    svg = svg.replace('"{{SW_CODE}}"', f'"{sw_b64}"')
    svg = svg.replace('"{{WASM_JS}}"', f'"{wasm_js_b64}"')
    svg = svg.replace('"{{WASM_BIN}}"', f'"{wasm_bin_b64}"')

    # Verify all replaced
    for placeholder in ["{{SW_CODE}}", "{{WASM_JS}}", "{{WASM_BIN}}"]:
        if placeholder in svg:
            print(f"\nERROR: Template placeholder not replaced: {placeholder}")
            sys.exit(1)

    # 4. Write output
    output_path = os.path.join(PROJ, "neptune.svg")
    with open(output_path, "w") as f:
        f.write(svg)

    size_kb = len(svg) / 1024
    print(f"\n[4/5] Output: {output_path}")
    print(f"  SVG size: {size_kb:.1f} KB ({len(svg)} bytes)")

    # 5. Verify no external URLs in cartridge
    print("\n[5/5] Verifying no external references...")
    ext_urls = ["fonts.googleapis", "cdn.jsdelivr", "unpkg.com", "jsdelivr"]
    found = [u for u in ext_urls if u in svg]
    if found:
        print(f"  WARNING: Found external URLs: {found}")
    else:
        print("  OK — no external URLs embedded")

    print()
    print("=" * 50)
    print("  BUILD COMPLETE")
    print("=" * 50)
    print()
    print("  The cartridge is a SINGLE FILE:")
    print("    neptune.svg  — embeds SW + WASM JS glue + WASM binary")
    print()
    print("  To run locally (proxy + static server):")
    print("    python3 server.py")
    print("    http://localhost:8080/neptune.svg?url=https://example.com")
    print()
    print("  To deploy to GitHub Pages / jsDelivr:")
    print("    git add neptune.svg && git commit && git push")
    print("    The SVG is self-contained — no other files needed")
    print("    (But proxy still requires a local server.py or hosted proxy)")
    print("=" * 50)

if __name__ == "__main__":
    main()
