# project: neptune — WASM Unikernel Proxy

A browser-based proxy/unikernel that bootstraps from a **single SVG file**. Zero external dependencies in the cartridge. Multi-strategy CORS bypass.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  neptune.svg (single-file cartridge, ~3MB)                      │
│  ├─ Terminal UI (SVG foreignObject)                             │
│  ├─ SW kernel code     — embedded as base64 blob                │
│  ├─ WASM JS glue       — embedded as base64 blob                │
│  ├─ WASM binary        — embedded as base64 blob (Rust kernel)  │
│  └─ Bootloader script                                             │
│      ├─ Parse ?url= target                                       │
│      ├─ Decode SW → blob URL → register as Service Worker       │
│      ├─ Decode WASM JS → blob URL → dynamic import              │
│      ├─ Decode WASM binary → Response → init kernel             │
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
                    │  Service Worker Kernel      │
                    │  ├─ Strategy auto-detection  │
                    │  ├─ Fetch interception       │
                    │  ├─ HTML transformation      │
                    │  │   ├─ URL rewriting        │
                    │  │   ├─ Tracker stripping    │
                    │  │   └─ Runtime injection    │
                    │  └─ WebRTC signaling         │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
         ┌──────────────────┐      ┌──────────────────┐
         │ Local Proxy      │      │ Hosted Proxy     │
         │ (python3 server) │      │ (configurable)   │
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

## How to Use the Proxy

### Basic Usage

1. **Start the server:**
   ```bash
   python3 server.py
   ```
   This starts a local HTTP server on `http://localhost:8080/`

2. **Open the proxy:**
   - Direct: `http://localhost:8080/neptune.svg?url=https://example.com`
   - Or use the landing page at `http://localhost:8080/`

3. **Navigate:** Type any URL in the address bar and press Enter. The proxy will:
   - Fetch the target site via ServiceWorker
   - Rewrite all resource URLs to route through the proxy
   - Load the page in an iframe with full browser functionality

### URL Formats

| Format | Example | Description |
|--------|---------|-------------|
| `neptune.svg?url=https://target.com` | `neptune.svg?url=https://google.com` | Direct target |
| `neptune.svg?url=https://target.com&__nptn=1` | Internal | Iframe navigation mode |
| `?url=https://target.com&state=BASE64...` | With saved state | Resumable sessions |

### Proxy Parameters

| Parameter | Description |
|-----------|-------------|
| `url` | Target URL to proxy |
| `__nptn` | Internal flag for iframe navigation |
| `state` | Base64-encoded session state for persistence |

## Multi-Strategy CORS Bypass

The Service Worker automatically tries strategies in priority order:

| Priority | Strategy | Description | Requirements |
|----------|----------|-------------|--------------|
| 1 | **CORS Direct** | SW fetches target directly | Works for most sites |
| 2 | **iframe Relay** | postMessage to same-origin iframe | Target allows framing |
| 3 | **Local Proxy** | `/proxy?url=...` endpoint on localhost | `python3 server.py` |
| 4 | **WebRTC P2P** | Data channel to peer with internet | Peer node + signaling |
| 5 | **Extension** | Direct fetch with `<all_urls>` permission | Browser extension |

### Manual Strategy Selection

```javascript
// Set strategy via browser console
navigator.serviceWorker.controller.postMessage({
  type: 'SET_STRATEGY',
  strategy: 'cors'  // or 'iframe', 'local', 'webrtc', 'extension'
});

// Set custom proxy endpoint
navigator.serviceWorker.controller.postMessage({
  type: 'SET_PROXY',
  url: 'https://your-proxy.com/fetch?url='
});
```

## Features

### Browser UI
- **Address bar** with lock indicator and strategy display
- **Navigation** — Back, Forward, Refresh, Home buttons
- **Tab management** — Multiple proxy tabs with history
- **Bookmarks** — Save and manage favorite sites (Ctrl+D)
- **Reader Mode** — Distraction-free reading (Ctrl+Shift+R)
- **Responsive Tester** — Test sites at different viewport sizes (Ctrl+Shift+M)
- **Network Inspector** — Monitor all proxied requests (Ctrl+Shift+I)
- **Console** — Execute JavaScript in proxied page context
- **Dark/Light theme** toggle

### Privacy & Security
- **Anti-fingerprinting** — Canvas, WebGL, AudioContext, navigator spoofing
- **Tracker blocking** — Blocks known analytics, ad, and tracking domains
- **Cookie jar** — Per-domain simulated cookies stored locally
- **Traffic obfuscation** — Randomized header profiles and timing jitter
- **Header sanitization** — Strips CSP, X-Frame-Options, and other restrictive headers
- **All data stays local** — Bookmarks, history, and settings in browser only

### WASM Kernel Capabilities

The Rust-compiled WASM kernel (`src/lib.rs`) provides:

