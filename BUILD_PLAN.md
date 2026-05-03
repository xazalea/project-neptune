# project: neptune v3.0 — The Impossible Build Plan

> **"Think outside the box. Make this work, for real."**
>
> This document is the master plan for building a truly standalone, zero-dependency browser proxy bundled in a single SVG file. It assumes no external servers, no Chrome Extensions, no relay infrastructure. Only browser APIs and WASM.

---

## Table of Contents

1. [Architecture Overview: The Neptune Trinity v3](#architecture-overview)
2. [Phase 1: v86 Browser-in-Browser — The Nuclear Option](#phase-1-v86-browser-in-browser)
3. [Phase 2: Custom fetch()-Bridged Network Adapter for v86](#phase-2-custom-network-adapter)
4. [Phase 3: smoltcp WASM TCP/IP Stack — The Elegant Option](#phase-3-smoltcp-wasm-tcpip-stack)
5. [Phase 4: MirageOS Unikernel HTTP Proxy in WASM](#phase-4-mirageos-unikernel)
6. [Phase 5: Maximum Anonymity — Fingerprint Randomization Engine](#phase-5-maximum-anonymity)
7. [Phase 6: Traffic Obfuscation & Anti-Censorship](#phase-6-traffic-obfuscation)
8. [Phase 7: ServiceWorker as Physical Layer — The Bridge](#phase-7-serviceworker-physical-layer)
9. [Phase 8: JSPI + WASM HTTP Client — The Future](#phase-8-jspi-wasm-http-client)
10. [Phase 9: Epoxy-TLS + Wisp Integration](#phase-9-epoxy-tls-wisp)
11. [Phase 10: Integration & Assembly](#phase-10-integration)
12. [Appendix A: Size Budget Analysis](#appendix-a-size-budget)
13. [Appendix B: Attack Surface & Security Model](#appendix-b-security)
14. [Appendix C: Testing Matrix](#appendix-c-testing)

---

## Architecture Overview: The Neptune Trinity v3 {#architecture-overview}

The v3 architecture operates across three execution layers, each more powerful than the last:

```
┌──────────────────────────────────────────────────────────────────┐
│  neptune.svg (single ~5-15MB file)                                │
│                                                                    │
│  LAYER 3: v86 BROWSER-IN-BROWSER (The Nuclear Option)             │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  v86 x86 Emulator (WASM, ~1.5MB)                             │ │
│  │  ┌────────────────────────────────────────────────────────┐  │ │
│  │  │  Alpine Linux VM (disk image in base64, ~5MB)          │  │ │
│  │  │  ├─ tinyproxy :8888 (HTTP forward proxy)               │  │ │
│  │  │  ├─ Dillo / NetSurf (tiny graphical browser)           │  │ │
│  │  │  ├─ custom neptune-agent (Rust, inside VM)             │  │ │
│  │  │  └─ virtio-net NIC ← Custom fetch() backend            │  │ │
│  │  └────────────────────────────────────────────────────────┘  │ │
│  └──────────────────────────┬───────────────────────────────────┘ │
│                              │ SharedArrayBuffer (Ethernet frames) │
│  LAYER 2: smoltcp WASM NETWORK STACK (The Elegant Option)         │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  smoltcp (Rust → WASM, ~250KB)                               │ │
│  │  ├─ TCP/IP stack: ARP, IPv4, TCP, UDP                       │ │
│  │  ├─ HTTP/1.1 client on top of TCP                           │ │
│  │  ├─ Custom DNS resolver                                     │ │
│  │  ├─ TLS via epoxy-tls (WASM)                                │ │
│  │  └─ TAP interface → SharedArrayBuffer                        │ │
│  └──────────────────────────┬───────────────────────────────────┘ │
│                              │ SharedArrayBuffer (IP packets)      │
│  LAYER 1: SERVICEWORKER PHYSICAL LAYER (The Bridge)               │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ServiceWorker (bundled JS, ~50KB)                           │ │
│  │  ├─ Intercepts fetch() for same-origin navigation            │ │
│  │  ├─ Reads IP/Ethernet frames from SharedArrayBuffer          │ │
│  │  ├─ Encapsulates in HTTP requests to self                    │ │
│  │  ├─ Forwards real HTTP to internet via fetch()               │ │
│  │  └─ Returns raw bytes to WASM stack                          │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  LAYER 0: UI CHROME (The Experience)                               │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Neptune UI (HTML/CSS/JS, ~50KB)                             │ │
│  │  ├─ Full browser chrome: tabs, URL bar, panels               │ │
│  │  ├─ v86 framebuffer display (for browser-in-browser mode)    │ │
│  │  ├─ Fingerprint randomization engine                         │ │
│  │  ├─ Anonymity dashboard & controls                           │ │
│  │  └─ Network inspector, console, reader mode                  │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Execution Strategy

The system tries approaches in order of preference:

1. **Direct fetch (CORS-friendly sites)**: ServiceWorker fetches target, reads HTML, rewrites URLs — works for ~30% of sites
2. **iframe visual proxy**: Iframes the target with sandbox — works for ~60% of sites
3. **smoltcp WASM HTTP client**: Compiles HTTP requests to IP packets, sends through SW bridge — works when SW can exchange data with itself
4. **v86 browser-in-browser**: Boots Linux VM, runs real browser inside, displays framebuffer — works for 100% of sites but slow and large

### The Fundamental Insight

The browser CAN make cross-origin HTTP requests (fetch, images, scripts all load from any origin). The problem is **reading the response body** from JavaScript.

The ServiceWorker CAN read cross-origin responses when responding to navigation events (it's trusted code). But this only works for navigation — subresource opaque responses are still unreadable.

The escape hatch: **Process the bytes at a lower layer**. If we can get raw bytes (Ethernet frames, IP packets, or raw HTTP response bytes) into WASM, we can process them there, bypassing CORS entirely.

**v86 achieves this**: The VM's network stack doesn't know about CORS. It sends raw Ethernet frames. The v86 emulator receives them. If we replace the WebSocket relay with a fetch()-based backend, the VM thinks it's on a real network.

**smoltcp achieves this**: The WASM TCP/IP stack processes raw bytes. If the ServiceWorker can route bytes between the SW's fetch() and the WASM stack, we have a working TCP/IP stack in-browser.

---

## Phase 1: v86 Browser-in-Browser — The Nuclear Option {#phase-1-v86-browser-in-browser}

### Concept

Bundle the v86 x86 emulator inside the SVG. Boot a minimal Alpine Linux VM (~5MB disk image). Run a tiny graphical browser (Dillo or NetSurf) inside the VM. Display the VM's framebuffer in the SVG UI. The user browses through the inner browser, which has its own networking stack and is NOT subject to the outer browser's CORS/SOP.

### Why This Solves CORS

```
Outer browser (CORS/SOP)          Inner browser (no CORS)
┌─────────────────────┐          ┌──────────────────────┐
│ Neptune UI (SVG)     │          │ Alpine Linux VM       │
│  ┌────────────────┐  │          │  ┌────────────────┐  │
│  │ v86 framebuffer │  │  SharedArrayBuffer  │ Dillo browser │  │
│  │ (Canvas/Image)  │◄─┼──────────┼──►│ HTTP requests  │  │
│  └────────────────┘  │          │  │ through virtio  │  │
│  ┌────────────────┐  │          │  └───────┬────────┘  │
│  │ Mouse/KB events │──┼──────────┼──►│              │  │
│  └────────────────┘  │          │  ┌───────▼────────┐  │
└─────────────────────┘          │  │ virtio-net NIC  │  │
                                  │  │ raw IP packets  │  │
                                  │  └───────┬────────┘  │
                                  └──────────┼───────────┘
                                             │
                                  ┌──────────▼───────────┐
                                  │ Custom Network       │
                                  │ Backend (fetch())    │
                                  │ (See Phase 2)        │
                                  └──────────────────────┘
```

The inner browser's HTTP requests are NOT fetch() calls from JavaScript — they're raw TCP connections from the emulated NIC. The v86 emulator receives raw Ethernet frames. We intercept them and route to the internet via the ServiceWorker bridge. The outer browser never sees cross-origin requests — it only sees same-origin communication between the SVG and its ServiceWorker.

### Implementation Steps

#### Step 1.1: Embed v86 in SVG

```javascript
// v86 bootstrap (embedded in template.svg)
const V86_WASM_B64 = "{{V86_WASM}}";      // ~1.5MB → ~2MB base64
const V86_JS_B64  = "{{V86_JS}}";         // ~150KB → ~200KB base64
const LINUX_IMG_B64 = "{{LINUX_IMG}}";    // ~5MB → ~6.7MB base64
const V86_BIOS_B64 = "{{V86_BIOS}}";      // ~64KB → ~85KB base64

async function bootV86() {
  // Decode base64 to bytes
  const wasmBytes = b64ToBytes(V86_WASM_B64);
  const jsCode = atob(V86_JS_B64);
  const biosBytes = b64ToBytes(V86_BIOS_B64);
  const linuxImg = b64ToBytes(LINUX_IMG_B64);

  // Create v86 instance
  const emulator = new window.V86Starter({
    wasm_path: URL.createObjectURL(new Blob([wasmBytes])),
    bios: { url: URL.createObjectURL(new Blob([biosBytes])) },
    vga_bios: { url: URL.createObjectURL(new Blob([vgaBiosBytes])) },
    cdrom: { url: URL.createObjectURL(new Blob([linuxImg])) },
    network_relay_url: "fetch-bridge://neptune",  // Custom protocol
    autostart: true,
    screen_container: document.getElementById('v86-screen'),
    memory_size: 256 * 1024 * 1024,  // 256MB RAM
    vga_memory_size: 8 * 1024 * 1024, // 8MB VRAM
  });

  return emulator;
}
```

#### Step 1.2: Build Minimal Alpine Linux Image

```dockerfile
# Dockerfile.neptune-vm
FROM alpine:3.19

# Minimal proxy + browser
RUN apk add --no-cache \
    tinyproxy \
    dillo \
    # or netsurf for better rendering
    # netsurf \

# Configure tinyproxy to listen on all interfaces
RUN echo "Listen 0.0.0.0" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Port 8888" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Allow 127.0.0.1" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Allow 10.0.2.0/24" >> /etc/tinyproxy/tinyproxy.conf

# Auto-start proxy on boot
RUN echo "tinyproxy -d" >> /etc/local.d/neptune.start && \
    chmod +x /etc/local.d/neptune.start && \
    rc-update add local

# neptune-agent: custom HTTP proxy that communicates with host
COPY neptune-agent /usr/local/bin/neptune-agent
RUN echo "neptune-agent --port 9999 &" >> /etc/local.d/neptune.start

CMD ["/bin/sh"]
```

Build and extract root filesystem:
```bash
docker build -t neptune-vm -f Dockerfile.neptune-vm .
docker create --name tmp neptune-vm
docker export tmp | tar -C neptune-rootfs -xvf -
# Convert to raw disk image that v86 can boot
```

#### Step 1.3: Custom neptune-agent (Rust, inside VM)

```rust
// neptune-agent: runs inside the Alpine VM
// Communicates with the host (SVG) via a magic IP address or virtio-serial
// Receives URL requests from host, fetches them, returns HTML

use tiny_http::{Server, Response};
use std::io::Read;

fn main() {
    let server = Server::http("0.0.0.0:9999").unwrap();
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        // Fetch the URL (from INSIDE the VM — full network access)
        if let Ok(resp) = ureq::get(&url).call() {
            let body = resp.into_string().unwrap_or_default();
            let response = Response::from_string(body);
            request.respond(response).ok();
        }
    }
}
```

#### Step 1.4: Display v86 Framebuffer in SVG UI

```javascript
// The v86 emulator renders to a <canvas> or <div>
// We display this in the Neptune viewport
function showV86Mode(emulator) {
  landing.style.display = 'none';
  const screen = document.getElementById('v86-screen');
  screen.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
  viewport.appendChild(screen);

  // Forward mouse/keyboard events into v86
  screen.addEventListener('mousemove', (e) => {
    emulator.mouse_set_status(true);
    emulator.mouse_move(e.offsetX, e.offsetY);
  });
  screen.addEventListener('mousedown', (e) => {
    emulator.mouse_button(e.button, true);
  });
  screen.addEventListener('mouseup', (e) => {
    emulator.mouse_button(e.button, false);
  });
  screen.addEventListener('keydown', (e) => {
    emulator.keyboard_send_scancodes(getScancodes(e));
  });

  // Lock mouse for better UX
  screen.addEventListener('click', () => {
    screen.requestPointerLock();
  });
}
```

### Alternative: Dillo / NetSurf as Inner Browser

Instead of a full graphical desktop, run Dillo (or NetSurf) directly on the Linux framebuffer:

```bash
# Inside VM
export DISPLAY=:0  # Use Xvfb or direct framebuffer
dillo http://example.com
```

Dillo is:
- ~1.5MB binary
- Renders HTML/CSS (basic)
- Supports HTTP/HTTPS
- No JavaScript (privacy bonus)

NetSurf is:
- ~3MB binary
- Better CSS support
- Partial JS support
- Faster rendering

### Size Estimate for v86 Approach

| Component | Raw Size | Base64 Size (×1.33) |
|-----------|----------|---------------------|
| v86 WASM binary | 1.5 MB | 2.0 MB |
| v86 JS glue | 150 KB | 200 KB |
| v86 BIOS + VGA BIOS | 128 KB | 170 KB |
| Alpine Linux rootfs (minimal) | 5 MB | 6.7 MB |
| Dillo browser | 1.5 MB | 2.0 MB |
| tinyproxy | 50 KB | 67 KB |
| neptune-agent (Rust) | 2 MB | 2.7 MB |
| **Phase 1 Subtotal** | **10.3 MB** | **13.8 MB** |

---

## Phase 2: Custom fetch()-Bridged Network Adapter for v86 {#phase-2-custom-network-adapter}

### The Breakthrough

v86 currently requires a WebSocket relay server (like `websockproxy`) to bridge Ethernet frames to TCP. We replace this relay with a **custom network backend that uses fetch() as the transport**.

### How v86 Networking Works (Internal)

From the v86 source code (`src/ne2k.js`, `src/virtio_net.js`):

1. Guest OS sends Ethernet frame → emulated NIC (ne2k or virtio)
2. NIC emulation code fires event: `this.emulator.bus.send("net0-send", ethernet_frame)`
3. Current default handler: sends frame via WebSocket to relay server
4. Relay server forwards frame to real network
5. Response comes back via WebSocket → injected via `bus.send("net0-receive", ethernet_frame)` → NIC → guest OS

### Custom Backend Architecture

```javascript
// Neptune custom v86 network backend
class NeptuneNetworkBackend {
  constructor(emulator) {
    this.emulator = emulator;
    this.sw = navigator.serviceWorker.controller;
    this.pendingRequests = new Map(); // id → { resolve, reject }
    this.requestId = 0;

    // Intercept outgoing Ethernet frames
    emulator.add_listener("net0-send", (ethernetFrame) => {
      this.handleOutgoingFrame(ethernetFrame);
    });
  }

  async handleOutgoingFrame(ethernetFrame) {
    // Parse Ethernet frame
    const eth = parseEthernetFrame(ethernetFrame);

    // We only handle IPv4 for now
    if (eth.etherType !== 0x0800) return;

    // Parse IP packet
    const ip = parseIPv4Packet(eth.payload);

    // We only handle TCP for now
    if (ip.protocol !== 6) return;

    // Parse TCP segment
    const tcp = parseTCPSegment(ip.payload);

    // Extract HTTP request from TCP payload
    if (tcp.dstPort === 80 || tcp.dstPort === 443) {
      const httpData = tcp.payload;
      const request = parseHTTPRequest(httpData);

      if (request) {
        // Route through the ServiceWorker bridge
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
          this.pendingRequests.set(id, { resolve, reject });

          // Send to ServiceWorker
          this.sw.postMessage({
            type: 'V86_NETWORK_REQUEST',
            id: id,
            method: request.method,
            url: `http://${ip.dstAddr}:${tcp.dstPort}${request.path}`,
            headers: request.headers,
            body: request.body,
          });
        }).then((response) => {
          // Re-encapsulate response into TCP → IP → Ethernet
          const responseFrame = this.encapsulateResponse(
            response, eth, ip, tcp
          );
          // Inject back into VM
          this.emulator.bus.send("net0-receive", responseFrame);
        });
      }
    }
  }

  encapsulateResponse(httpResponse, originalEth, originalIp, originalTcp) {
    // Build HTTP response bytes
    let responseText = `HTTP/1.1 ${httpResponse.status} ${httpResponse.statusText}\r\n`;
    for (const [k, v] of Object.entries(httpResponse.headers)) {
      responseText += `${k}: ${v}\r\n`;
    }
    responseText += '\r\n';
    const headerBytes = new TextEncoder().encode(responseText);
    const bodyBytes = httpResponse.body;

    // TCP segment (swap src/dst)
    const tcpBytes = buildTCPSegment({
      srcPort: originalTcp.dstPort,
      dstPort: originalTcp.srcPort,
      seqNum: originalTcp.ackNum,
      ackNum: originalTcp.seqNum + originalTcp.payload.length,
      flags: { ACK: 1, PSH: 1 },
      payload: concatBytes(headerBytes, bodyBytes),
    });

    // IP packet (swap src/dst)
    const ipBytes = buildIPv4Packet({
      srcAddr: originalIp.dstAddr,
      dstAddr: originalIp.srcAddr,
      protocol: 6,
      payload: tcpBytes,
    });

    // Ethernet frame (swap src/dst MAC)
    return buildEthernetFrame({
      srcMac: originalEth.dstMac,
      dstMac: originalEth.srcMac,
      etherType: 0x0800,
      payload: ipBytes,
    });
  }
}
```

### ServiceWorker Bridge Handler

```javascript
// In sw.js — handle v86 network requests
case 'V86_NETWORK_REQUEST':
  (async () => {
    const { id, method, url, headers, body } = d;
    try {
      const resp = await fetch(url, {
        method: method,
        headers: headers,
        body: body || undefined,
      });
      const respBody = await resp.arrayBuffer();
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      if (src) src.postMessage({
        type: 'V86_NETWORK_RESPONSE',
        id: id,
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        body: b64Encode(respBody),
      });
    } catch (e) {
      if (src) src.postMessage({
        type: 'V86_NETWORK_RESPONSE',
        id: id,
        error: e.message,
      });
    }
  })();
  break;
```

### Why This Works for the Proxy Use Case

- The v86 VM sends raw HTTP requests through its NIC
- We parse Ethernet → IP → TCP → HTTP in JavaScript
- We make the actual HTTP request using the ServiceWorker's fetch()
- The SW is trusted code — it can read cross-origin responses for navigation
- We re-encapsulate HTTP response → TCP → IP → Ethernet
- We inject back into the VM
- The inner browser (Dillo/NetSurf) renders the page
- NO CORS/SOP violations — the outer browser only sees same-origin SW communication

### The TCP State Machine Problem

This simplified approach works for simple HTTP requests but doesn't handle:
- TCP handshake (SYN, SYN-ACK, ACK)
- TCP retransmission
- TCP window management
- Connection tracking
- Keep-alive connections

**Solution**: Implement a minimal TCP state machine in JavaScript, OR use smoltcp (Phase 3) inside the VM instead of the guest OS's TCP stack.

### Alternative: Use smoltcp as the VM's Network Stack

Instead of implementing TCP in JS, have the VM use smoltcp (Rust TCP/IP stack compiled to the VM's architecture). But this is circular — the VM already has a TCP stack.

**Better approach**: Have smoltcp run OUTSIDE the VM, in the SVG's WASM context, and bridge v86's Ethernet frames to smoltcp. smoltcp handles the TCP state machine. smoltcp's HTTP client makes requests.

```
v86 Ethernet frames → smoltcp (WASM, outside VM) → HTTP client → SW fetch() → Internet
```

---

## Phase 3: smoltcp WASM TCP/IP Stack — The Elegant Option {#phase-3-smoltcp-wasm-tcpip-stack}

> **✅ IMPLEMENTED** — smoltcp v0.11 compiles to `wasm32-unknown-unknown` via `wasm-pack`.
> The `NeptuneNetStack` class is exported from `src/network.rs`. The `network_adapter.js`
> bridges Ethernet frames between smoltcp and the ServiceWorker via `postMessage`.
> See `src/network.rs`, `network_adapter.js`, and `sw.js` (NET_ADAPT_* handlers).

### Concept

Compile smoltcp (Rust TCP/IP stack, ~250KB) to WebAssembly. Embed it in the SVG alongside the existing Rust/WASM kernel. The smoltcp stack provides a full TCP/IP implementation that runs in WASM. We bridge it to the internet via the ServiceWorker's fetch().

### Why This Is Better Than v86

| | v86 | smoltcp WASM |
|---|---|---|
| Size | ~14MB | ~300KB |
| Boot time | 10-30s | Instant |
| CPU overhead | x86 emulation | Near-native WASM |
| Memory | 256MB+ | ~10MB |
| Complexity | Very high | Moderate |
| CORS bypass | ✅ Full | ✅ Full |

### Architecture

```
┌──────────────────────────────────────────────────┐
│  neptune.svg                                      │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │  smoltcp WASM (Rust → wasm-pack, ~250KB)     │ │
│  │                                               │ │
│  │  DeviceLayer (custom)                         │ │
│  │  ├─ rx_token(): Read bytes from JS           │ │
│  │  └─ tx_token(): Write bytes to JS            │ │
│  │       ↓                                       │ │
│  │  EthernetInterface                            │ │
│  │  ├─ ARP cache                                 │ │
│  │  └─ Neighbor discovery                        │ │
│  │       ↓                                       │ │
│  │  Ipv4Interface                                │ │
│  │  ├─ IP fragmentation/reassembly               │ │
│  │  └─ Routing table                              │ │
│  │       ↓                                       │ │
│  │  TcpSocketSet                                 │ │
│  │  ├─ TCP state machines (per socket)           │ │
│  │  ├─ Congestion control                        │ │
│  │  └─ Retransmission                            │ │
│  │       ↓                                       │ │
│  │  HTTP/1.1 Client (on top of TCP)              │ │
│  │  ├─ Request building                          │ │
│  │  ├─ Response parsing                          │ │
│  │  ├─ Chunked transfer decoding                 │ │
│  │  └─ Keep-alive connection pooling             │ │
│  │       ↓                                       │ │
│  │  Neptune HTTP API:                            │ │
│  │  http_get(url) → {status, headers, body}      │ │
│  └──────────────┬───────────────────────────────┘ │
│                 │ SharedArrayBuffer                │
│  ┌──────────────▼───────────────────────────────┐ │
│  │  JS Bridge (Physical Layer)                   │ │
│  │  ├─ Reads IP packets from WASM memory         │ │
│  │  ├─ Encapsulates in SW messages               │ │
│  │  ├─ Receives raw bytes from SW                │ │
│  │  └─ Writes into WASM memory                   │ │
│  └──────────────┬───────────────────────────────┘ │
│                 │ postMessage                      │
│  ┌──────────────▼───────────────────────────────┐ │
│  │  ServiceWorker                                │ │
│  │  ├─ Receives HTTP request info (url, headers) │ │
│  │  ├─ fetch(url) → reads raw bytes              │ │
│  │  ├─ Returns raw bytes to JS bridge            │ │
│  │  └─ Can read cross-origin responses           │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### Rust Implementation (src/tcp_stack.rs)

```rust
// New file: src/tcp_stack.rs
// smoltcp-based TCP/IP stack compiled to WASM

use smoltcp::iface::{Config, Interface, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium};
use smoltcp::socket::tcp::{Socket, SocketBuffer};
use smoltcp::time::Instant;
use smoltcp::wire::{EthernetAddress, IpAddress, IpCidr, Ipv4Address};
use wasm_bindgen::prelude::*;

// Custom "device" that bridges smoltcp to JavaScript
// Instead of real hardware, rx/tx go to SharedArrayBuffer
pub struct JsDevice {
    rx_buffer: Vec<u8>,
    tx_callback: js_sys::Function,
}

impl Device for JsDevice {
    type RxToken<'a> = JsRxToken;
    type TxToken<'a> = JsTxToken<'a>;

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = 1500;
        caps
    }

    fn receive(&mut self, _timestamp: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.rx_buffer.is_empty() {
            None
        } else {
            Some((JsRxToken(&self.rx_buffer), JsTxToken {
                device: self,
                buffer: Vec::new(),
            }))
        }
    }

    fn transmit(&mut self, _timestamp: Instant) -> Option<Self::TxToken<'_>> {
        Some(JsTxToken {
            device: self,
            buffer: Vec::with_capacity(1500),
        })
    }
}

pub struct JsRxToken<'a>(&'a [u8]);
impl<'a> smoltcp::phy::RxToken for JsRxToken<'a> {
    fn consume<R, F>(self, f: F) -> R
    where F: FnOnce(&mut [u8]) -> R
    {
        f(&mut self.0.to_vec())
    }
}

pub struct JsTxToken<'a> {
    device: &'a mut JsDevice,
    buffer: Vec<u8>,
}
impl<'a> smoltcp::phy::TxToken for JsTxToken<'a> {
    fn consume<R, F>(mut self, len: usize, f: F) -> R
    where F: FnOnce(&mut [u8]) -> R
    {
        self.buffer.resize(len, 0);
        let result = f(&mut self.buffer);
        // Send to JS via the callback
        let uint8 = js_sys::Uint8Array::from(&self.buffer[..]);
        self.device.tx_callback.call1(&JsValue::NULL, &uint8).ok();
        result
    }
}

#[wasm_bindgen]
pub struct NeptuneNetStack {
    iface: Interface,
    sockets: SocketSet<'static>,
    device: JsDevice,
}

#[wasm_bindgen]
impl NeptuneNetStack {
    pub fn new(tx_callback: js_sys::Function) -> Self {
        let device = JsDevice {
            rx_buffer: Vec::new(),
            tx_callback,
        };

        let config = Config::new(EthernetAddress([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]).into());
        let mut iface = Interface::new(config, &mut device, Instant::now());
        iface.update_ip_addrs(|addrs| {
            addrs.push(IpCidr::new(IpAddress::v4(10, 0, 0, 2), 24)).ok();
        });

        // Sane default routes
        let mut routes = smoltcp::iface::Routes::new();
        routes.add_default_ipv4_route(
            Ipv4Address::new(10, 0, 0, 1)  // Gateway (= the JS bridge)
        ).ok();

        let mut sockets = SocketSet::new(vec![]);

        Self { iface, sockets, device }
    }

    /// Feed received bytes from JS into the stack
    pub fn feed_rx(&mut self, data: &[u8]) {
        self.device.rx_buffer = data.to_vec();
    }

    /// Poll the stack (call this in a loop or on interval)
    pub fn poll(&mut self, timestamp_ms: u64) -> bool {
        let ts = Instant::from_millis(timestamp_ms);
        match self.iface.poll(ts, &mut self.device, &mut self.sockets) {
            Ok(_) => true,
            Err(e) => {
                crate::console_log(&format!("[NET] poll error: {:?}", e));
                false
            }
        }
    }

    /// Open a TCP connection and send an HTTP GET request
    pub fn http_get(&mut self, url: &str, callback: js_sys::Function) -> Result<(), JsValue> {
        // Parse URL
        let parsed = url::Url::parse(url).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let host = parsed.host_str().ok_or_else(|| JsValue::from_str("No host"))?;
        let port = parsed.port().unwrap_or(80);

        // DNS resolution (hardcoded for now — see Phase 9 for DNS)
        let ip = Ipv4Address::new(93, 184, 216, 34); // example.com
        // In production: use a DNS-over-HTTPS lookup bridged to JS

        // Create TCP socket
        let tcp_rx_buffer = SocketBuffer::new(vec![0; 65535]);
        let tcp_tx_buffer = SocketBuffer::new(vec![0; 65535]);
        let tcp_socket = Socket::new(tcp_rx_buffer, tcp_tx_buffer);
        let handle = self.sockets.add(tcp_socket);

        // Connect
        let mut socket = self.sockets.get_mut::<Socket>(handle);
        socket.connect((ip, port).into(), port)
            .map_err(|e| JsValue::from_str(&format!("Connect error: {:?}", e)))?;

        // Build HTTP request
        let path = parsed.path();
        let request = format!(
            "GET {} HTTP/1.1\r\n\
             Host: {}\r\n\
             User-Agent: Neptune/3.0 (smoltcp WASM)\r\n\
             Accept: */*\r\n\
             Connection: close\r\n\
             \r\n",
            path, host
        );

        // Store callback for async response
        // (The actual response handling happens in poll())
        // This is simplified — real impl needs async bridging

        Ok(())
    }
}
```

### Cargo.toml Additions

```toml
[dependencies]
smoltcp = { version = "0.11", default-features = false, features = [
  "std", "log", "medium-ethernet", "proto-ipv4", "proto-igmp",
  "socket-tcp", "socket-icmp", "socket-udp", "proto-dhcpv4"
] }
```

### JS Bridge Implementation

```javascript
// In template.svg — bridge between smoltcp and ServiceWorker
class SmoltcpBridge {
  constructor(netStack) {
    this.netStack = netStack;
    this.sw = navigator.serviceWorker.controller;
    this.requestId = 0;
    this.pending = new Map();

    // smoltcp sends raw IP packets → we route via SW
    this.txCallback = (uint8Array) => {
      this.handleOutgoingPacket(uint8Array);
    };
  }

  async handleOutgoingPacket(rawBytes) {
    // Parse IP packet to extract TCP/HTTP
    const ipPacket = parseIPv4(rawBytes);
    if (!ipPacket || ipPacket.protocol !== 6) return; // Only TCP

    const tcpSegment = parseTCP(ipPacket.payload);
    const payload = new TextDecoder().decode(tcpSegment.payload);

    // Check if it's an HTTP request
    const httpMatch = payload.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) (.+) HTTP\/1.[01]/);
    if (!httpMatch) return;

    const method = httpMatch[1];
    const path = httpMatch[2];
    const hostMatch = payload.match(/Host: (.+)\r\n/);
    const host = hostMatch ? hostMatch[1].trim() : '';

    // Route through ServiceWorker bridge
    const url = `http://${host}${path}`;
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      this.sw.postMessage({
        type: 'SMOLTCP_REQUEST',
        id: id,
        method: method,
        url: url,
      });
    }).then((response) => {
      // Feed response bytes back into smoltcp
      const responseBytes = new TextEncoder().encode(
        `HTTP/1.1 ${response.status} OK\r\n` +
        `Content-Length: ${response.body.length}\r\n` +
        `\r\n`
      );
      const fullResponse = concatUint8Arrays(responseBytes, response.body);
      this.netStack.feed_rx(fullResponse);
    });
  }
}
```

### ServiceWorker Handler

```javascript
// In sw.js
case 'SMOLTCP_REQUEST':
  (async () => {
    const { id, method, url } = d;
    try {
      const resp = await fetch(url, { method });
      const body = await resp.arrayBuffer();
      if (src) src.postMessage({
        type: 'SMOLTCP_RESPONSE',
        id: id,
        status: resp.status,
        body: b64Encode(body),
      });
    } catch (e) {
      if (src) src.postMessage({
        type: 'SMOLTCP_RESPONSE',
        id: id,
        error: e.message,
      });
    }
  })();
  break;
```

---

## Phase 4: MirageOS Unikernel HTTP Proxy in WASM {#phase-4-mirageOS-unikernel}

### Concept

MirageOS is a library operating system that compiles OCaml applications into minimal unikernels (~2-5MB). It can run directly on Xen, KVM, or — with some work — as a WASM module. A MirageOS unikernel that implements an HTTP forward proxy would be the smallest possible proxy server.

### Why MirageOS

- **Tiny**: Unikernels are 2-5MB vs. Alpine Linux 5MB+ vs. Ubuntu 50MB+
- **Fast boot**: Milliseconds vs. seconds for Linux
- **Single-purpose**: Only runs the proxy — no shell, no init system, no multi-user
- **Secure**: Minimal attack surface
- **OCaml → WASM**: OCaml can compile to JavaScript (js_of_ocaml) or WASM (wasm_of_ocaml)

### Target: wasm_of_ocaml

The `wasm_of_ocaml` compiler can compile OCaml programs (including MirageOS unikernels) to WebAssembly:

```ocaml
(* mirage_proxy.ml — MirageOS HTTP forward proxy as WASM module *)

open Lwt.Infix
open Cohttp_lwt_unix

module Main (C: Mirage_clock_lwt.CLOCK) = struct
  let start _clock =
    (* HTTP forward proxy server *)
    let callback _conn req body =
      let uri = Cohttp.Request.uri req in
      (* Fetch the target URL *)
      let headers = Cohttp.Header.init () in
      Client.get uri >>= fun (resp, resp_body) ->
      let status = Cohttp.Response.status resp in
      let headers = Cohttp.Response.headers resp in
      Cohttp_lwt.Body.to_string resp_body >>= fun body ->
      (* Return to caller *)
      Server.respond_string ~status ~body ~headers ()
    in
    let server = Server.create ~mode:(`TCP (`Port 8888)) (Server.make ~callback ()) in
    server >>= fun () ->
    Lwt.return_unit
end
```

### Compilation to WASM

```bash
# Install wasm_of_ocaml
opam install wasm_of_ocaml

# Compile MirageOS proxy to WASM
wasm_of_ocaml mirage_proxy.ml -o mirage_proxy.wasm

# The WASM module exports a function:
#   handle_http_request(url: string) -> { status, headers, body }
```

### Integration with Neptune

```javascript
// Load MirageOS WASM module
const mirageModule = await WebAssembly.instantiate(mirageWasmBytes, {
  env: {
    // Provide network via JS bridge
    js_fetch: (urlPtr, urlLen) => {
      const url = readStringFromWasm(memory, urlPtr, urlLen);
      return makeAsyncWasmCall(async () => {
        const resp = await serviceWorkerBridge.fetch(url);
        // Write response into WASM memory
        writeResponseToWasm(memory, resp);
      });
    },
  },
});

// Use the proxy
function proxyRequest(url) {
  const result = mirageModule.instance.exports.handle_http_request(url);
  return JSON.parse(readStringFromWasm(memory, result, 1024));
}
```

### Size Estimate

| Component | Size |
|-----------|------|
| MirageOS unikernel (OCaml → WASM) | ~2-3 MB |
| OCaml runtime in WASM | ~500 KB |
| Cohttp library | ~300 KB |
| TLS support (ocaml-tls) | ~500 KB |
| **Total** | **~3-4 MB** |

### Challenges

- MirageOS expects a real network interface (TAP/TUN) — needs a WASM polyfill
- OCaml's Lwt (async) may not map cleanly to JSPI/Asyncify
- Memory management differences between OCaml GC and WASM linear memory
- Cohttp assumes POSIX sockets — needs fetch() backend

---

## Phase 5: Maximum Anonymity — Fingerprint Randomization Engine {#phase-5-maximum-anonymity}

### The Attack Surface

Modern browsers expose 50+ fingerprint vectors. Anti-detect browsers (Multilogin, AdsPower, Kameleo) spoof all of them. We need the same level of rigor, injected into every proxied page.

### Fingerprint Vectors to Spoof

#### Category 1: Navigator Properties
```javascript
const navigatorSpoofs = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  platform: 'Win32',
  vendor: 'Google Inc.',
  vendorSub: '',
  productSub: '20030107',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  language: 'en-US',
  languages: ['en-US', 'en'],
  maxTouchPoints: 0,
  doNotTrack: null,
  cookieEnabled: true,
  appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  appCodeName: 'Mozilla',
  appName: 'Netscape',
  product: 'Gecko',
  oscpu: undefined, // Firefox specific
};
```

#### Category 2: Screen & Window
```javascript
const screenSpoofs = {
  width: 1920,
  height: 1080,
  availWidth: 1920,
  availHeight: 1040,
  colorDepth: 24,
  pixelDepth: 24,
  availLeft: 0,
  availTop: 0,
  orientation: { type: 'landscape-primary', angle: 0 },
};

// Window inner dimensions
const windowSpoofs = {
  innerWidth: 1920,
  innerHeight: 940,
  outerWidth: 1920,
  outerHeight: 1080,
  screenX: 0,
  screenY: 0,
  devicePixelRatio: 1,
};
```

#### Category 3: Canvas Fingerprint
```javascript
function spoofCanvas() {
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;

  // Add deterministic noise to canvas outputs
  const noise = generatePerSessionNoise(); // Consistent per session

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      // Add subtle noise to prevent fingerprinting
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] ^= noise[i % noise.length];     // R
        imageData.data[i + 1] ^= noise[(i+1) % noise.length]; // G
        imageData.data[i + 2] ^= noise[(i+2) % noise.length]; // B
      }
      ctx.putImageData(imageData, 0, 0);
    }
    return originalToDataURL.apply(this, args);
  };

  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const result = originalGetImageData.apply(this, args);
    for (let i = 0; i < result.data.length; i += 4) {
      result.data[i] ^= noise[i % noise.length];
    }
    return result;
  };
}
```

#### Category 4: WebGL Fingerprint
```javascript
function spoofWebGL() {
  // Spoof GPU vendor/renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL = 37445
    if (param === 37445) return 'Google Inc. (Intel)';
    // UNMASKED_RENDERER_WEBGL = 37446
    if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)';
    return getParameter.call(this, param);
  };

  // Also spoof WebGL2
  if (window.WebGL2RenderingContext) {
    const gp2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (Intel)';
      if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)';
      return gp2.call(this, param);
    };
  }
}
```

#### Category 5: AudioContext Fingerprint
```javascript
function spoofAudioContext() {
  const originalGetChannelData = AudioBuffer.prototype.getChannelData;
  const noise = generatePerSessionNoise();

  AudioBuffer.prototype.getChannelData = function(channel) {
    const data = originalGetChannelData.call(this, channel);
    // Add inaudible noise
    for (let i = 0; i < data.length; i++) {
      data[i] += (noise[i % noise.length] - 128) / 1000000; // -128 to +127 / 1e6
    }
    return data;
  };

  // Spoof analyser node data
  const originalGetFloatFrequencyData =
    AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(array) {
    originalGetFloatFrequencyData.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] += (Math.random() - 0.5) * 0.01;
    }
  };
}
```

#### Category 6: Font Enumeration
```javascript
function spoofFonts() {
  // Override document.fonts to prevent enumeration
  const originalQuery = FontFaceSet.prototype.query;
  // This is experimental and may not work in all browsers
  if (originalQuery) {
    FontFaceSet.prototype.query = function() {
      // Return fake font list
      return Promise.resolve([
        { family: 'Arial' },
        { family: 'Times New Roman' },
        { family: 'Courier New' },
        { family: 'Georgia' },
        { family: 'Verdana' },
        { family: 'Trebuchet MS' },
      ].filter(() => true)); // Minimal set
    };
  }
}
```

#### Category 7: Timezone & Locale
```javascript
function spoofTimezone() {
  // Override Date methods
  const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  const spoofedOffset = -300; // UTC-5 (Eastern US)

  Date.prototype.getTimezoneOffset = function() {
    return spoofedOffset;
  };

  // Override Intl API
  const originalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function(locales, options) {
    if (options && options.timeZone) {
      options.timeZone = 'America/New_York';
    }
    return new originalDateTimeFormat(locales, options);
  };
  Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
}
```

#### Category 8: WebRTC IP Leak Prevention
```javascript
function blockWebRTCLeaks() {
  // Block RTCPeerConnection to prevent IP leaks
  if (window.RTCPeerConnection) {
    const origRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
      const pc = new origRTC(...args);

      // Override createOffer/createAnswer to strip local IPs
      const origCreateOffer = pc.createOffer.bind(pc);
      pc.createOffer = function(...a) {
        return origCreateOffer(...a).then(desc => {
          // Remove local candidates from SDP
          desc.sdp = desc.sdp.replace(
            /a=candidate:(\d+) (\d+) (\w+) (\d+) (\S+) (\d+) typ (\w+).*/g,
            ''
          );
          return desc;
        });
      };

      return pc;
    };
  }

  // Also block the older webkitRTCPeerConnection
  if (window.webkitRTCPeerConnection) {
    delete window.webkitRTCPeerConnection;
  }
}
```

#### Category 9: Plugins & MIME Types
```javascript
function spoofPlugins() {
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      // Return minimal plugin list
      return {
        length: 0,
        item: () => null,
        namedItem: () => null,
        refresh: () => {},
      };
    },
  });

  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      return {
        length: 0,
        item: () => null,
        namedItem: () => null,
      };
    },
  });
}
```

#### Category 10: Battery API
```javascript
function spoofBattery() {
  if (navigator.getBattery) {
    const origGetBattery = navigator.getBattery.bind(navigator);
    navigator.getBattery = function() {
      return origGetBattery().then(battery => {
        // Override battery properties
        Object.defineProperty(battery, 'level', { get: () => 1.0 });
        Object.defineProperty(battery, 'charging', { get: () => true });
        Object.defineProperty(battery, 'chargingTime', { get: () => 0 });
        Object.defineProperty(battery, 'dischargingTime', { get: () => Infinity });
        return battery;
      });
    };
  }
}
```

### Complete Fingerprint Randomization Engine

```javascript
// fingerprint.js — injected into every proxied page

