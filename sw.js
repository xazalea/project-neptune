/**
 * project: neptune — Service Worker Kernel
 * Acts as the Network Interface Card (NIC) and Scheduler for the WASM unikernel.
 * Intercepts all fetch requests within scope and routes them through the WASM kernel.
 */

const SW_VERSION = '0.1.0';
const CACHE_NAME = 'neptune-kernel-v' + SW_VERSION;

// Kernel state
let activeTarget = null;
let wasmModule = null;
let vfsReady = false;
let snapshotData = null;
let corsStrategy = 'proxy'; // 'proxy' | 'webrtc' | 'extension'

// IndexedDB VFS handles
const DB_NAME = 'neptune-vfs';
const DB_VERSION = 1;
let vfsDB = null;

// WebRTC peer (if using bridge mode)
let rtcPeer = null;
let rtcDataChannel = null;

// ==========================
// Lifecycle Events
// ==========================

self.addEventListener('install', (event) => {
  console.log('[SW] Neptune kernel installing v' + SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Neptune kernel activated v' + SW_VERSION);
  event.waitUntil(
    clients.claim().then(() => {
      initVFS();
      broadcast({ type: 'KERNEL_READY', version: SW_VERSION });
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  switch (data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'SET_TARGET':
      activeTarget = data.url;
      snapshotData = data.snapshot || null;
      console.log('[SW] Target set:', activeTarget);
      // Persist target in VFS for recovery
      vfsPut('/etc/neptune/target', activeTarget);
      if (snapshotData) {
        vfsPut('/var/neptune/snapshot', snapshotData);
      }
      broadcast({ type: 'TARGET_SET', url: activeTarget });
      break;

    case 'WASM_LOADED':
      wasmModule = data.module;
      console.log('[SW] WASM module registered');
      break;

    case 'SET_CORS_STRATEGY':
      corsStrategy = data.strategy || 'proxy';
      console.log('[SW] CORS strategy:', corsStrategy);
      break;

    case 'WEBRTC_CONNECT':
      initWebRTC(data.config);
      break;

    case 'VFS_SYNC':
      // Trigger VFS sync from WASM memory
      syncVFSFromWASM(data.buffer);
      break;

    case 'EXPORT_STATE':
      exportState().then(state => {
        event.source.postMessage({ type: 'STATE_EXPORTED', state });
      });
      break;

    default:
      console.log('[SW] Unknown message type:', data.type);
  }
});

// ==========================
// Fetch Interception (The NIC)
// ==========================

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET for now (can be expanded)
  if (event.request.method !== 'GET' && event.request.method !== 'POST') {
    return;
  }

  // Don't intercept our own assets
  if (url.pathname.endsWith('bootloader.svg') ||
      url.pathname.endsWith('sw.js') ||
      url.pathname.endsWith('index.html')) {
    return;
  }

  // Handle virtual-root routing
  if (url.pathname.startsWith('/virtual-root/') || url.pathname === '/virtual-root') {
    event.respondWith(handleVirtualRoot(event.request, url));
    return;
  }

  // If we have an active target, intercept relative requests
  if (activeTarget) {
    event.respondWith(handleProxyRequest(event.request, url));
  }
});

// ==========================
// Request Handlers
// ==========================

async function handleVirtualRoot(request, url) {
  const target = activeTarget;
  if (!target) {
    return new Response(
      '<html><body style="background:#0a0a0f;color:#00ff88;font-family:monospace;">' +
      '<h1>No target configured</h1><p>Use ?url=proxied.site</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }

  // Proxy the initial request
  try {
    const response = await proxyFetch(target, {
      method: request.method,
      headers: request.headers,
      redirect: 'follow'
    });

    // Transform HTML to route through our scope
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const transformed = transformHTML(html, target, url.origin);
      return new Response(transformed, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeHeaders(response.headers)
      });
    }

    return response;
  } catch (err) {
    console.error('[SW] Proxy error:', err);
    return new Response(
      '<html><body style="background:#0a0a0f;color:#ff4444;font-family:monospace;">' +
      '<h1>Proxy Error</h1><pre>' + err.message + '</pre></body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function handleProxyRequest(request, url) {
  const target = activeTarget;
  const targetUrl = new URL(target);

  // Resolve relative URLs against the target
  let proxiedUrl;
  try {
    // If it's an absolute URL not matching target, might be external resource
    if (url.origin !== self.location.origin) {
      return fetch(request); // Pass through
    }
    // Construct target-relative URL
    const relativePath = url.pathname + url.search;
    proxiedUrl = new URL(relativePath, target).toString();
  } catch (e) {
    return fetch(request);
  }

  try {
    const response = await proxyFetch(proxiedUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });

    // Transform HTML responses
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const transformed = transformHTML(html, target, self.location.origin);
      return new Response(transformed, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeHeaders(response.headers)
      });
    }

    return response;
  } catch (err) {
    console.error('[SW] Proxy fetch error:', err);
    return new Response('Proxy Error: ' + err.message, { status: 502 });
  }
}

// ==========================
// CORS Strategies
// ==========================

async function proxyFetch(url, options) {
  switch (corsStrategy) {
    case 'extension':
      // Extension mode: use chrome.extension.getBackgroundPage() equivalent
      // In SW context, this assumes extension permissions are granted
      return fetch(url, options);

    case 'webrtc':
      return webrtcFetch(url, options);

    case 'proxy':
    default:
      // Use a CORS relay or direct fetch with no-cors
      try {
        return await fetch(url, options);
      } catch (e) {
        // Fallback: try no-cors mode (opaque response)
        console.warn('[SW] CORS blocked, trying no-cors fallback for:', url);
        return fetch(url, { ...options, mode: 'no-cors' });
      }
  }
}

async function webrtcFetch(url, options) {
  return new Promise((resolve, reject) => {
    if (!rtcDataChannel || rtcDataChannel.readyState !== 'open') {
      reject(new Error('WebRTC not connected'));
      return;
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => reject(new Error('WebRTC fetch timeout')), 30000);

    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.requestId === requestId) {
          rtcDataChannel.removeEventListener('message', handler);
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(new Response(msg.body, {
              status: msg.status,
              statusText: msg.statusText,
              headers: msg.headers
            }));
          }
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    };

    rtcDataChannel.addEventListener('message', handler);
    rtcDataChannel.send(JSON.stringify({
      type: 'FETCH',
      requestId,
      url,
      options: {
        method: options.method,
        headers: Array.from(options.headers.entries?.() || []),
        body: options.body
      }
    }));
  });
}