- **DOM AST Parser** — Parses HTML into structured resource nodes
- **Resource Graph** — Tracks scripts, stylesheets, images, iframes, XHRs
- **Tracker Stripping** — Blocks known analytics/trackers (GA, GTM, Facebook, etc.)
- **URL Rewriting** — Proxies all resources through `/proxy?url=...`
- **State Snapshots** — Serializes entire heap to base64 for persistence

## Deployment

### Local Development

```bash
# Build the cartridge
python3 build.py

# Start server
python3 server.py

# Open browser to:
# - http://localhost:8080/ (landing page)
# - http://localhost:8080/neptune.svg?url=https://example.com
```

### GitHub Pages

```bash
git checkout -b gh-pages
git add neptune.svg index.html server.py
git commit -m deploy
git push origin gh-pages
# Enable Pages in repo settings → Pages → Source: gh-pages branch
```

**Important:** `raw.githubusercontent.com` adds a `sandbox` CSP that **blocks Service Workers**. Use GitHub Pages or jsDelivr CDN instead.

### jsDelivr CDN

The SVG is completely self-contained and works on any static host.

```bash
# Deploy to any GitHub repo, then access via jsDelivr:
https://cdn.jsdelivr.net/gh/<user>/<repo>@main/neptune.svg?url=https://example.com
```

Or use the landing page:
```bash
https://cdn.jsdelivr.net/gh/<user>/<repo>@main/index.html?url=https://example.com
```

### CDN Co-hosting

For CDN compatibility, `sw.js` is also written as a standalone file alongside `neptune.svg`. The bootloader will:
1. Try to register `./sw.js` from the same origin (works on CDNs with correct MIME type)
2. Fall back to the embedded base64 ServiceWorker in the SVG blob URL

## Transport Layer

The proxy includes 13 transport modules auto-detected at boot:

| Transport | Description |
|-----------|-------------|
| **Transport Base** | Core transport interface |
| **Transport Detector** | Auto-detection of best transport |
| **TURN Relay** | Public STUN/TURN as free TCP relay |
| **WebRTC DataChannel** | P2P mesh between Neptune instances |
| **smoltcp WASM** | In-browser TCP/IP stack + SW bridge |
| **CSS Houdini** | Experimental cross-origin reader |
| **Tor WASM** | Anonymous routing via Tor network |
| **Web Locks** | Synchronized cross-tab locking |
| **SVG GPU** | GPU-accelerated rendering pipeline |
| **WebCodecs** | Hardware-accelerated video/audio codec |
| **AudioWorklet Modem** | Audio-based data transfer |
| **OPFS Ring Buffer** | Async file system with ring buffers |
| **WebRTC Local Mesh** | Local network peer discovery |

## Engine Layer

13 engine modules provide advanced proxy features:

| Engine | Purpose |
|--------|---------|
| **HTML Rewriter** | Full HTML/CSS/JS transformation |
| **Security** | Header sanitization, CSP injection |
| **Tracker Blocking** | Pattern-based ad/analytics blocking |
| **Cookie Jar** | Per-domain cookie simulation |
| **Cache API** | Response caching with TTL |
| **Obfuscator** | Traffic fingerprint randomization |
| **Logger** | Request logging and statistics |
| **Streaming Rewriter** | Progressive HTML transformation |
| **AI Engine** | ML-based content adaptation |
| **Persistence Engine** | State serialization/deserialization |
| **Mesh Engine** | Peer-to-peer networking coordination |
| **CORS Bypass** | Advanced CORS workarounds |
| **DOM Proxy Engine** | Cross-origin DOM access relay |

## State Snapshots

The WASM kernel serializes its entire heap to base64:

```javascript
// Inside the SVG context (DevTools console)
const urlWithState = window.exportState();
// Produces: neptune.svg?url=...&state=BASE64...
```

This persists:
- VFS entries (`/etc`, `/var`, `/home`)
- Request counts and statistics
- Proxy rules and configurations
- Resource graph
- Sessions and cookies

## Files

| File | Size | Purpose | Deploy? |
|------|------|---------|---------|
| `neptune.svg` | ~3MB | **Cartridge** — single self-contained file | **Yes** |
| `sw.js` | 78KB | Service Worker source (embedded in SVG + CDN co-host) | Yes |
| `template.svg` | 20KB | Build source for the cartridge | No |
| `src/lib.rs` | 20KB | Rust WASM kernel (DOM parser, tracker stripper) | Source only |
| `build.py` | 10KB | Build script — compiles + embeds everything | Source only |
| `server.py` | 8KB | Local dev server + proxy + WebRTC signaling | Optional |
| `index.html` | 4KB | Landing page with URL input | Yes |

## Build Requirements

- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Python 3
- Rust toolchain

## Security Notes

- Service Workers require HTTPS or localhost
- The proxy server fetches arbitrary URLs — run only locally or behind auth
- Extension mode has full cross-origin access — use responsibly
- Tracker blocking blocks known analytics domains but is not exhaustive
- All local data (bookmarks, history, cookies) stays in your browser