(function() {
  'use strict';
  if (window.__neptune_fingerprint_loaded) return;
  window.__neptune_fingerprint_loaded = true;

  // Generate per-session consistent noise (not random — consistent within session)
  const SESSION_SEED = Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0);
  function mulberry32(a) {
    return function() {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 0xFFFFFFFF;
    };
  }
  const prng = mulberry32(SESSION_SEED);

  function generateNoise(length) {
    return new Uint8Array(Array.from({length}, () => Math.floor(prng() * 256)));
  }

  const NOISE = generateNoise(256);

  // Apply ALL spoofs
  applyNavigatorSpoofs();
  applyScreenSpoofs();
  spoofCanvas(NOISE);
  spoofWebGL();
  spoofAudioContext(NOISE);
  spoofFonts();
  spoofTimezone();
  blockWebRTCLeaks();
  spoofPlugins();
  spoofBattery();
  spoofMiscApis();

  // === Application Functions ===

  function applyNavigatorSpoofs() {
    const overrides = {
      userAgent: navigator.userAgent.replace(/Chrome\/[\d.]+/, 'Chrome/120.0.0.0'),
      platform: 'Win32',
      hardwareConcurrency: 8,
      deviceMemory: 16,
      language: 'en-US',
      languages: ['en-US', 'en'],
      maxTouchPoints: 0,
    };

    for (const [key, val] of Object.entries(overrides)) {
      try {
        Object.defineProperty(navigator, key, {
          get: () => val,
          configurable: true,
        });
      } catch(e) {}
    }
  }

  function applyScreenSpoofs() {
    const overrides = {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
    };
    for (const [key, val] of Object.entries(overrides)) {
      try {
        Object.defineProperty(screen, key, {
          get: () => val,
          configurable: true,
        });
      } catch(e) {}
    }
  }

  function spoofMiscApis() {
    // Block Permission API queries
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(desc) {
        // Block geolocation, camera, microphone queries
        if (['geolocation','camera','microphone','notifications'].includes(desc.name)) {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return origQuery(desc);
      };
    }

    // Spoof connection info
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'type', {
        get: () => 'wifi',
      });
      Object.defineProperty(navigator.connection, 'effectiveType', {
        get: () => '4g',
      });
    }

    // Spoof touch support
    if (navigator.maxTouchPoints > 0) {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: () => 0,
      });
    }
  }

  console.log('[Neptune] Fingerprint randomization active');
})();
```

### Integration with HTML Rewriting

The fingerprint engine must be injected BEFORE any page scripts run. In `sw.js`'s `transformHTML`:

```javascript
function transformHTML(html, targetUrl, origin, cfg) {
  // ... existing code ...

  // Inject fingerprint engine at the VERY TOP of <head>
  const fingerprintScript = `<script>${FINGERPRINT_ENGINE_CODE}</script>`;

  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + fingerprintScript);
  } else if (html.includes('<html>')) {
    html = html.replace('<html>', '<html><head>' + fingerprintScript + '</head>');
  } else {
    html = fingerprintScript + html;
  }

  // ... rest of transformation ...
}
```

---

## Phase 6: Traffic Obfuscation & Anti-Censorship {#phase-6-traffic-obfuscation}

### HTTP Header Randomization

Normalize or randomize headers to prevent server-side fingerprinting:

```javascript
// Order and presence of headers is a fingerprint
const HEADER_PROFILES = [
  // Chrome 120 on Windows profile
  {
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  },
  // Firefox 121 on Windows profile
  {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
  },
  // Safari on macOS profile
  {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  },
];

