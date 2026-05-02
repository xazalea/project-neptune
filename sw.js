/**
 * project: neptune — Service Worker Kernel
 * Multi-strategy proxy: iframe relay, WebRTC P2P, local proxy, extension mode.
 */

const SW_VERSION = '0.2.0';

// Configurable proxy endpoint
let PROXY_BASE = null;

// Strategy state
let activeTarget = null;
let activeStrategy = null; // 'extension' | 'iframe' | 'webrtc' | 'local' | 'hosted'
let snapshotData = null;

// WebRTC state
let rtcPeer = null;
let rtcChannel = null;
let rtcReady = false;

// iframe relay state
let iframeRelay = null;
let iframeRelayReady = false;

// ==========================
// Lifecycle
// ==========================
self.addEventListener('install', e => {
  console.log('[SW] Installing v' + SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[SW] Activated v' + SW_VERSION);
  e.waitUntil(clients.claim());
});

self.addEventListener('message', e => {
  const d = e.data;
  if (!d || !d.type) return;
  switch (d.type) {
    case 'SKIP_WAITING': self.skipWaiting(); break;
    case 'SET_TARGET':
      activeTarget = d.url;
      snapshotData = d.snapshot || null;
      console.log('[SW] Target:', activeTarget);
      detectStrategy().then(s => {
        activeStrategy = s;
        console.log('[SW] Strategy:', s);
        broadcast({ type: 'STRATEGY_SELECTED', strategy: s });
      });
      broadcast({ type: 'TARGET_SET', url: activeTarget });
      break;
    case 'SET_PROXY':
      PROXY_BASE = d.url;
      console.log('[SW] Proxy base set:', PROXY_BASE);
      break;
    case 'SET_STRATEGY':
      activeStrategy = d.strategy;
      console.log('[SW] Strategy forced:', d.strategy);
      if (d.strategy === 'webrtc') initWebRTC(d.config);
      if (d.strategy === 'iframe') initIframeRelay();
      break;
    case 'WEBRTC_SIGNAL':
      handleRTCSignal(d);
      break;
    case 'IFRAME_RELAY_READY':
      iframeRelayReady = true;
      console.log('[SW] iframe relay ready');
      break;
    case 'IFRAME_RELAY_RESPONSE':
      handleIframeResponse(d);
      break;
  }
});

// ==========================
// Strategy Detection
// ==========================
async function detectStrategy() {
  // 1. Extension mode — no CORS restrictions
  try {
    const test = await fetch('https://example.com', { method: 'HEAD', mode: 'no-cors' });
    // If we can actually read the response (not opaque), we're in extension mode
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      return 'extension';
    }
  } catch (e) {}

  // 2. iframe relay — if target allows framing
  // (tested lazily on first request)

  // 3. WebRTC — if peer available
  // (tested lazily on first request)

  // 4. Local proxy
  if (!PROXY_BASE) {
    const s = new URL(self.registration.scope);
    PROXY_BASE = `${s.protocol}//${s.host}/proxy?url=`;
  }
  try {
    const resp = await fetch(PROXY_BASE + encodeURIComponent('https://example.com'), {
      method: 'HEAD', mode: 'no-cors'
    });
    return 'local';
  } catch (e) {
    console.log('[SW] Local proxy unavailable:', e.message);
  }

  // 5. Hosted proxy (if configured)
  if (PROXY_BASE && PROXY_BASE.includes('http')) {
    return 'hosted';
  }

  return 'none';
}

// ==========================
// Fetch Interception
// ==========================
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip our own assets
  const skip = ['neptune.svg','sw.js','server.py','build.py'];
  if (skip.some(s => url.pathname.endsWith(s))) return;
  if (url.pathname === '/proxy') return;

  if (activeTarget && shouldIntercept(url, e.request)) {
    e.respondWith(proxyRequest(e.request, url));
  }
});

function shouldIntercept(url, req) {
  const ref = req.referrer ? new URL(req.referrer) : null;
  if (ref && ref.searchParams.has('__nptn')) return true;
  if (activeTarget && url.origin === self.location.origin) return true;
  return false;
}

async function proxyRequest(req, url) {
  let targetUrl;

  if (url.searchParams.has('__nptn')) {
    targetUrl = url.searchParams.get('url') || activeTarget;
  } else if (url.origin === self.location.origin) {
    const rel = url.pathname + url.search;
    targetUrl = resolveURL(rel, activeTarget);
  } else {
    return fetch(req);
  }

  if (!targetUrl) {
    return errorResponse('No target configured', 400);
  }

  // Try strategies in priority order
  const strategies = activeStrategy && activeStrategy !== 'none'
    ? [activeStrategy]
    : ['extension', 'iframe', 'webrtc', 'local', 'hosted'];

  for (const strategy of strategies) {
    try {
      const resp = await tryStrategy(strategy, targetUrl, req);
      if (resp) return resp;
    } catch (e) {
      console.log(`[SW] Strategy ${strategy} failed:`, e.message);
    }
  }

  return errorResponse(
    `No working proxy strategy found.<br><br>` +
    `Tried: ${strategies.join(', ')}<br><br>` +
    `To fix:<br>` +
    `1. Run <code>python3 server.py</code> locally for local proxy mode<br>` +
    `2. Install as browser extension for unrestricted cross-origin access<br>` +
    `3. Configure a hosted proxy via postMessage({type:'SET_PROXY', url:'...'})`,
    503
  );
}