function initWebRTC(config) {
  // STUN servers for NAT traversal
  const rtcConfig = config || {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  rtcPeer = new RTCPeerConnection(rtcConfig);
  rtcDataChannel = rtcPeer.createDataChannel('neptune-proxy', {
    ordered: true
  });

  rtcDataChannel.addEventListener('open', () => {
    console.log('[SW] WebRTC data channel open');
    broadcast({ type: 'WEBRTC_OPEN' });
  });

  rtcDataChannel.addEventListener('close', () => {
    console.log('[SW] WebRTC data channel closed');
    broadcast({ type: 'WEBRTC_CLOSE' });
  });

  // Signaling would be handled externally via websocket/relay
  console.log('[SW] WebRTC peer initialized');
}

// ==========================
// HTML Transformation Engine
// ==========================

function transformHTML(html, targetUrl, origin) {
  const target = new URL(targetUrl);
  const base = origin + '/virtual-root/';

  // Inject base tag to help with relative URLs
  const baseTag = `<base href="${target.origin}/">`;

  // Rewrite absolute links to proxy through virtual-root
  let transformed = html;

  // href="/..." -> href="/virtual-root/..."
  transformed = transformed.replace(
    /href="\/([^"]*?)"/g,
    'href="' + base + '$1"'
  );

  // href="http://target.com/..." -> href="/virtual-root/..."
  const escapedOrigin = target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const originRegex = new RegExp('href="' + escapedOrigin + '/([^"]*?)"', 'g');
  transformed = transformed.replace(originRegex, 'href="' + base + '$1"');

  // src="/..." -> src="/virtual-root/..."
  transformed = transformed.replace(
    /src="\/([^"]*?)"/g,
    'src="' + base + '$1"'
  );

  // src="http://target.com/..." -> src="/virtual-root/..."
  const srcOriginRegex = new RegExp('src="' + escapedOrigin + '/([^"]*?)"', 'g');
  transformed = transformed.replace(srcOriginRegex, 'src="' + base + '$1"');

  // Insert base tag and our proxy script
  const proxyScript = `
    <script>
      // Neptune Proxy Runtime Injection
      (function() {
        // Override fetch to route through SW
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
          let url = typeof input === 'string' ? input : input.url || input.toString();
          if (url.startsWith('http') && !url.includes(location.origin)) {
            // External URL - route through virtual-root
            url = '${base}' + encodeURIComponent(url);
          } else if (url.startsWith('/') && !url.startsWith('/virtual-root/')) {
            url = '${base}' + url;
          }
          return originalFetch(url, init);
        };

        // Override XMLHttpRequest
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
          if (url.startsWith('http') && !url.includes(location.origin)) {
            url = '${base}' + encodeURIComponent(url);
          } else if (url.startsWith('/') && !url.startsWith('/virtual-root/')) {
            url = '${base}' + url;
          }
          return originalXhrOpen.call(this, method, url, async, user, password);
        };
      })();
    </script>
  `;

  // Inject before closing </head> or at the start
  if (transformed.includes('</head>')) {
    transformed = transformed.replace('</head>', baseTag + proxyScript + '</head>');
  } else if (transformed.includes('<body')) {
    transformed = transformed.replace('<body', proxyScript + '<body');
  } else {
    transformed = proxyScript + transformed;
  }

  // Inject state restoration if snapshot exists
  if (snapshotData) {
    const restoreScript = `<script>window.__NEPTUNE_SNAPSHOT__ = '${snapshotData}';</script>`;
    transformed = transformed.replace('</head>', restoreScript + '</head>');
  }

  return transformed;
}