function randomizeHeaders(headers) {
  const profile = HEADER_PROFILES[Math.floor(Math.random() * HEADER_PROFILES.length)];
  for (const [k, v] of Object.entries(profile)) {
    headers.set(k, v);
  }
  return headers;
}
```

### TLS Fingerprint Randomization (JA3/JA4)

JA3 fingerprinting identifies clients by their TLS ClientHello parameters (cipher suites, extensions, elliptic curves). With smoltcp + epoxy-tls, we can control the exact TLS parameters:

```rust
// In smoltcp HTTP client
fn randomize_tls_params() -> TlsConfig {
    // Rotate cipher suite order
    let cipher_suites = vec![
        CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        CipherSuite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        CipherSuite::TLS_AES_128_GCM_SHA256,
        CipherSuite::TLS_AES_256_GCM_SHA384,
        CipherSuite::TLS_CHACHA20_POLY1305_SHA256,
    ];

    // Shuffle to randomize JA3 fingerprint
    // (actually implementing a shuffle is more complex — simplified here)

    TlsConfig::new().with_cipher_suites(&cipher_suites)
}
```

### HTTP/2 Fingerprint Randomization

HTTP/2 settings and pseudo-header order are also fingerprintable. With smoltcp, we control them:

```rust
fn randomize_h2_settings() -> Vec<Setting> {
    vec![
        Setting::new(SETTINGS_HEADER_TABLE_SIZE, rand_range(4096, 65536)),
        Setting::new(SETTINGS_ENABLE_PUSH, 0),
        Setting::new(SETTINGS_MAX_CONCURRENT_STREAMS, rand_range(100, 1000)),
        Setting::new(SETTINGS_INITIAL_WINDOW_SIZE, rand_range(65535, 2097152)),
        Setting::new(SETTINGS_MAX_FRAME_SIZE, 16384),
        Setting::new(SETTINGS_MAX_HEADER_LIST_SIZE, rand_range(16384, 65536)),
    ]
}
```

### Request Timing Obfuscation

Constant timing patterns are detectable. Add jitter:

```javascript
function delayedFetch(url, init) {
  const jitter = Math.random() * 200; // 0-200ms random delay
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(fetch(url, init));
    }, jitter);
  });
}
```

### Referrer Policy

```javascript
// Strip referrer from all outgoing requests
const referrerPolicy = 'no-referrer';
headers.set('Referrer-Policy', referrerPolicy);
headers.delete('Referer');
```

---

## Phase 7: ServiceWorker as Physical Layer — The Bridge {#phase-7-serviceworker-physical-layer}

### The Critical Communication Path

All phases (v86, smoltcp, MirageOS) share one requirement: the ability to exchange data between WASM and the ServiceWorker. The architecture is:

```
WASM Stack (smoltcp/v86/MirageOS)
    ↓ SharedArrayBuffer (raw bytes)