async function tryStrategy(strategy, targetUrl, req) {
  switch (strategy) {
    case 'extension':
      return await fetch(targetUrl, { method: req.method });

    case 'iframe':
      return await iframeFetch(targetUrl, req);

    case 'webrtc':
      return await webrtcFetch(targetUrl, req);

    case 'local':
    case 'hosted':
      return await proxyFetch(targetUrl, req);

    default:
      return null;
  }
}

// ==========================
// iframe Relay Strategy
// ==========================
async function iframeFetch(url, req) {
  if (!iframeRelayReady) {
    // Try to initialize iframe relay
    initIframeRelay();
    // Wait a bit for it to load
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!iframeRelayReady) return null;

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => reject(new Error('iframe relay timeout')), 15000);

    const handler = e => {
      if (e.data && e.data.type === 'IFRAME_RELAY_RESPONSE' && e.data.requestId === requestId) {
        clearTimeout(timeout);
        self.removeEventListener('message', handler);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(new Response(
            e.data.body ? Uint8Array.from(atob(e.data.body), c => c.charCodeAt(0)) : null,
            { status: e.data.status, headers: e.data.headers }
          ));
        }
      }
    };

    self.addEventListener('message', handler);
    iframeRelay.postMessage({
      type: 'FETCH',
      requestId,
      url,
      method: req.method,
    }, '*');
  });
}

function initIframeRelay() {
  if (iframeRelay) return;
  // The relay iframe is created by the parent page — we just listen for its ready signal
  console.log('[SW] iframe relay init requested (parent must create iframe)');
}

function handleIframeResponse(data) {
  // Response handled in iframeFetch promise
}

// ==========================
// WebRTC P2P Strategy
// ==========================
async function webrtcFetch(url, req) {
  if (!rtcReady) {
    initWebRTC();
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!rtcReady || !rtcChannel || rtcChannel.readyState !== 'open') return null;

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => reject(new Error('WebRTC timeout')), 30000);

    const handler = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.requestId === requestId) {
          rtcChannel.removeEventListener('message', handler);
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            const body = msg.body ? Uint8Array.from(atob(msg.body), c => c.charCodeAt(0)) : null;
            resolve(new Response(body, {
              status: msg.status,
              statusText: msg.statusText || '',
              headers: msg.headers || {}
            }));
          }
        }
      } catch (e) {}
    };

    rtcChannel.addEventListener('message', handler);
    rtcChannel.send(JSON.stringify({
      type: 'FETCH',
      requestId,
      url,
      method: req.method,
      headers: Array.from(req.headers.entries())
    }));
  });
}

function initWebRTC(config) {
  if (rtcPeer) return;

  const rtcConfig = config || {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  rtcPeer = new RTCPeerConnection(rtcConfig);
  rtcChannel = rtcPeer.createDataChannel('neptune-proxy', { ordered: true });

  rtcChannel.addEventListener('open', () => {
    rtcReady = true;
    console.log('[SW] WebRTC channel open');
    broadcast({ type: 'WEBRTC_OPEN' });
  });

  rtcChannel.addEventListener('close', () => {
    rtcReady = false;
    console.log('[SW] WebRTC channel closed');
  });

  // Signaling would be handled externally
  console.log('[SW] WebRTC initialized, awaiting peer connection');
}

function handleRTCSignal(data) {
  if (!rtcPeer) return;
  if (data.sdp) {
    rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(() => {
        if (data.sdp.type === 'offer') {
          return rtcPeer.createAnswer();
        }
      })
      .then(answer => {
        if (answer) return rtcPeer.setLocalDescription(answer);
      })
      .then(() => {
        broadcast({ type: 'WEBRTC_LOCAL_SDP', sdp: rtcPeer.localDescription });
      })
      .catch(e => console.error('[SW] RTC signal error:', e));
  }
  if (data.candidate) {
    rtcPeer.addIceCandidate(new RTCIceCandidate(data.candidate))
      .catch(e => console.error('[SW] ICE error:', e));
  }
}

// ==========================
// Local/Hosted Proxy Strategy
// ==========================
async function proxyFetch(targetUrl, req) {
  if (!PROXY_BASE) {
    const s = new URL(self.registration.scope);
    PROXY_BASE = `${s.protocol}//${s.host}/proxy?url=`;
  }

  const proxyURL = PROXY_BASE + encodeURIComponent(targetUrl);
  const resp = await fetch(proxyURL, { method: req.method });

  if (!resp.ok) {
    return errorResponse(`Proxy returned ${resp.status}`, resp.status);
  }

  const ct = resp.headers.get('content-type') || '';

  if (ct.includes('text/html')) {
    const html = await resp.text();
    const transformed = transformHTML(html, activeTarget, self.location.origin);
    return new Response(transformed, {
      status: resp.status,
      statusText: resp.statusText,
      headers: sanitizeHeaders(resp.headers)
    });
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: sanitizeHeaders(resp.headers)
  });
}

