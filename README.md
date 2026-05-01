# project: neptune — WASM Unikernel Proxy

A browser-based proxy/unikernel architecture built from an SVG bootloader shell, Service Worker network kernel, and Rust/WASM logic engine.

## Architecture

```
+-------------------------------------------------------------+
|                         BROWSER                              |
|  +------------------------------------------------------+  |
|  |  SVG Bootloader (bootloader.svg)                     |  |
|  |  - Embedded JS reads ?url= parameter                   |  |
|  |  - Registers Service Worker                          |  |
|  |  - Displays terminal-style loading UI                |  |
|  +------------------------------------------------------+  |
|                           |                                |
|  +------------------------v-------------------------------+  |
|  |  Service Worker Kernel (sw.js)                         |  |
|  |  - Intercepts all fetch() within scope                   |  |
|  |  - Routes requests to WASM kernel                      |  |
|  |  - Manages IndexedDB VFS                               |  |
|  |  - Handles CORS via proxy/WebRTC strategies            |  |
|  +------------------------+-------------------------------+  |
|                           |                                |
|  +------------------------v-------------------------------+  |
|  |  WASM Unikernel (neptune-kernel)                       |  |
|  |  - Request transformation and HTML rewriting           |  |
|  |  - Proxy routing rules                                   |  |
|  |  - State serialization/snapshots                       |  |
|  +--------------------------------------------------------+  |
|                                                              |
|  +------------------------v-------------------------------+  |
|  |  IndexedDB VFS Bridge (vfs-bridge.js)                    |  |
|  |  - POSIX-like filesystem API                             |  |
|  |  - Persistent /etc, /var, /home across sessions          |  |
|  |  - WASM memory sync for snapshots                        |  |
|  +--------------------------------------------------------+  |
+-------------------------------------------------------------+
```

## Phases

### Phase 1: The Bootloader (SVG Shell)
The `bootloader.svg` acts as the container. It contains:
- A `<script>` that reads `window.location.search` for the target URL
- A terminal-style UI rendered via SVG `<foreignObject>`
- Service Worker registration logic
- State snapshot detection and loading

### Phase 2: The Service Worker Kernel
`sw.js` intercepts all network requests:
- Scope hijacking on `./` — all requests go through `fetch` listener
- Virtual root routing: `/virtual-root/?url=...` triggers proxy mode
- HTML transformation: rewrites links to stay within SW scope
- CORS strategies: direct, no-cors fallback, WebRTC bridge, or extension mode

### Phase 3: The WASM Unikernel
`src/lib.rs` compiled to WASM:
- Headless, highly optimized Rust code
- HTML transformation engine
- Request/response pipeline
- Virtual filesystem cache (`vfs_cache`)
- Base64 state snapshot serialization

### Phase 4: The VFS Bridge
`vfs-bridge.js` provides:
- IndexedDB-backed POSIX filesystem
- `open`, `read`, `write`, `close`, `stat`, `readdir`, `mkdir`, `unlink`
- WASM memory sync for checkpoint/restore
- Snapshot export/import (compressed + base64)

## Usage

### Quick Start

1. **Build the WASM kernel:**
   ```bash
   make wasm-build
   ```
   (Requires [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/))

2. **Serve with HTTPS (required for Service Workers):**
   ```bash
   make certs    # Generate self-signed certificates
   make serve-https
   ```

3. **Open in browser:**
   ```
   https://localhost:8443/index.html
   ```

4. **Enter a target URL and click "Boot Proxy"**

### Direct SVG Access

Navigate directly to the bootloader with a target:
```
https://localhost:8443/bootloader.svg?url=https://example.com
```

### State Snapshots

The kernel can serialize its entire heap into a base64 string embedded in the SVG URL:
```javascript
// Inside the SVG context or from the host page
const snapshot = kernel.create_snapshot();
// Produces: bootloader.svg?state=BASE64...
```

## CORS Strategies

| Strategy | Description | Use Case |
|-----------|-------------|----------|
| `proxy` | Direct fetch with no-cors fallback | Same-origin or permissive CORS targets |
| `webrtc` | Route through WebRTC mesh | Peer-to-peer proxy networks |
| `extension` | Browser extension permissions | Full cross-origin access (packaged as extension) |

Switch strategies via postMessage:
```javascript
navigator.serviceWorker.controller.postMessage({
  type: 'SET_CORS_STRATEGY',
  strategy: 'webrtc'
});
```

## File Structure

```
neptune/
├── bootloader.svg      # SVG shell with embedded JS bootloader
├── sw.js              # Service Worker network kernel
├── vfs-bridge.js      # IndexedDB VFS POSIX bridge
├── index.html         # Host page and UI
├── Cargo.toml         # Rust/WASM build config
├── src/
│   └── lib.rs         # WASM unikernel core
├── Makefile           # Build automation
└── README.md          # This file
```

## Development

```bash
# Watch and rebuild on changes
make watch

# Run tests
make test

# Clean everything
make clean

# Build distribution
make dist
```

## Security Notes

- Service Workers require HTTPS (or localhost)
- The proxy modifies HTML content — sanitize user inputs
- WebRTC mode requires signaling infrastructure
- Extension mode requires `permissions: ["<all_urls>"]` in manifest.json

## License

MIT