JS Bridge (in SVG page)
    ↓ postMessage
ServiceWorker (sw.js)
    ↓ fetch()
Internet
```

### SharedArrayBuffer Communication

```javascript
// Create shared memory between page and ServiceWorker
// (Requires COOP/COEP headers or workaround)

// In the SVG page:
const sab = new SharedArrayBuffer(65536); // 64KB ring buffer
const view = new Uint8Array(sab);

// Pass to ServiceWorker
navigator.serviceWorker.controller.postMessage({
  type: 'INIT_SHARED_BUFFER',
  buffer: sab,
});

// In sw.js:
let sharedBuffer = null;
let sharedView = null;

// In message handler:
case 'INIT_SHARED_BUFFER':
  sharedBuffer = d.buffer;
  sharedView = new Uint8Array(sharedBuffer);
  break;
```

### Atomics-Based Ring Buffer

```javascript
// Ring buffer protocol for WASM ↔ SW communication
const RING_SIZE = 65536;
const HEAD_OFFSET = 0;   // Byte offset for write head
const TAIL_OFFSET = 4;   // Byte offset for read head
const DATA_OFFSET = 8;   // Start of data

function ringBufferWrite(view, data) {
  const head = Atomics.load(view, HEAD_OFFSET / 4);
  const tail = Atomics.load(view, TAIL_OFFSET / 4);

  // Calculate available space
  let available = (tail - head - 1 + RING_SIZE) % RING_SIZE;

  if (data.length > available) return false; // Buffer full

  for (let i = 0; i < data.length; i++) {
    view[DATA_OFFSET + ((head + i) % (RING_SIZE - DATA_OFFSET))] = data[i];
  }

  Atomics.store(view, HEAD_OFFSET / 4, (head + data.length) % (RING_SIZE - DATA_OFFSET));
  Atomics.notify(view, HEAD_OFFSET / 4, 1); // Wake up reader
  return true;
}

