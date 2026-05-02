/**
 * project: neptune — Service Worker Kernel v0.2.1
 * Multi-strategy proxy with correct scope-based proxy detection.
 */

const SW_VERSION = '0.2.1';

let PROXY_BASE = null;
let activeTarget = null;
let activeStrategy = null;
let snapshotData = null;
let proxyAvailable = null;

// WebRTC state
let rtcPeer = null;
let rtcChannel = null;
let rtcReady = false;

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
      break;
    case 'WEBRTC_SIGNAL':
      handleRTCSignal(d);
      break;
  }
});

// ==========================
// Strategy Detection
// ==========================
async function detectStrategy() {
  // 1. Extension mode
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const test = await fetch('https://example.com', { method: 'HEAD', mode: 'no-cors' });
      return 'extension';
    }
  } catch (e) {}

  // 4. Local/Hosted proxy — detect from scope with ACTUAL fetch (not no-cors)
  if (!PROXY_BASE) {
    const scope = self.registration.scope;
    // Use scope directly (e.g. https://host.com/path/) + proxy?url=
    PROXY_BASE = scope.replace(/\/$/, '') + '/proxy?url=';
  }

  try {
    // Test proxy with a real fetch (not no-cors) so we can read the status
    const testUrl = PROXY_BASE + encodeURIComponent('https://example.com');
    const resp = await fetch(testUrl, { method: 'HEAD', cache: 'no-store' });
    if (resp.status >= 200 && resp.status < 500) {
      console.log('[SW] Proxy available at', PROXY_BASE);
      return 'local';
    }
  } catch (e) {
    console.log('[SW] Proxy not available:', e.message);
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

  // Determine strategies to try
  const strategies = activeStrategy && activeStrategy !== 'none'
    ? [activeStrategy]
    : ['extension', 'webrtc', 'local'];

  for (const strategy of strategies) {
    try {
      const resp = await tryStrategy(strategy, targetUrl, req);
      if (resp) return resp;
    } catch (e) {
      console.log(`[SW] Strategy ${strategy} failed:`, e.message);
    }
  }

  return errorResponse(
    buildErrorHtml(strategies, targetUrl),
    503
  );
}

function buildErrorHtml(strategies, targetUrl) {
  const isStaticHost = !PROXY_BASE || PROXY_BASE.includes('github') || PROXY_BASE.includes('jsdelivr');
  return `<div style="font-family:monospace;max-width:600px;margin:40px auto">
<h2 style="color:#ff4444">Neptune Proxy Error — No working strategy</h2>
<p><strong>Target:</strong> <code>${escapeHtml(targetUrl)}</code></p>
<p><strong>Tried:</strong> ${strategies.join(', ')}</p>
<hr style="border-color:#333">
<h3 style="color:#00ff88">How to fix:</h3>
${isStaticHost ? `<p style="color:#ffaa00">You're on a <strong>static host</strong> (${escapeHtml(location.host)}).<br>
The proxy endpoint <code>/proxy</code> doesn't exist here.</p>` : ''}
<ol style="line-height:1.8">
<li><strong>Local dev (recommended):</strong><br>
<code style="background:#1a1a2e;padding:4px 8px">python3 server.py</code><br>
Then open <code>http://localhost:8080/neptune.svg?url=${encodeURIComponent(targetUrl)}</code></li>
<li><strong>Browser Extension:</strong> Package as extension for <code>&lt;all_urls&gt;</code> permission (no proxy needed)</li>
<li><strong>Hosted proxy:</strong> Host <code>server.py</code> somewhere, then:<br>
<code style="background:#1a1a2e;padding:4px 8px">postMessage({type:'SET_PROXY', url:'https://your-proxy.com/proxy?url='})</code></li>
<li><strong>WebRTC:</strong> Connect to a peer node with internet access</li>
</ol>
</div>`;
}

async function tryStrategy(strategy, targetUrl, req) {
  switch (strategy) {
    case 'extension':
      return await fetch(targetUrl, { method: req.method });

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
// Local/Hosted Proxy Strategy
// ==========================
async function proxyFetch(targetUrl, req) {
  if (!PROXY_BASE) {
    const scope = self.registration.scope;
    PROXY_BASE = scope.replace(/\/$/, '') + '/proxy?url=';
  }

  const proxyURL = PROXY_BASE + encodeURIComponent(targetUrl);
  const resp = await fetch(proxyURL, { method: req.method });

  if (!resp.ok && resp.status !== 304) {
    return null; // Let error handler deal with it
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

  rtcChannel.addEventListener('close', () => { rtcReady = false; });

  console.log('[SW] WebRTC initialized');
}

function handleRTCSignal(data) {
  if (!rtcPeer) return;
  if (data.sdp) {
    rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(() => data.sdp.type === 'offer' ? rtcPeer.createAnswer() : null)
      .then(answer => answer ? rtcPeer.setLocalDescription(answer) : null)
      .then(() => broadcast({ type: 'WEBRTC_LOCAL_SDP', sdp: rtcPeer.localDescription }))
      .catch(e => console.error('[SW] RTC signal error:', e));
  }
  if (data.candidate) {
    rtcPeer.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(e => console.error('[SW] ICE error:', e));
  }
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
  try { return new URL(rel, base).toString(); }
  catch(e) { return base + (base.endsWith('/') ? '' : '/') + rel; }
}

function sanitizeHeaders(headers) {
  const safe = new Headers();
  const drop = ['set-cookie','content-security-policy','x-frame-options','strict-transport-security'];
  headers.forEach((v,k)=>{ if(!drop.includes(k.toLowerCase())) safe.set(k,v); });
  return safe;
}

function errorResponse(msg, status) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
     body{background:#0a0a0f;color:#ccc;font-family:monospace;padding:20px;line-height:1.6}
     h1{color:#ff4444;border-bottom:1px solid #333;padding-bottom:10px}
     code{background:#1a1a2e;padding:2px 6px;border-radius:2px;color:#00ff88}
     .box{background:#111;padding:15px;border-radius:4px;margin-top:15px;color:#ff4444}
     .ok{color:#00ff88}
     a{color:#00aa66}
     </style></head><body>
     <h1>Neptune Proxy Error ${status}</h1>
     <div class="box">${msg}</div>
     <p class="ok" style="margin-top:20px">Strategy: ${activeStrategy || 'detecting...'}</p>
     <p>Proxy base: <code>${escapeHtml(PROXY_BASE || 'not set')}</code></p>
     </body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function broadcast(msg) {
  clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage(msg)));
}
