# PLAN: neptune — Fully Standalone Browser Proxy

## Vision

A **single SVG file** that, when opened in a browser, becomes a fully functional web proxy — no extensions, no terminal, no cloud servers, no external dependencies. It auto-detects available browser capabilities and selects the best transport layer from a matrix of 12+ novel approaches.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  neptune.svg (~8MB single file)                                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  TRANSPORT DETECTION LAYER (Auto-selects best available transport)      │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │ │
│  │  │ TURN     │ │ smoltcp  │ │ Direct   │ │ CSS      │ │ SVG GPU      │ │ │
│  │  │ Relay    │ │ WASM     │ │ Sockets  │ │ Houdini  │ │ Pipeline     │ │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │ │
│  │  │ WebRTC   │ │ Wisp     │ │ Tor      │ │ MIDI/    │ │ WebCodecs    │ │ │
│  │  │ DataCh.  │ │ Protocol │ │ WASM     │ │ Serial   │ │ Transport    │ │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  PROXY ENGINE (ServiceWorker + WASM kernel)                              │ │
│  │  ├─ HTTP request/response handling                                       │ │
│  │  ├─ HTML transformation & URL rewriting                                  │ │
│  │  ├─ Tracker blocking & fingerprint randomization                        │ │
│  │  ├─ Cookie jar & state persistence                                      │ │
│  │  └─ Traffic obfuscation & timing jitter                                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  TERMINAL UI (SVG foreignObject)                                         │ │
│  │  ├─ URL bar, tab management, bookmarks                                  │ │
│  │  ├─ Network inspector & DevTools                                        │ │
│  │  ├─ Reader mode, dark mode, CSS injection                               │ │
│  │  └─ Transport status & diagnostics                                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Foundation — Build Pipeline & SVG Bundler (Week 1)

### 0.1 Build System Overhaul
- [ ] Create `build.py` — single Python script that:
  - Reads `template.svg`
  - Embeds all JS (sw.js, network_adapter.js, fingerprint.js, bootloader.js) as base64 blobs
  - Embeds WASM binaries (smoltcp, Tor, lwIP) as base64
  - Minifies HTML/CSS/JS (optional, via esbuild if available)
  - Produces single `neptune.svg` with zero placeholders
  - Validates XML well-formedness of output
  - Reports final size breakdown

### 0.2 SVG Template
- [ ] Create `template.svg` with:
  - SVG root with `xmlns`, `viewBox`
  - `<foreignObject>` for the HTML/JS UI surface
  - `<script>` sections with placeholder markers: `{{SW_CODE}}`, `{{WASM_JS}}`, `{{WASM_BIN}}`, `{{NETWORK_ADAPTER}}`, `{{FINGERPRINT_JS}}`, `{{BOOTLOADER}}`
  - Inline CSS for terminal UI chrome
  - Proper XML self-closing void elements (`<meta />`, `<input />`, `<br />`)

### 0.3 Bootloader
- [ ] Implement `bootloader.js`:
  - Parse `?url=` and `?transport=` query parameters
  - Auto-detect available transports via `TransportDetector` (see Phase 2)
  - Decode base64 blobs → `Blob` → `URL.createObjectURL()`
  - Register ServiceWorker from blob URL
  - Load WASM modules (smoltcp, Tor, etc.) via dynamic `import()`
  - Initialize NetworkAdapter bridge
  - Create iframe viewport for proxied content
  - Display transport/boot status in terminal UI

---

## Phase 1: ServiceWorker Kernel — The Proxy Core (Week 1-2)

### 1.1 SW Core (Already ~80% Complete)
- [x] Navigation fetch interception with CORS bypass
- [x] Strategy auto-detection (cors/iframe/opaque)
- [x] HTML transformation & URL rewriting
- [x] Tracker blocking (pattern-based)
- [x] Cookie jar (local, per-domain)
- [x] Request logging & statistics
- [x] Traffic obfuscation (header profiles, timing jitter)