function ringBufferRead(view, maxLen) {
  const head = Atomics.load(view, HEAD_OFFSET / 4);
  let tail = Atomics.load(view, TAIL_OFFSET / 4);

  if (head === tail) {
    // Nothing to read — wait
    Atomics.wait(view, TAIL_OFFSET / 4, tail, 100);
    tail = Atomics.load(view, TAIL_OFFSET / 4);
    if (head === tail) return null;
  }

  const available = (head - tail + RING_SIZE) % RING_SIZE;
  const len = Math.min(available, maxLen);
  const result = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    result[i] = view[DATA_OFFSET + ((tail + i) % (RING_SIZE - DATA_OFFSET))];
  }

  Atomics.store(view, TAIL_OFFSET / 4, (tail + len) % (RING_SIZE - DATA_OFFSET));
  return result;
}
```

### Cross-Origin Isolation (Required for SharedArrayBuffer)

SharedArrayBuffer requires COOP/COEP headers. When served from a web server, these can be set. For local file access, they work in some browsers.

```python
# server.py — add COOP/COEP headers
class NeptuneHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()
```

### Fallback: MessageChannel Without SharedArrayBuffer

If SharedArrayBuffer isn't available, use `postMessage` with transferable objects:

```javascript
// With transferables, large buffers can be moved without copying
const buffer = new ArrayBuffer(65536);
const view = new Uint8Array(buffer);
// ... fill view ...
navigator.serviceWorker.controller.postMessage({
  type: 'NETWORK_DATA',
  data: buffer,
}, [buffer]); // Transfer ownership — no copy
```

---

## Phase 8: JSPI + WASM HTTP Client — The Future {#phase-8-jspi-wasm-http-client}

### What is JSPI?

JSPI (JavaScript Promise Integration) allows WASM modules to call async JavaScript functions as if they were synchronous. The WASM engine suspends execution, the Promise resolves, and execution resumes — all transparently.

```
Rust code:          let resp = fetch_url(url).await;
                          ↓