// ==========================
// HTML Transformation
// ==========================
function transformHTML(html, targetUrl, origin) {
  let t;
  try { t = new URL(targetUrl); } catch(e) { return html; }

  const proxyRoot = origin + '/proxy?url=';
  const targetOrigin = t.origin;

  const toProxy = (u) => {
    if (u.startsWith('http')) return proxyRoot + encodeURIComponent(u);
    if (u.startsWith('//')) return proxyRoot + encodeURIComponent('https:' + u);
    if (u.startsWith('/')) return proxyRoot + encodeURIComponent(targetOrigin + u);
    if (u.startsWith('#') || u.startsWith('javascript:') || u.startsWith('mailto:')) return u;
    return proxyRoot + encodeURIComponent(resolveURL(u, targetUrl));
  };

  let out = html;
  out = out.replace(/href="([^"]*)"/g, (m, u) => `href="${toProxy(u)}"`);
  out = out.replace(/href='([^']*)'/g, (m, u) => `href="${toProxy(u)}"`);
  out = out.replace(/src="([^"]*)"/g, (m, u) => `src="${toProxy(u)}"`);
  out = out.replace(/src='([^']*)'/g, (m, u) => `src="${toProxy(u)}"`);
  out = out.replace(/action="([^"]*)"/g, (m, u) => `action="${toProxy(u)}"`);
  out = out.replace(/url\((['"]?)([^'"\)]+)\1\)/g, (m, q, u) => `url(${toProxy(u)})`);

  const runtime = `<script>
(function(){
  var base='${targetOrigin}', proxy='${proxyRoot}';
  var origFetch=window.fetch;
  window.fetch=function(input,init){
    var url=(typeof input==='string')?input:(input.url||input.toString());
    if(url.startsWith('http')&&!url.includes(location.origin)){
      url=proxy+encodeURIComponent(url);
    } else if(url.startsWith('/')&&!url.startsWith('/proxy')){
      url=proxy+encodeURIComponent(base+url);
    }
    return origFetch(url,init);
  };
  var origOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,url,a,u,p){
    if(url.startsWith('http')&&!url.includes(location.origin)){
      url=proxy+encodeURIComponent(url);
    } else if(url.startsWith('/')&&!url.startsWith('/proxy')){
      url=proxy+encodeURIComponent(base+url);
    }
    return origOpen.call(this,m,url,a,u,p);
  };
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(!a)return;
    var h=a.getAttribute('href');
    if(h&&!h.startsWith('javascript:')&&!h.startsWith('#')&&!h.startsWith('mailto:')){
      if(h.startsWith('http'))a.href=proxy+encodeURIComponent(h);
      else if(h.startsWith('/'))a.href=proxy+encodeURIComponent(base+h);
    }
  });
})();
</script>`;

  if (out.includes('</head>')) {
    out = out.replace('</head>', runtime + '</head>');
  } else if (out.includes('<body')) {
    out = out.replace('<body', runtime + '<body');
  } else {
    out = runtime + out;
  }

  return out;
}

function resolveURL(rel, base) {
  try {
    return new URL(rel, base).toString();
  } catch(e) {
    return base + (base.endsWith('/') ? '' : '/') + rel;
  }
}

function sanitizeHeaders(headers) {
  const safe = new Headers();
  const drop = ['set-cookie','content-security-policy','x-frame-options','strict-transport-security'];
  headers.forEach((v,k)=>{ if(!drop.includes(k.toLowerCase())) safe.set(k,v); });
  return safe;
}

function errorResponse(msg, status) {
  return new Response(
    `<html><head><meta charset="utf-8"><style>
     body{background:#0a0a0f;color:#ff4444;font-family:monospace;padding:30px;line-height:1.6}
     h1{color:#ff4444;border-bottom:1px solid #333;padding-bottom:10px}
     code{background:#1a1a2e;padding:2px 6px;border-radius:2px;color:#00ff88}
     .box{background:#111;padding:15px;border-radius:4px;margin-top:15px}
     .ok{color:#00ff88}
     </style></head><body>
     <h1>Neptune Proxy Error ${status}</h1>
     <div class="box">${msg}</div>
     <p class="ok" style="margin-top:20px">Strategy: ${activeStrategy || 'detecting...'}</p>
     </body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function broadcast(msg) {
  clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage(msg)));
}
