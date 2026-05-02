/**
 * project: neptune — Service Worker Kernel
 * No external URLs. All proxying routes through the local dev server.
 */

const SW_VERSION = '0.1.0';
const PROXY_BASE = (() => {
  // Detect proxy endpoint from registration scope
  const s = new URL(self.registration.scope);
  return `${s.protocol}//${s.host}/proxy?url=`;
})();

let activeTarget = null;
let wasmReady = false;

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
      console.log('[SW] Target:', activeTarget);
      broadcast({ type: 'TARGET_SET', url: activeTarget });
      break;
    case 'WASM_READY': wasmReady = true; break;
  }
});

// ==========================
// Fetch Interception
// ==========================
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept our own assets or the proxy endpoint
  const skip = ['neptune.svg','sw.js','neptune_kernel.js','neptune_kernel_bg.wasm','server.py','build.py'];
  if (skip.some(s => url.pathname.endsWith(s))) return;
  if (url.pathname === '/proxy') return;

  // Proxy mode: intercept requests for the target domain or relative paths
  if (activeTarget && shouldIntercept(url, e.request)) {
    e.respondWith(proxyRequest(e.request, url));
  }
});

function shouldIntercept(url, req) {
  // Intercept if we're inside the proxy iframe (has __nptn param)
  // or if the request is for a path that should be proxied
  const ref = req.referrer ? new URL(req.referrer) : null;
  if (ref && ref.searchParams.has('__nptn')) return true;
  // Also intercept relative requests when target is set
  if (activeTarget && url.origin === self.location.origin) return true;
  return false;
}

async function proxyRequest(req, url) {
  let targetUrl;

  if (url.searchParams.has('__nptn')) {
    // This is the iframe root load - fetch the actual target
    const t = url.searchParams.get('url') || activeTarget;
    targetUrl = t;
  } else if (url.origin === self.location.origin) {
    // Relative request - resolve against target
    const rel = url.pathname + url.search;
    targetUrl = resolveURL(rel, activeTarget);
  } else {
    return fetch(req);
  }

  if (!targetUrl) {
    return errorResponse('No target configured', 400);
  }

  try {
    const proxyURL = PROXY_BASE + encodeURIComponent(targetUrl);
    const resp = await fetch(proxyURL, { method: req.method });

    if (!resp.ok) {
      return errorResponse(`Proxy returned ${resp.status} for ${targetUrl}`, resp.status);
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

    // Pass through non-HTML with sanitized headers
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: sanitizeHeaders(resp.headers)
    });

  } catch (err) {
    console.error('[SW] Proxy error:', err);
    return errorResponse(err.message, 502);
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

  let out = html;

  // Helper: proxy any URL
  const toProxy = (u) => {
    if (u.startsWith('http')) return proxyRoot + encodeURIComponent(u);
    if (u.startsWith('//')) return proxyRoot + encodeURIComponent('https:' + u);
    if (u.startsWith('/')) return proxyRoot + encodeURIComponent(targetOrigin + u);
    if (u.startsWith('#') || u.startsWith('javascript:')) return u;
    return proxyRoot + encodeURIComponent(resolveURL(u, targetUrl));
  };

  // Rewrite href attributes
  out = out.replace(/href="([^"]*)"/g, (m, u) => `href="${toProxy(u)}"`);
  out = out.replace(/href='([^']*)'/g, (m, u) => `href="${toProxy(u)}"`);

  // Rewrite src attributes
  out = out.replace(/src="([^"]*)"/g, (m, u) => `src="${toProxy(u)}"`);
  out = out.replace(/src='([^']*)'/g, (m, u) => `src="${toProxy(u)}"`);

  // Rewrite action attributes (forms)
  out = out.replace(/action="([^"]*)"/g, (m, u) => `action="${toProxy(u)}"`);

  // Rewrite CSS url()
  out = out.replace(/url\((['"]?)([^'"\)]+)\1\)/g, (m, q, u) => `url(${toProxy(u)})`);

  // Inject runtime script to intercept dynamic requests
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
    if(h&&!h.startsWith('javascript:')&&!h.startsWith('#')){
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
    `<html><body style="background:#0a0a0f;color:#ff4444;font-family:monospace;padding:20px;">
     <h1>Neptune Proxy Error ${status}</h1><pre>${msg}</pre></body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  );
}

function broadcast(msg) {
  clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage(msg)));
}