WASM:               call $js_fetch
                          ↓
JSPI Engine:        Suspend WASM stack
                    Call JS fetch()
                    Wait for Promise
                    Resume WASM stack with result
                          ↓
Rust code:          resp is available (looks synchronous)
```

### Browser Support

- Chrome 126+ (behind `#enable-experimental-webassembly-jspi` flag)
- Chrome 137+: Enabled by default
- Firefox: In development
- Safari: No timeline yet

### Implementation with JSPI

```rust
// src/jspi_client.rs
// With JSPI, we can use standard Rust HTTP libraries

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

#[wasm_bindgen]
pub async fn jspi_http_get(url: String) -> Result<String, JsValue> {
    // This is async Rust, compiled to WASM with JSPI
    // JSPI makes it work as if it were synchronous at the WASM level

    let mut opts = RequestInit::new();
    opts.method("GET");

    let request = Request::new_with_str_and_init(&url, &opts)?;
    let window = web_sys::window().unwrap();

    // fetch() is async, but JSPI handles the suspension
    let resp_value = JsFuture::from(window.fetch_with_request(&request)).await?;
    let resp: Response = resp_value.dyn_into()?;

    let body = JsFuture::from(resp.text()?).await?;
    Ok(body.as_string().unwrap_or_default())
}
```

