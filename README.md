# project: neptune — WASM Unikernel Proxy

A browser-based proxy/unikernel that bootstraps from a **single SVG file**. Zero external dependencies in the cartridge. Multi-strategy CORS bypass.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  neptune.svg (single-file cartridge, ~4MB)                        │
│  ├─ Terminal UI (SVG foreignObject)                              │
│  ├─ SW kernel code     — embedded as base64 blob                 │
│  ├─ WASM JS glue       — embedded as base64 blob                 │
│  ├─ WASM binary        — embedded as base64 blob (Rust kernel)   │
│  └─ Bootloader script                                              │
│      ├─ Parse ?url= target                                        │
│      ├─ Decode SW → blob URL → register as Service Worker        │
│      ├─ Decode WASM JS → blob URL → dynamic import               │
│      ├─ Decode WASM binary → Response → init kernel               │
│      └─ Create iframe for proxied viewport                       │
└─────────────────────────────────────────────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
  ┌─────────────┐          ┌─────────────┐           ┌─────────────┐
  │ Extension   │          │ iframe      │           │ WebRTC P2P  │
  │ (no CORS)   │          │ Relay       │           │ Mesh        │
  │             │          │ (if frame   │           │ (peer node) │
  │ chrome.ext  │          │  allowed)   │           │             │
  └─────────────┘          └─────────────┘           └─────────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │  Service Worker Kernel        │
                    │  ├─ Strategy auto-detection   │
                    │  ├─ Fetch interception        │
                    │  ├─ HTML transformation       │
                    │  │   ├─ URL rewriting          │
                    │  │   ├─ Tracker stripping    │
                    │  │   └─ Runtime injection     │
                    │  └─ WebRTC signaling          │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
         ┌──────────────────┐      ┌──────────────────┐
         │ Local Proxy      │      │ Hosted Proxy     │
         │ (python3 server)│      │ (configurable)   │
         │ /proxy?url=...   │      │                  │
         └──────────────────┘      └──────────────────┘
```

## Quick Start

```bash
# Build the cartridge (embeds SW + WASM JS + WASM binary into SVG)
python3 build.py

# Start local server + proxy + WebRTC signaling
python3 server.py

# Open in browser
http://localhost:8080/neptune.svg?url=https://example.com
```

Or open `http://localhost:8080/` for a landing page.

## Multi-Strategy CORS Bypass

The Service Worker automatically tries strategies in priority order:

| Priority | Strategy | Description | Requirements |
|----------|----------|-------------|--------------|
| 1 | **Extension** | Direct fetch with `<all_urls>` permission | Browser extension |
| 2 | **iframe Relay** | postMessage to same-origin iframe | Target allows framing |
| 3 | **WebRTC P2P** | Data channel to peer with internet | Peer node + signaling |
| 4 | **Local Proxy** | `/proxy?url=...` endpoint on localhost | `python3 server.py` |
| 5 | **Hosted Proxy** | Configurable remote proxy endpoint | Hosted proxy server |

Configure manually:
```javascript
navigator.serviceWorker.controller.postMessage({
  type: 'SET_STRATEGY', strategy: 'webrtc'  // or 'extension', 'iframe', 'local', 'hosted'
});
navigator.serviceWorker.controller.postMessage({
  type: 'SET_PROXY', url: 'https://your-proxy.com/fetch?url='
});
```

## What the WASM Kernel Does

The Rust-compiled WASM kernel (`src/lib.rs`) provides:

- **DOM AST Parser** (`tl` crate): Parses HTML into structured resource nodes
- **Resource Graph**: Tracks scripts, stylesheets, images, iframes, XHRs
- **Tracker Stripping**: Blocks known analytics/trackers (GA, GTM, Facebook, etc.)
- **URL Rewriting**: Proxies all resources through `/proxy?url=...`
- **State Snapshots**: Serializes entire heap to base64 for persistence

## Files

| File | Size | Purpose | Deploy? |
|------|------|---------|---------|
| `neptune.svg` | ~4MB | **Cartridge** — single self-contained file | **Yes** |
| `template.svg` | 6KB | Build source for the cartridge | No |
| `sw.js` | 15KB | Service Worker source (embedded in SVG) | Source only |
| `src/lib.rs` | 20KB | Rust WASM kernel (DOM parser, tracker stripper) | Source only |
| `build.py` | 3KB | Build script — compiles + embeds everything | Source only |
| `server.py` | 5KB | Local dev server + proxy + WebRTC signaling | Optional |
| `index.html` | 3KB | Landing page with URL input | Optional |

## Deployment

### The Cartridge (`neptune.svg`)

The SVG is **completely self-contained**. It can be served from any static host.

**Important:** `raw.githubusercontent.com` adds a `sandbox` CSP that **blocks Service Workers**. Use one of these:

**GitHub Pages:**
```bash
git checkout -b gh-pages
git add neptune.svg index.html server.py
git commit -m "deploy"
git push origin gh-pages
# Enable Pages in repo settings
```

**jsDelivr CDN** (correct MIME types + CORS):
```
https://cdn.jsdelivr.net/gh/<user>/<repo>@main/neptune.svg?url=https://example.com
```

### The Proxy Endpoint

The proxy requires a server because browsers block cross-origin `fetch()` (CORS).

| Option | Setup |
|--------|-------|
| **Local** | `python3 server.py` — runs on localhost:8080 |
| **Hosted** | `postMessage({type:'SET_PROXY', url:'...'})` |
| **Extension** | Package as browser extension — no proxy needed |
| **WebRTC** | Connect to peer node via `/signal` endpoint |

## State Snapshots

The WASM kernel serializes its entire heap to base64:

```javascript
// Inside the SVG context (DevTools console)
const urlWithState = window.exportState();
// Produces: neptune.svg?url=...&state=BASE64...
```

This persists:
- VFS entries (`/etc`, `/var`, `/home`)
- Request counts
- Proxy rules
- Resource graph
- Sessions

## Build Requirements

- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Python 3
- Rust toolchain

## Security

- Service Workers require HTTPS or localhost
- The proxy server fetches arbitrary URLs — run only locally or behind auth
- Extension mode has full cross-origin access — use responsibly
- Tracker stripping blocks known analytics domains but is not exhaustive