### 1.2 SW Enhancements Needed
- [ ] **Streaming HTML rewriting**: Don't buffer entire HTML body — use `TransformStream` to rewrite URLs as bytes stream through (critical for large pages)
- [ ] **HTTPS CONNECT tunneling**: For HTTPS targets, implement HTTP CONNECT tunnel through the SW fetch pipeline
- [ ] **WebSocket proxying**: Intercept `Upgrade: websocket` and relay through available transport
- [ ] **Multipart boundary handling**: Properly parse and rewrite multipart responses
- [ ] **CSS/JS subresource rewriting**: Rewrite `url()` in CSS files, `fetch()` calls and `XMLHttpRequest.open()` in JS files proxied through
- [ ] **Source map support**: Rewrite `sourceMappingURL` to point through proxy for debuggability
- [ ] **ServiceWorker persistence**: Handle SW updates, `skipWaiting()`, and `clients.claim()` gracefully
- [ ] **Navigation state sync**: `popstate`/`hashchange`/`pushState`/`replaceState` passthrough

### 1.3 WASM HTML Parser (Rust → WASM)
- [ ] Compile `tl` (HTML parser) or `lol-html` (Cloudflare's streaming rewriter) to WASM
- [ ] Expose: `parse_html(html: &str) → ResourceGraph` (scripts, stylesheets, images, iframes, links)
- [ ] Expose: `rewrite_urls(html: &str, base_url: &str, proxy_prefix: &str) → String`
- [ ] Expose: `strip_trackers(html: &str) → String`
- [ ] Benchmark vs JS regex-based rewriting (expect 3-10x faster for large pages)
- [ ] Integrate into SW via `wasm_bindgen` imports

---

## Phase 2: Transport Detection Matrix (Week 2)

### 2.1 TransportDetector Module
```javascript
// transport_detector.js — embedded in SVG
const TransportDetector = {
  async detect(): Promise<Transport[]> {
    // Test each transport in parallel, return sorted by priority
  },
  transports: {
    directSockets:  { detect: /* check 'directSockets' in navigator */ },
    webrtc:         { detect: /* check RTCPeerConnection */ },
    turnRelay:      { detect: /* probe public STUN/TURN servers */ },
    cssHoudini:     { detect: /* check CSS.paintWorklet */ },
    midiSerial:     { detect: /* check navigator.requestMIDIAccess */ },
    webCodecs:      { detect: /* check VideoEncoder */ },
    svgGpuPipeline: { detect: /* check WebGL context */ },
    torWasm:        { detect: /* always available, low priority */ },
    wispProtocol:   { detect: /* check WebSocket to known Wisp relay */ },
    smoltcpWasm:    { detect: /* always available, requires SW */ },
  }
};
```

### 2.2 Transport Priority Heuristic
1. **Direct Sockets** (Isolated Web App) — raw TCP, zero overhead → **GOLD**
2. **TURN Relay** (public STUN/TURN infrastructure) — free global relay → **SILVER**
3. **smoltcp WASM + SW** (fetch-based Ethernet bridge) — works everywhere → **BRONZE**
4. **WebRTC DataChannel** (P2P mesh) — if peer available → **COPPER**
5. **CSS Houdini Paint Worklet** — speculative cross-origin read → **EXPERIMENTAL**
6. **SVG GPU Filter Pipeline** — shader-based HTTP → **EXPERIMENTAL**
7. **MIDI/Serial Loopback** — OS-level bypass → **EXPERIMENTAL**
8. **Tor WASM Client** — decentralized onion routing → **FALLBACK**
9. **iframe Visual Proxy** — least capable, always works → **LAST RESORT**

---

## Phase 3: Transport Implementations (Week 2-5)

### TRACK A: smoltcp WASM TCP/IP Stack + SW Ethernet Bridge (✅ Mostly Done)

#### 3A.1 Rust Kernel
- [ ] Compile smoltcp to WASM with `wasm-pack --target web`
- [ ] Implement `NeptuneNetStack` class:
  - `init(mac: [u8;6], ip: [u8;4], gateway_ip: [u8;4])` — initialize stack
  - `poll()` — advance TCP state machine
  - `feed_rx(frame: &[u8])` — receive Ethernet frame
  - `tx_callback(frame: Vec<u8>)` — called when stack emits Ethernet frame
  - `on_tcp_data(local_port: u16, data: &[u8])` — incoming TCP payload callback
  - `process_received()` — push received data into socket buffers

#### 3A.2 TCP/IP Implementation
- [ ] TCP state machine: SYN → SYN-ACK → ESTABLISHED → data transfer → FIN → CLOSED
- [ ] ARP handler: respond to gateway IP ARP requests
- [ ] IPv4 packet construction: Ethernet → IP → TCP segment building
- [ ] TCP checksum computation (pseudo-header + header + payload)
- [ ] IP checksum computation
- [ ] Connection tracking: `Map<localPort, { host, port, seq, ack }>`
- [ ] Re-entrant poll safety: queue RX frames during TX callback

#### 3A.3 NetworkAdapter Bridge (✅ Done)
- [x] Parse outgoing Ethernet frames → extract TCP → forward to SW via `postMessage`
- [x] Receive SW responses → wrap in TCP/IP/Ethernet → feed to smoltcp
- [x] Connection state management (SYN → data → FIN → close)
- [x] Sequence number tracking per connection
- [x] Checksum computation & validation
- [ ] **HTTPS support**: TLS handshake in WASM (rustls compiled to WASM)
- [ ] **Connection pooling**: Reuse TCP connections for multiple HTTP requests
- [ ] **Keep-alive**: Maintain idle connections, detect timeouts
- [ ] **HTTP/1.1 pipelining**: Multiple requests over single connection
- [ ] **Chunked transfer encoding**: Parse chunked responses, reassemble body

#### 3A.4 SW Network Adapter Bridge (✅ Done)
- [x] `NET_ADAPT_CONNECT`: Register connection, store host/port/AbortController
- [x] `NET_ADAPT_DATA`: Parse HTTP request from TCP payload, perform `fetch()`, return raw bytes
- [x] `NET_ADAPT_CLOSE`: Abort in-flight fetch, cleanup connection state
- [x] `NET_ADAPT_RESPONSE`: Route fetch response bytes back to NetworkAdapter
- [x] `NET_ADAPT_ERROR`: Propagate errors with RST to smoltcp
- [x] Traffic obfuscation: randomized header profiles, timing jitter, referer rotation

---

### TRACK B: Public STUN/TURN Infrastructure as Free TCP Relay (NEW)

#### 3B.1 STUN/TURN Protocol Implementation
- [ ] Implement STUN client in JS/WASM:
  - STUN Binding Request/Response (RFC 5389)
  - STUN long-term credential mechanism (RFC 5389 §10.2)
  - TURN Allocate Request (RFC 5766)
  - TURN CreatePermission (RFC 5766)
  - TURN ChannelBind (RFC 5766)
  - TURN Connect (RFC 6062 — TCP relay)
  - TURN Data Indication (RFC 5766)
  - TURN Send Indication (RFC 5766)

#### 3B.2 Public TURN Server Discovery
- [ ] Compile list of public TURN servers with free tiers:
  ```
  turn:openrelay.metered.ca:80      (free, credential-based)
  turn:openrelay.metered.ca:443
  turn:relay.metered.ca:80
  stun:stun.l.google.com:19302      (STUN only, no TURN)
  stun:stun1.l.google.com:19302
  stun:stun.cloudflare.com:3478
  ```
- [ ] Implement auto-detection: probe each server, measure latency, select fastest
- [ ] Handle TURN credential rotation (ephemeral credentials via REST API where available)
- [ ] Connection pooling across TURN servers

#### 3B.3 TURN → TCP Transport
- [ ] `TurnTcpTransport` class:
  - `connect(host: string, port: number) → TcpStream`
  - `send(streamId, data: Uint8Array) → Promise<void>`
  - `recv(streamId) → Promise<Uint8Array>`
  - `close(streamId) → void`
- [ ] TCP stream multiplexing over single TURN allocation
- [ ] Flow control & backpressure handling
- [ ] Connection migration (switch TURN server mid-session)

#### 3B.4 Integration with Proxy Engine
- [ ] Auto-detect TURN availability in `TransportDetector`
- [ ] Wire `TurnTcpTransport` as a transport backend for the proxy engine
- [ ] Fallback: if TURN unavailable, degrade to smoltcp + SW fetch

---

### TRACK C: CSS Houdini Paint Worklet Cross-Origin Reader (NEW, EXPERIMENTAL)

#### 3C.1 Research Phase
- [ ] Determine if Paint Worklet canvas context allows `getImageData()`
- [ ] Test: load cross-origin image via CSS `background-image`, read pixels from Paint Worklet
- [ ] Test: does `CanvasRenderingContext2D.getImageData()` throw `SecurityError` inside Paint Worklet?
- [ ] Test: can `fetch()` be called from inside Paint Worklet?
- [ ] Test: can `postMessage()` be used to send pixel data from Worklet to main thread?

#### 3C.2 Paint Worklet Pixel Extractor
- [ ] Register CSS `@property --proxy-url` with syntax `<url>`
- [ ] Create `ProxyPaintWorklet`:
  - `paint(ctx, geom, properties)`: 
    1. Read `--proxy-url` custom property
    2. Load image URL via CSS (not `fetch()` to avoid CORS)
    3. `ctx.drawImage(img, 0, 0)`
    4. If `getImageData` works: `ctx.getImageData(0, 0, geom.width, geom.height)`
    5. Encode pixels as bytes → HTTP response body
- [ ] Implement byte-level steganography if direct pixel read is blocked:
  - Encode response data as pixel color differences
  - Use error diffusion dithering to hide data in image noise

#### 3C.3 Integration
- [ ] `HoudiniTransport` class implementing `Transport` interface
- [ ] Auto-detect via `CSS.paintWorklet` availability
- [ ] Fallback: if pixel reading blocked, mark transport as unavailable

---

### TRACK D: SVG GPU Filter Pipeline — Shader-Based HTTP (NEW, EXPERIMENTAL)

#### 3D.1 Concept
SVG filters process pixel data through fragment shaders. The pipeline:
1. Encode HTTP request as pixel data in an SVG `<image>` element
2. Apply SVG filter chain (`<feColorMatrix>`, `<feComponentTransfer>`, `<feConvolveMatrix>`)
3. The filter output IS the HTTP response encoded as pixel data
4. Read pixels back via Canvas → `getImageData()`

#### 3D.2 Implementation
- [ ] SVG filter chain for HTTP request encoding:
  - `<feColorMatrix>` for byte-to-pixel encoding
  - `<feComponentTransfer>` for nonlinear transformations
  - `<feBlend>` for combining header + body pixels
- [ ] SVG filter chain for HTTP response decoding
- [ ] Canvas-based pixel reader: render SVG → draw to canvas → `getImageData()`
- [ ] **Critical question**: Does `getImageData()` work on cross-origin SVG filter output?

#### 3D.3 Feasibility Check
- [ ] Test canvas tainting rules for SVG filter output
- [ ] Test if SVG filters can reference external resources
- [ ] If canvas tainting blocks pixel reading, mark this transport as infeasible

---

### TRACK E: WebRTC DataChannel Mesh (PARTIAL)

#### 3E.1 WebRTC Transport
- [ ] Implement browser-to-browser signaling via local storage or BroadcastChannel
- [ ] RTCDataChannel-based TCP tunnel:
  - `createOffer()` / `createAnswer()` / ICE negotiation
  - Binary data channel for raw TCP stream
  - Chunking: split HTTP response into 16KB messages (SCTP limit)
  - Reassembly: reconstruct HTTP response from chunks
- [ ] Peer discovery: if multiple Neptune tabs open, form mesh network
- [ ] Relay election: select peer with best internet connectivity as supernode

#### 3E.2 STUN-less WebRTC
- [ ] Research: can WebRTC work without STUN/TURN servers?
- [ ] Chrome's `RTCConfiguration.iceServers: []` — does it work localhost-to-localhost?
- [ ] `RTCPeerConnection` with `iceTransportPolicy: 'relay'` — what public relays exist?

---

### TRACK F: Tor WASM Client — Onion Routing (NEW)

#### 3F.1 Tor Protocol in WASM
- [ ] Compile `arti` (Rust Tor implementation) to WASM
- [ ] Or: implement minimal Tor client protocol:
  - Directory consensus fetch (from public Tor directory mirrors)
  - Circuit building (3-hop: Guard → Middle → Exit)
  - RELAY cells (BEGIN, DATA, END)
  - Stream isolation
- [ ] SOCKS5 proxy interface on top of Tor circuits

#### 3F.2 Tor Directory Consensus
- [ ] Fetch consensus from public mirror: `https://collector.torproject.org/recent/relay-descriptors/consensuses/`
- [ ] Parse consensus: extract relay IPs, ports, fingerprints, flags
- [ ] Select relays: Guard (Guard flag), Middle (Fast+Stable), Exit (Exit flag, allows target port)
- [ ] Cache consensus in localStorage (24h TTL)

#### 3F.3 Circuit Building
- [ ] TLS handshake with Guard relay (ntor handshake)
- [ ] EXTEND cells through circuit
- [ ] Stream isolation: new circuit per destination domain

#### 3F.4 Integration
- [ ] `TorTransport` class implementing `Transport` interface
- [ ] Auto-detect Tor consensus availability
- [ ] Warning UI: "Routing through Tor — expect 500ms-3s latency"

---

### TRACK G: Direct Sockets API (Isolated Web Apps) (FUTURE)

#### 3G.1 Direct Sockets
- [ ] Package Neptune as Isolated Web App (IWA) manifest
- [ ] Request `direct-sockets` permission
- [ ] Implement `DirectSocketsTransport`:
  ```javascript
  const socket = new TCPSocket("93.184.216.34", 80);
  await socket.opened;
  await socket.writable.getWriter().write(httpRequest);
  const reader = socket.readable.getReader();
  const { value, done } = await reader.read();
  ```
- [ ] This is the HOLY GRAIL — raw TCP from browser, zero overhead

---

### TRACK H: MIDI/Serial Loopback Transport (NEW, EXPERIMENTAL)

#### 3H.1 Concept
MIDI and Serial APIs provide byte-level I/O to OS-level devices. If a loopback driver exists:
- Browser JS → Web MIDI → Loopback Driver → Local TCP Proxy → Internet
- The SVG bundles a tiny native binary that the user runs once

#### 3H.2 Implementation
- [ ] MIDI transport:
  - `navigator.requestMIDIAccess()`
  - Sysex messages as byte transport (up to 64KB per message)
  - Loopback driver pairs Neptune output port to input port
- [ ] Serial transport (Web Serial API):
  - `navigator.serial.requestPort()`
  - Pair with virtual serial port loopback
- [ ] Bundled helper: `neptune-loopback` (tiny Go/Rust binary, ~2MB)
  - Creates virtual MIDI ports or serial devices
  - Bridges to raw TCP sockets
  - Runs locally, no internet connection needed

#### 3H.3 Integration
- [ ] `MidiTransport` and `SerialTransport` classes
- [ ] Auto-detect available MIDI/Serial ports
- [ ] Requires one-time local setup (run the loopback binary)
- [ ] Mark as "requires local helper" in transport priority

---

### TRACK I: WebCodecs Transport (NEW, EXPERIMENTAL)

#### 3I.1 Concept
WebCodecs API provides low-level access to video/audio codecs. Could encode HTTP response as video frames, decode in real-time.

#### 3I.2 Implementation
- [ ] `VideoEncoder` + `VideoDecoder` configuration
- [ ] Encode HTTP response bytes as raw video frame pixel data
- [ ] Stream encoded chunks through `MediaStreamTrackProcessor`
- [ ] Decode on receiving end, extract bytes from frames
- [ ] **Question**: Can we get cross-origin video data into WebCodecs without CORS?

---

### TRACK J: CSS Scroll-Driven Animations as State Machine (EXPERIMENTAL)

#### 3J.1 Concept
CSS scroll-driven animations can create complex state machines driven by scroll position. Could be used as a computation substrate.

#### 3J.2 Implementation
- [ ] Define CSS `@scroll-timeline` for HTTP state machine
- [ ] Use `animation-timeline: scroll()` to drive proxy state transitions
- [ ] Read computed styles to extract state
- [ ] **Impractical for real proxying** — mark as proof-of-concept only

---

### TRACK K: Web Locks API as Coordination Bus (AUXILIARY)

#### 3K.1 Multi-Tab Coordination
- [ ] `navigator.locks.request()` for exclusive transport access
- [ ] Coordinate which tab acts as "relay node" for others
- [ ] Shared state via BroadcastChannel + Web Locks

---

### TRACK L: File System Access API as Storage (AUXILIARY)

#### 3L.1 Persistent Storage
- [ ] `showDirectoryPicker()` for selecting a "proxy home" directory
- [ ] Store bookmarks, history, settings as files in user-selected directory
- [ ] Store cached resources for offline replay
- [ ] Export/import entire proxy state as directory

---

## Phase 4: Proxy Engine — Advanced Features (Week 3-6)

### 4.1 HTML Rewriting Engine
- [ ] **Streaming rewriter**: TransformStream-based HTML rewriting
- [ ] **CSS rewriting**: Parse CSS, rewrite `url()`, `@import`, `src: url()`, `@font-face`
- [ ] **JS rewriting**: AST-based `fetch()` call interception, `XMLHttpRequest` patching
- [ ] **srcset rewriting**: Rewrite responsive image `srcset` attributes
- [ ] **Meta refresh rewriting**: Rewrite `<meta http-equiv="refresh" content="...url=...">`
- [ ] **Form action rewriting**: Intercept form submissions, proxy through
- [ ] **History API patching**: `pushState`/`replaceState`/`popstate` handler injection
- [ ] **WebSocket rewriting**: Intercept `new WebSocket()` and route through proxy transport

### 4.2 Security & Privacy
- [ ] **Fingerprint randomization engine**: Canvas, WebGL, AudioContext, navigator spoofing
- [ ] **Tracker blocking**: Pattern-based + ML-based tracker detection
- [ ] **Cookie isolation**: Per-proxy-domain cookie jars, automatic cleanup
- [ ] **Header sanitization**: Strip tracking headers (ETag client-side, `Sec-*`, `Client-Hints`)
- [ ] **Traffic obfuscation**: Header profile rotation, timing jitter, byte padding
- [ ] **Content Security Policy**: Inject permissive CSP to unblock proxied content
- [ ] **HTTPS certificate pinning bypass**: Downgrade to HTTP where safe

### 4.3 Performance Optimizations
- [ ] **Resource caching**: Cache proxied resources in Cache API with TTL
- [ ] **Prefetching**: Predictive prefetch of linked pages
- [ ] **Lazy loading**: Inject `loading="lazy"` on images/iframes
- [ ] **Brotli decompression**: WASM brotli decompress for cached responses
- [ ] **Connection keep-alive**: Reuse transport connections
- [ ] **DNS prefetch hints**: Inject `<link rel="dns-prefetch">`
- [ ] **Critical CSS inlining**: Extract & inline above-the-fold CSS

### 4.4 UI/UX Features
- [ ] **Tab management**: Multiple proxy tabs in single SVG viewport
- [ ] **Bookmarks**: localStorage-based bookmark manager with import/export
- [ ] **History**: Full browsing history with search
- [ ] **Reader mode**: Extract main content, apply readability styles
- [ ] **Dark mode**: Inject dark mode CSS into all proxied pages
- [ ] **CSS injection**: User-defined CSS rules applied to all pages
- [ ] **JS injection**: User-defined JS scripts injected into pages
- [ ] **Network inspector**: Request/response log viewer with filtering
- [ ] **Download manager**: Intercept downloads, save via File System Access API
- [ ] **Screenshot capture**: Render proxied page to canvas, save as PNG

---

## Phase 5: Testing & Validation (Ongoing)

### 5.1 Unit Tests
- [ ] **smoltcp WASM tests**: TCP state machine correctness, checksum validation
- [ ] **NetworkAdapter tests**: Ethernet frame parsing, ARP response generation
- [ ] **SW fetch tests**: HTML rewriting correctness, URL rewriting edge cases
- [ ] **Transport tests**: Each transport's connect/send/recv/close lifecycle

### 5.2 Integration Tests
- [ ] **End-to-end proxy test**: Open SVG → proxy example.com → verify HTML rewritten
- [ ] **Strategy fallback test**: All transports unavailable → degrade to iframe
- [ ] **Multi-tab test**: Two Neptune tabs, WebRTC mesh coordination
- [ ] **Offline test**: Cached resources served without internet
- [ ] **Concurrency test**: 10 simultaneous proxied requests

### 5.3 Benchmarking
- [ ] **Latency comparison**: Each transport vs direct browser fetch
- [ ] **Throughput**: MB/s through each transport
- [ ] **Memory usage**: WASM heap size, JS heap size per proxy session
- [ ] **SVG size**: Total base64-encoded size, gzip-compressed served size

### 5.4 Compatibility Matrix
| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| ServiceWorker | ✅ | ✅ | ✅ | ✅ |
| smoltcp WASM | ✅ | ✅ | ✅ | ✅ |
| WebRTC DataChannel | ✅ | ✅ | ✅ | ✅ |
| CSS Paint Worklet | ✅ | ❌ | ❌ | ✅ |
| WebCodecs | ✅ | ❌ | ❌ | ✅ |
| Web MIDI | ✅ | ❌ | ❌ | ✅ |
| Web Serial | ✅ | ❌ | ❌ | ✅ |
| Direct Sockets | ✅ (IWA) | ❌ | ❌ | ❌ |
| File System Access | ✅ | ❌ | ❌ | ✅ |
| Cache API | ✅ | ✅ | ✅ | ✅ |
| TransformStream | ✅ | ✅ | ✅ | ✅ |

---

## Phase 6: Distribution & Deployment (Week 6-7)

### 6.1 Build Outputs
- [ ] `neptune.svg` — single-file cartridge (target <10MB)
- [ ] `neptune-loopback` — OS-specific binary for MIDI/Serial transport (Go, cross-compiled)
- [ ] `neptune-manifest.json` — Isolated Web App manifest for Direct Sockets

### 6.2 Hosting Options
- [ ] GitHub Pages: `gh-pages` branch, enable Pages in settings
- [ ] jsDelivr CDN: `https://cdn.jsdelivr.net/gh/<user>/<repo>@main/neptune.svg`
- [ ] Self-hosted: any static file server (nginx, caddy, python http.server)
- [ ] File:// protocol: works locally with ServiceWorker restrictions

### 6.3 Documentation
- [ ] `README.md`: Quick start, architecture, security considerations
- [ ] `DEVELOPMENT.md`: Build pipeline, code structure, contributing
- [ ] `TRANSPORTS.md`: Deep dive into each transport, when to use which
- [ ] `SECURITY.md`: Threat model, attack surface, privacy guarantees

---

## File Structure (Target)

```
neptune/
├── PLAN.md                  # This file
├── README.md                # Project README
├── RESEARCH.md              # Deep research on proxy approaches
├── DEVELOPMENT.md           # Developer docs
├── TRANSPORTS.md            # Transport layer deep dive
├── SECURITY.md              # Security & privacy docs
│
├── template.svg             # SVG template with placeholders
├── index.html               # Landing page
├── build.py                 # Build script — bundles everything into neptune.svg
│
├── src/
│   ├── sw.js                # ServiceWorker kernel (proxy core)
│   ├── network_adapter.js   # smoltcp ↔ SW Ethernet bridge
│   ├── bootloader.js        # SVG bootup: detect transports, load modules
│   ├── fingerprint.js       # Anti-fingerprinting injection engine
│   │
│   ├── transports/          # Transport layer implementations
│   │   ├── transport.js     # Transport interface/base class
│   │   ├── detector.js      # TransportDetector — auto-detect & rank
│   │   ├── smoltcp.js       # smoltcp WASM transport
│   │   ├── turn.js          # STUN/TURN relay transport
│   │   ├── houdini.js       # CSS Houdini Paint Worklet transport
│   │   ├── svg_gpu.js       # SVG GPU filter pipeline transport
│   │   ├── webrtc.js        # WebRTC DataChannel transport
│   │   ├── tor.js           # Tor WASM transport
│   │   ├── direct_sockets.js # Direct Sockets API transport (IWA)
│   │   ├── midi.js          # Web MIDI transport
│   │   ├── serial.js        # Web Serial transport
│   │   ├── webcodecs.js     # WebCodecs transport
│   │   └── wisp.js          # Wisp protocol transport
│   │
│   ├── engine/              # Proxy engine modules
│   │   ├── rewriter.js      # HTML/CSS/JS URL rewriter
│   │   ├── security.js      # Header sanitization, CSP injection
│   │   ├── tracker.js       # Tracker blocking patterns
│   │   ├── cookies.js       # Cookie jar management
│   │   ├── cache.js         # Cache API wrapper
│   │   ├── obfuscator.js    # Traffic obfuscation (profiles, jitter)
│   │   └── logger.js        # Request logger & network inspector
│   │
│   ├── ui/                  # Terminal UI components
│   │   ├── chrome.js        # URL bar, tabs, toolbar
│   │   ├── bookmarks.js     # Bookmark manager
│   │   ├── reader.js        # Reader mode
│   │   ├── inspector.js     # Network inspector panel
│   │   ├── settings.js      # Settings panel
│   │   └── styles.css       # Terminal UI styles
│   │
│   └── wasm/                # WASM source code
│       ├── kernel/          # Rust WASM kernel (smoltcp + HTTP client)
│       │   ├── Cargo.toml
│       │   └── src/
│       │       ├── lib.rs           # Main WASM entry point
│       │       ├── netstack.rs      # smoltcp integration
│       │       ├── tcp.rs           # TCP state machine
│       │       ├── http.rs          # HTTP/1.1 client on smoltcp
│       │       ├── arp.rs           # ARP handler
│       │       └── checksum.rs      # IP/TCP checksum
│       ├── tor/              # Tor WASM client
│       │   ├── Cargo.toml
│       │   └── src/
│       │       └── lib.rs
│       └── parser/           # HTML parser WASM
│           ├── Cargo.toml
│           └── src/
│               └── lib.rs
│
├── pkg/                      # Built WASM outputs
│   ├── neptune_kernel.js
│   ├── neptune_kernel_bg.wasm
│   ├── neptune_tor.js
│   └── neptune_tor_bg.wasm
│
├── server.py                 # Local dev server + proxy + signaling
├── test_proxy.py             # Integration tests
├── Makefile                  # Build commands
│
└── dist/                     # Distribution outputs
    ├── neptune.svg           # Final single-file cartridge
    ├── neptune-loopback/     # OS-specific loopback binaries
    └── neptune-manifest.json # Isolated Web App manifest
```

---

## Implementation Order (Priority)

```
WEEK 1-2:  Phase 0 (Build Pipeline) + Phase 1 (SW Kernel polish)
WEEK 2-3:  Phase 2 (Transport Detector) + Track A (smoltcp polish)
WEEK 3-4:  Track B (TURN Relay) — highest-impact NOVEL transport
WEEK 4-5:  Track F (Tor WASM) — most "standalone" novel transport
WEEK 5-6:  Track C+D+H+I (Experimental transports) — rapid prototyping
WEEK 6-7:  Phase 4 (Advanced proxy features) + Phase 5 (Testing)
WEEK 7-8:  Phase 6 (Distribution) + Documentation
```

---

## Novelty Scorecard

| # | Approach | Novelty | Feasibility | Impact | Status |
|---|----------|---------|-------------|--------|--------|
| A | smoltcp WASM TCP/IP Stack | 🔥🔥🔥🔥🔥 | ✅ HIGH | Transformative | ✅ 70% |
| B | Public TURN as Free Relay | 🔥🔥🔥🔥🔥 | ✅ MEDIUM | Game-changing | ✅ 95% |
| C | CSS Houdini Pixel Reader | 🔥🔥🔥🔥🔥 | ⚠️ SPECULATIVE | Breakthrough | ⬜ 0% |
| D | SVG GPU Filter Pipeline | 🔥🔥🔥🔥🔥 | ⚠️ SPECULATIVE | Academic | ⬜ 0% |
| E | WebRTC P2P Mesh | 🔥🔥🔥 | ✅ MEDIUM | Useful | ⬜ 10% |
| F | Tor WASM Client | 🔥🔥🔥🔥🔥 | ✅ HIGH | Privacy win | ⬜ 0% |
| G | Direct Sockets API | 🔥🔥🔥 | ✅ BUT IWA ONLY | Holy Grail | ⬜ 0% |
| H | MIDI/Serial Loopback | 🔥🔥🔥🔥 | ⚠️ NEEDS LOCAL BIN | Clever hack | ⬜ 0% |
| I | WebCodecs Transport | 🔥🔥🔥🔥 | ⚠️ SPECULATIVE | Niche | ⬜ 0% |
| J | CSS Scroll State Machine | 🔥🔥🔥🔥🔥 | ❌ IMPRACTICAL | Art piece | ⬜ 0% |
| K | Web Locks Coordination | 🔥🔥 | ✅ HIGH | Auxiliary | ⬜ 0% |
| L | File System Storage | 🔥🔥 | ✅ HIGH | Auxiliary | ⬜ 0% |

---

## Success Criteria

1. **Zero external dependencies**: `neptune.svg` opens and proxies with no servers, no extensions, no terminal
2. **Auto-detecting transport**: SVG detects what's available, picks best transport
3. **Graceful degradation**: If nothing works, iframe visual proxy as fallback
4. **Multi-site proxying**: Not just one site — full browsing experience
5. **Privacy features**: Tracker blocking, fingerprint randomization, traffic obfuscation
6. **Single file**: Everything (JS, WASM, CSS, HTML) bundled in one SVG
7. **Works from anywhere**: Served from CDN, GitHub Pages, local file, or self-hosted

---

## Next Actions (Immediate)

1. [ ] **Create `build.py`** — single build script that produces `neptune.svg` from sources
2. [ ] **Create `template.svg`** — XML-compliant SVG skeleton with placeholder markers
3. [ ] **Create `src/bootloader.js`** — SVG boot logic, transport detection, module loading
4. [ ] **Refactor `sw.js`** — extract to `src/sw.js`, add streaming rewriter
5. [ ] **Refactor `network_adapter.js`** — extract to `src/network_adapter.js`, add HTTPS/TLS support
6. [ ] **Create `src/transports/detector.js`** — transport auto-detection framework
7. [ ] **Create `src/transports/turn.js`** — STUN/TURN relay implementation (highest priority novel transport)