### Integrating Hyper with JSPI

With JSPI + a custom connector, the Rust `hyper` HTTP library could work in-browser:

```rust
// Concept: hyper with fetch() connector
use hyper::{Client, Request};
use hyper::body::Body;

async fn proxy_request(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    // Client uses a custom connector that bridges to JS fetch()
    let client = Client::builder()
        .build::<_, hyper::Body>(FetchConnector::new());

    let req = Request::builder()
        .uri(url)
        .body(Body::empty())?;

    let resp = client.request(req).await?;
    let body_bytes = hyper::body::to_bytes(resp).await?;

    Ok(String::from_utf8_lossy(&body_bytes).to_string())
}
```

### JSPI Size Impact

- JSPI adds no code size (it's a runtime feature)
- Full `hyper` + `tokio` would be ~500KB+ WASM
- Minimal JSPI client: ~50KB WASM

---

## Phase 9: Epoxy-TLS + Wisp Integration {#phase-9-epoxy-tls-wisp}

### Epoxy-TLS

[epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls) is a Rust TLS implementation compiled to WASM. It provides encrypted TCP streams in-browser:

```javascript
// epoxy-tls creates encrypted TCP connections via Wisp
import init, { EpoxyClient } from './epoxy_tls.js';

const client = new EpoxyClient("wss://relay.example.com/wisp", "example.com", 443);
await client.connect();

// Raw TCP over TLS in the browser
client.send(new TextEncoder().encode(
  "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
));
const response = await client.receive();
```

### Wisp Protocol

[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) multiplexes TCP/UDP streams over a single WebSocket:

```
┌─────────────────────┐         ┌──────────────────┐
│  WASM TCP Client    │         │  Wisp Relay       │
│  (smoltcp/epoxy)    │         │  (needs a server) │
│         │           │         │         │         │
│  Wisp Client (JS)   │◄─WS────►│  Wisp Server      │
│  Stream 0: TCP :443 │         │  → Internet :443  │
│  Stream 1: TCP :80  │         │  → Internet :80   │
│  Stream 2: UDP :53  │         │  → Internet :53   │
└─────────────────────┘         └──────────────────┘
```

### The Relay Problem

Wisp requires a relay server — the same problem as v86's WebSocket relay. A public Wisp relay defeats the "no external URLs" goal.

### Solution: Self-Wisp (Recursive Proxy)

The ServiceWorker acts as the Wisp relay:

```
WASM TCP Stack
    ↓ Wisp protocol (in-page)
ServiceWorker (receives Wisp frames via postMessage)
    ↓ fetch()
Internet
```

```javascript
// In sw.js — Wisp relay implementation
case 'WISP_CONNECT':
  (async () => {
    const { streamId, host, port } = d;

    // Use fetch() to establish the connection
    // For HTTP: direct fetch
    // For HTTPS: we'd need CONNECT tunneling, which isn't possible in SW

    // Store stream state
    wispStreams.set(streamId, { host, port, buffer: [] });
  })();
  break;

case 'WISP_SEND':
  (async () => {
    const { streamId, data } = d;
    const stream = wispStreams.get(streamId);
    if (!stream) return;

    try {
      const resp = await fetch(`http://${stream.host}:${stream.port}/`, {
        method: 'POST',
        body: data,
      });
      const respData = await resp.arrayBuffer();

      if (src) src.postMessage({
        type: 'WISP_RECEIVE',
        streamId,
        data: b64Encode(respData),
      });
    } catch (e) {
      if (src) src.postMessage({
        type: 'WISP_ERROR',
        streamId,
        error: e.message,
      });
    }
  })();
  break;
```

---

## Phase 10: Integration & Assembly {#phase-10-integration}

### Build System Changes (build.py → v3)

```python
# build.py v3 — Builds all phases into a single SVG
def main():
    # 1. Compile Rust WASM kernel (existing)
    compile_rust_wasm()

    # 2. Compile smoltcp WASM stack (new)
    compile_smoltcp_wasm()

    # 3. Compile fingerprint engine (new)
    # Just read the JS file and inline it
    finger_print_js = read_file("src/fingerprint.js")

    # 4. Bundle v86 emulator (Phase 1 — largest)
    v86_wasm_b64 = b64_file("vendor/v86.wasm")
    v86_js_b64 = b64_file("vendor/v86.js")
    linux_img_b64 = b64_file("build/neptune-rootfs.img")

    # 5. Read ServiceWorker
    sw_js = read_file("sw.js")

    # 6. Inject placeholders into template
    template = read_file("template.svg")
    template = template.replace("{{SW_CODE}}", b64(sw_js))
    template = template.replace("{{WASM_JS}}", b64(wasm_js))
    template = template.replace("{{WASM_BIN}}", b64(wasm_bin))
    template = template.replace("{{SMOLTCP_WASM}}", b64(smoltcp_wasm))
    template = template.replace("{{SMOLTCP_JS}}", b64(smoltcp_js))
    template = template.replace("{{V86_WASM}}", v86_wasm_b64)
    template = template.replace("{{V86_JS}}", v86_js_b64)
    template = template.replace("{{LINUX_IMG}}", linux_img_b64)
    template = template.replace("{{FINGERPRINT_JS}}", b64(finger_print_js))

    # 7. Write output
    write_file("neptune.svg", template)