function sanitizeHeaders(headers) {
  const safe = new Headers();
  const forbidden = ['set-cookie', 'content-security-policy', 'x-frame-options'];
  headers.forEach((value, key) => {
    if (!forbidden.includes(key.toLowerCase())) {
      safe.set(key, value);
    }
  });
  return safe;
}

// ==========================
// Virtual File System (VFS)
// ==========================

async function initVFS() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      vfsDB = request.result;
      vfsReady = true;
      console.log('[SW] VFS initialized');
      resolve();
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'path' });
      }
    };
  });
}

async function vfsGet(path) {
  if (!vfsDB) return null;
  return new Promise((resolve) => {
    const tx = vfsDB.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const request = store.get(path);
    request.onsuccess = () => resolve(request.result?.data || null);
    request.onerror = () => resolve(null);
  });
}

async function vfsPut(path, data) {
  if (!vfsDB) return;
  return new Promise((resolve) => {
    const tx = vfsDB.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const request = store.put({ path, data, modified: Date.now() });
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

async function syncVFSFromWASM(buffer) {
  // Deserialize WASM memory state into VFS
  // This would be called by the WASM kernel during checkpoints
  console.log('[SW] VFS sync from WASM:', buffer?.byteLength || 0, 'bytes');
  await vfsPut('/var/neptune/wasm-memory', buffer);
}

async function exportState() {
  // Gather all VFS state for snapshot export
  const files = [];
  if (!vfsDB) return { version: SW_VERSION, files };

  return new Promise((resolve) => {
    const tx = vfsDB.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        files.push(cursor.value);
        cursor.continue();
      } else {
        resolve({ version: SW_VERSION, files });
      }
    };

    request.onerror = () => resolve({ version: SW_VERSION, files });
  });
}

// ==========================
// Utilities
// ==========================

function broadcast(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    clients.forEach(client => client.postMessage(msg));
  });
}
