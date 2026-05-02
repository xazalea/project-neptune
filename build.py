#!/usr/bin/env python3
"""
project: neptune — Build Script
Compiles Rust→WASM, embeds binary into SVG template, produces neptune.svg cartridge.
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
        print("STDOUT:", result.stdout)
        print("STDERR:", result.stderr)
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return result

def main():
    os.chdir(PROJ)

    print("=" * 50)
    print("  project: neptune — Build")
    print("=" * 50)

    # 1. Compile Rust → WASM
    print("\n[1/4] Compiling Rust WASM kernel...")
    try:
        run(["wasm-pack", "build", "--target", "web", "--out-dir", "pkg",
             "--no-typescript", "--no-opt"])
    except FileNotFoundError:
        print("\nERROR: wasm-pack not found.")
        print("  Install:  curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh")
        sys.exit(1)

    # 2. Read WASM binary
    print("\n[2/4] Reading WASM binary...")
    wasm_path = os.path.join(PROJ, "pkg", "neptune_kernel_bg.wasm")
    with open(wasm_path, "rb") as f:
        wasm_bytes = f.read()
    wasm_b64 = base64.b64encode(wasm_bytes).decode("ascii")
    print(f"  WASM size: {len(wasm_bytes)} bytes → {len(wasm_b64)} base64 chars")

    # 3. Read template and inject
    print("\n[3/4] Embedding into SVG template...")
    template_path = os.path.join(PROJ, "template.svg")
    with open(template_path, "r") as f:
        template = f.read()

    # Replace placeholder with base64 WASM
    svg = template.replace('"{{WASM_BIN}}"', f'"{wasm_b64}"')
    # JS glue is loaded dynamically from pkg/ — no need to embed it
    svg = svg.replace('"{{WASM_JS}}"', '""')

    # 4. Write output
    output_path = os.path.join(PROJ, "neptune.svg")
    with open(output_path, "w") as f:
        f.write(svg)

    size_kb = len(svg) / 1024
    print(f"\n[4/4] Output: {output_path}")
    print(f"  SVG size: {size_kb:.1f} KB")
    print()
    print("=" * 50)
    print("  BUILD COMPLETE")
    print("=" * 50)
    print()
    print("  Files needed to run:")
    print("    neptune.svg          — Main cartridge (embedded WASM)")
    print("    sw.js                — Service Worker (browser requirement)")
    print("    pkg/                 — WASM JS glue + binary")
    print()
    print("  Next step:")
    print("    python3 server.py")
    print("    http://localhost:8080/neptune.svg?url=https://example.com")
    print("=" * 50)

if __name__ == "__main__":
    main()