```

### Size Budget with All Phases

| Component | Raw Size | Base64 | Required? |
|-----------|----------|--------|-----------|
| Neptune UI (HTML/CSS/JS) | 50 KB | 67 KB | ✅ Always |
| ServiceWorker (sw.js) | 30 KB | 40 KB | ✅ Always |
| WASM Kernel (existing) | 200 KB | 267 KB | ✅ Always |
| Fingerprint Engine (JS) | 15 KB | 20 KB | ✅ Always |
| smoltcp WASM Stack | 250 KB | 334 KB | ⚠️ Phase 3 |
| smoltcp JS Bridge | 10 KB | 14 KB | ⚠️ Phase 3 |
| epoxy-tls WASM | 200 KB | 267 KB | ⚠️ Phase 9 |
| v86 WASM + JS | 1.65 MB | 2.2 MB | ⚠️ Phase 1 |
| Linux VM image | 5 MB | 6.7 MB | ⚠️ Phase 1 |
| Dillo browser | 1.5 MB | 2.0 MB | ⚠️ Phase 1 |
| MirageOS WASM | 3 MB | 4 MB | ⚠️ Phase 4 |
| **Base Configuration** | **295 KB** | **394 KB** | |
| **+ smoltcp** | **545 KB** | **727 KB** | |
| **+ v86 (nuclear)** | **8.8 MB** | **11.7 MB** | |
| **+ Everything** | **11.1 MB** | **14.8 MB** | |

### Loading Strategy: Progressive Enhancement

Don't load everything at once. Load base + what's needed:

```javascript
async function boot() {
  // Always load base
  await loadBaseUI();
  await loadServiceWorker();
  await loadWASMKernel();
  applyFingerprintProtection(); // Always active

  // Detect what strategy works
  const strategy = await detectStrategy(targetUrl);

  if (strategy === 'cors') {
    // Fast path — existing direct fetch works
    startDirectProxy(targetUrl);
  } else if (strategy === 'iframe') {
    // Medium path — iframe visual proxy
    startIframeProxy(targetUrl);
  } else {
    // Nuclear path — need v86 or smoltcp
    console.log('[Neptune] Site blocks all direct access. Booting proxy VM...');

    // Try smoltcp first (smaller, faster)
    try {
      await loadSmoltcp();
      startSmoltcpProxy(targetUrl);
    } catch (e) {
      // Fall back to v86
      console.log('[Neptune] smoltcp unavailable. Booting v86 VM...');
      toast('Booting proxy VM (~15s)...', 'info');
      await loadV86();
      startV86Proxy(targetUrl);
    }
  }
}
```

---

## Appendix A: Size Budget Analysis {#appendix-a-size-budget}

### Optimal Target: < 10MB

- GitHub Pages limit: 1GB per repo, but practical load times matter
- 10MB SVG on 10 Mbps connection: ~8 seconds
- 15MB SVG: ~12 seconds (borderline acceptable)
- 5MB SVG: < 4 seconds (good UX)

### Compression

SVG files are text — they gzip well:
- 10MB raw SVG → ~3MB gzipped
- 15MB raw SVG → ~5MB gzipped

If served from a web server, gzip reduces effective size dramatically. GitHub Pages applies gzip automatically.

### minify + brotli

- Brotli typically 15-20% smaller than gzip
- SVG contains base64 (already compressed) — doesn't compress further
- JS/CSS/HTML in SVG DOES compress well

---

## Appendix B: Attack Surface & Security Model {#appendix-b-security}

### Threat Model

The SVG file is a self-contained application with full JavaScript and WASM execution. It can:
- Make any HTTP request
- Run arbitrary WASM code
- Access localStorage/IndexedDB
- Register ServiceWorkers
- Open WebSocket connections
- Render HTML in iframes

### Security Boundaries

1. **Same-Origin Policy**: The SW can only intercept same-origin requests. The proxy works by keeping all URLs same-origin via rewriting.
2. **iframe Sandbox**: Visual proxy iframes have sandbox attributes preventing navigation and popups.
3. **Content Security Policy**: The SVG should have CSP headers preventing inline script execution from third parties.
4. **WASM Sandbox**: WASM runs in the browser's sandbox — no filesystem, no raw sockets, no process creation.
5. **v86 Emulator**: The VM has its own kernel-level isolation. Even if the VM is compromised, it can't escape the browser sandbox.

### Privacy Guarantees

- All browsing data stays in the user's browser
- No external servers receive browsing history
- Fingerprint randomization prevents tracking
- Tracker blocking strips known analytics/tracking scripts
- Cookie isolation per-domain

### Limitations

- IP address is still visible to target servers
- Timing attacks can still correlate browsing sessions
- Browser still exposes some hardware-level fingerprints
- v86-based proxy has inherent latency from emulation
- Not suitable for streaming video or WebSocket-heavy apps

---

## Appendix C: Testing Matrix {#appendix-c-testing}

### Test Sites by Category

| Category | Site | Expected Strategy |
|----------|------|-------------------|
| CORS-friendly | example.com | Direct fetch |
| CORS-friendly | httpbin.org | Direct fetch |
| CORS-friendly | neverssl.com | Direct fetch |
| Partial CORS | github.com | Direct + iframe fallback |
| CORS-blocked | google.com | iframe or v86 |
| CORS-blocked | facebook.com | iframe or v86 |
| CORS-blocked | twitter.com | iframe or v86 |
| Frame-blocked | docs.google.com | v86 (nuclear) |
| Frame-blocked | stripe.com | v86 (nuclear) |
| JS-heavy SPA | reactjs.org | Direct fetch |
| Streaming | youtube.com | iframe |
| WebSocket | discord.com | v86 (nuclear) |

### Performance Targets

| Metric | Target |
|--------|--------|
| SVG load time | < 5s (base), < 15s (full) |
| Page load (direct) | < 2s overhead vs. native |
| Page load (iframe) | < 1s overhead vs. native |
| VM boot time | < 15s |
| VM page load | < 10s |
| Fingerprint uniqueness | < 0.01% of real fingerprints |

---

## Implementation Order

1. **Week 1-2**: Phase 5 (Fingerprint Engine) + integrate into existing codebase
2. **Week 2-3**: Phase 3 (smoltcp WASM stack) — proof of concept
3. **Week 3-4**: Phase 7 (SW Physical Layer bridge with SharedArrayBuffer)
4. **Week 4-5**: Phase 2 (Custom v86 network adapter — parse Ethernet frames in JS)
5. **Week 5-7**: Phase 1 (v86 Browser-in-Browser — build Linux VM, embed in SVG)
6. **Week 7-8**: Phase 6 (Traffic obfuscation — header randomization, TLS fingerprint)
7. **Week 8-10**: Phase 10 (Integration — progressive loading, build system)
8. **Week 10+**: Phase 9 (Epoxy-TLS/Wisp), Phase 4 (MirageOS), Phase 8 (JSPI)

---

## References

- [v86 Emulator](https://github.com/copy/v86) — x86 emulator in browser WASM
- [smoltcp](https://github.com/smoltcp-rs/smoltcp) — Rust TCP/IP stack
- [Wisp Protocol](https://github.com/MercuryWorkshop/wisp-protocol) — TCP over WebSocket multiplexing
- [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls) — TLS in browser WASM
- [MirageOS](https://mirage.io/) — Unikernel library OS
- [wasm_of_ocaml](https://github.com/ocaml-wasm/wasm_of_ocaml) — OCaml to WASM
- [JSPI Proposal](https://github.com/WebAssembly/js-promise-integration)
- [Ultraviolet Proxy](https://github.com/titaniumnetwork-dev/Ultraviolet)
- [Rammerhead Proxy](https://github.com/rsa16/rammerhead-proxy)
- [Neptune Project](https://github.com/) — This project
