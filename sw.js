/**
 * project: neptune — Service Worker Kernel v2.0.0
 * Fully standalone browser proxy. Zero external servers. Zero extensions.
 *
 * Architecture: The ServiceWorker intercepts navigation requests to same-origin
 * proxy URLs. It fetches the real cross-origin target, reads the response body
 * (SWs are trusted — they bypass CORS for navigation responses), rewrites HTML
 * to prefix all resource URLs, and returns the rewritten content.
 *
 * For subresources (CSS, JS, images), the SW fetches the real URL and passes
 * the response through. Opaque responses work for images/scripts; CSS may need
 * CORS headers from the target origin for full URL rewriting.
 *
 * Fallback: iframe visual proxy for sites that can't be fetched.
 */

const SW_VERSION = '2.0.0';

// Scope-relative proxy path computed from SW's own location.
// Works on any CDN path (e.g., /gh/user/repo@main/proxy or /proxy).
const PROXY_PATH = self.location.pathname.replace(/\/[^/]*$/, '') + '/proxy';
const PROXY_ROOT = self.location.origin + PROXY_PATH + '?url=';

// ── Core State ──────────────────────────────────────────
let activeTarget   = null;
let activeStrategy = null;
let corsFriendly   = false;

// ── Config (mutable via postMessage) ───────────────────
const swConfig = {
  userAgent:          null,
  customHeaders:      {},
  cookiesEnabled:     true,
  trackerBlocking:    true,
  cacheEnabled:       true,
  maxCacheAge:        86400000,
  urlWhitelist:       [],
  urlBlacklist:       [],
  injectBridge:       true,
  fingerprintCode:    null,  // Injected fingerprint randomization engine
  stripTrackers:      true,
  darkMode:           false,
};

// ── Cookie jar: domain → [{name,value,path,expires}] ──
const cookieJar = new Map();

// ── Request log (capped) ───────────────────────────────
const requestLog = [];
const MAX_LOG    = 500;

// ── Stats ──────────────────────────────────────────────
let totalBytes    = 0;
let totalRequests = 0;
let blockedCount  = 0;
let startTime     = Date.now();

// ── Cache ───────────────────────────────────────────────
const CACHE_NAME = 'neptune-v2';

// ── Known tracker patterns ─────────────────────────────
const TRACKER_PATTERNS = [
  'google-analytics','googletagmanager','doubleclick','googleadservices',
  'facebook.com/tr','fbcdn.net','connect.facebook.net',
  'twitter.com/i/ads','analytics.twitter.com',
  'mixpanel','amplitude.com','segment.io','segment.com',
  'hotjar','clarity.ms','gtag','google.tag',
  'tracker','pixel','beacon','telemetry',
  'optimizely','crazyegg','mouseflow','fullstory',
  ' quantserve','scorecardresearch','moatads',
  'outbrain','taboola','sharethrough',
  'adsystem','adnxs','adsrvr','advertising',
  'outbrain','taboola','revcontent',
];

// ════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════
self.addEventListener('install', e => {
  console.log('[SW] Installing v' + SW_VERSION);
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  console.log('[SW] Activated v' + SW_VERSION);
  e.waitUntil(
    Promise.all([
      clients.claim(),
      caches.open(CACHE_NAME),
    ])
  );
});

// ════════════════════════════════════════════════════════
// Message API
// ════════════════════════════════════════════════════════
self.addEventListener('message', e => {
  const d = e.data;
  if (!d || !d.type) return;
  const src = e.source;

  switch (d.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'SET_TARGET':
      activeTarget = d.url;
      console.log('[SW] Target:', activeTarget);
      detectStrategy(activeTarget).then(s => {
        activeStrategy = s.strategy;
        corsFriendly   = s.cors || false;
        broadcast({
          type: 'STRATEGY_SELECTED',
          strategy: activeStrategy,
          cors: corsFriendly,
          timing: s.timing || 0,
        });
      });
      broadcast({ type: 'TARGET_SET', url: activeTarget });
      break;

    case 'SET_STRATEGY':
      activeStrategy = d.strategy;
      console.log('[SW] Strategy set:', d.strategy);
      break;

    case 'SET_CONFIG':
      if (d.userAgent !== undefined)        swConfig.userAgent        = d.userAgent;
      if (d.customHeaders)                    Object.assign(swConfig.customHeaders, d.customHeaders);
      if (d.cookiesEnabled !== undefined)     swConfig.cookiesEnabled   = d.cookiesEnabled;
      if (d.trackerBlocking !== undefined)    swConfig.trackerBlocking  = d.trackerBlocking;
      if (d.cacheEnabled !== undefined)       swConfig.cacheEnabled     = d.cacheEnabled;
      if (d.maxCacheAge !== undefined)       swConfig.maxCacheAge      = d.maxCacheAge;
      if (d.urlWhitelist)                     swConfig.urlWhitelist     = d.urlWhitelist;
      if (d.urlBlacklist)                     swConfig.urlBlacklist     = d.urlBlacklist;
      if (d.injectBridge !== undefined)       swConfig.injectBridge     = d.injectBridge;
      if (d.fingerprintCode !== undefined)       swConfig.fingerprintCode  = d.fingerprintCode;
      if (d.stripTrackers !== undefined)      swConfig.stripTrackers    = d.stripTrackers;
      if (d.darkMode !== undefined)           swConfig.darkMode         = d.darkMode;
      if (src) src.postMessage({ type: 'CONFIG_ACK', config: swConfig });
      else broadcast({ type: 'CONFIG_ACK', config: swConfig });
      break;

    case 'GET_CONFIG':
      if (src) src.postMessage({ type: 'CONFIG_DATA', config: swConfig });
      break;

    case 'GET_LOG':
      if (src) src.postMessage({ type: 'LOG_DATA', entries: requestLog.slice(0, d.limit || 100) });
      break;

    case 'CLEAR_LOG':
      requestLog.length = 0;
      totalBytes = 0;
      totalRequests = 0;
      blockedCount = 0;
      broadcast({ type: 'LOG_CLEARED' });
      break;

    case 'CLEAR_CACHE':
      caches.delete(CACHE_NAME).then(() => {
        caches.open(CACHE_NAME);
        broadcast({ type: 'CACHE_CLEARED' });
      });
      break;

    case 'GET_STATS':
      if (src) src.postMessage({
        type: 'STATS_DATA',
        totalBytes,
        totalRequests,
        blockedCount,
        uptime: Date.now() - startTime,
        activeTarget,
        activeStrategy,
        corsFriendly,
        logSize: requestLog.length,
        cacheName: CACHE_NAME,
      });
      break;

    case 'PURGE_COOKIES':
      cookieJar.clear();
      broadcast({ type: 'COOKIES_PURGED' });
      break;

    // ── Network Adapter Bridge ──────────────────────────
    case 'NET_ADAPT_CONNECT':
      handleNetAdaptConnect(d, src).catch(e => {
        console.error('[SW] NET_ADAPT_CONNECT error:', e.message);
      });
      break;

    case 'NET_ADAPT_DATA':
      handleNetAdaptData(d, src).catch(e => {
        console.error('[SW] NET_ADAPT_DATA error:', e.message);
        if (src) src.postMessage({
          type: 'NET_ADAPT_ERROR',
          localPort: d.localPort,
          error: e.message,
        });
      });
      break;

    case 'NET_ADAPT_CLOSE':
      handleNetAdaptClose(d, src);
      break;
  }
});

// ════════════════════════════════════════════════════════
// Strategy Detection
// ════════════════════════════════════════════════════════
async function detectStrategy(targetUrl) {
  // ServiceWorkers can fetch cross-origin without CORS restrictions
  // when responding to navigation events. Try a direct fetch first.
  const start = performance.now();
  try {
    const resp = await fetch(targetUrl, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
    });
    const timing = Math.round(performance.now() - start);
    // If we can read the response (not opaque), CORS is friendly
    if (resp.type !== 'opaque' && resp.type !== 'error') {
      return { strategy: 'cors', cors: true, timing };
    }
  } catch (e) {}

  // Try GET to check if we can read the body
  try {
    const start2 = performance.now();
    const resp = await fetch(targetUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
    });
    await resp.text();
    const timing = Math.round(performance.now() - start2);
    return { strategy: 'cors', cors: true, timing };
  } catch (e) {}

  return { strategy: 'iframe', cors: false };
}

// ════════════════════════════════════════════════════════
// Fetch Interception
// ════════════════════════════════════════════════════════
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Proxy-mode detection:
  //   __nptn → iframe navigation created by loadTabContent (always proxy)
  //   url param on /proxy path → subresource proxying (always proxy)
  //   url param WITHOUT __nptn on neptune.svg → INITIAL SVG LOAD, do NOT intercept
  const isProxyNav = url.searchParams.has('__nptn');
  const isProxySub = url.pathname === PROXY_PATH && url.searchParams.has('url');
  const isProxyRequest = isProxyNav || isProxySub;

  if (!isProxyRequest) {
    const skip = ['neptune.svg','template.svg','sw.js','server.py','build.py','index.html'];
    if (skip.some(s => url.pathname.endsWith(s))) return;
    if (url.pathname === PROXY_PATH) return;
  }

  // Allow proxy requests even without activeTarget — proxy params are self-contained
  if (!activeTarget && !isProxyRequest) return;
  if (!shouldIntercept(url, e.request)) return;

  // URL filtering
  const targetStr = url.toString();
  if (!checkUrlFilter(targetStr)) {
    blockedCount++;
    e.respondWith(blockedResponse(targetStr));
    logRequest({
      url: targetStr, method: e.request.method, status: 403,
      type: 'filter', size: 0, duration: 0, strategy: 'blocked',
      error: 'URL blocked by filter',
    });
    return;
  }

  // Tracker blocking for subresources
  if (swConfig.trackerBlocking && isTrackerUrl(targetStr)) {
    blockedCount++;
    e.respondWith(trackerBlockResponse(e.request.destination));
    logRequest({
      url: targetStr, method: e.request.method, status: 200,
      type: 'tracker-blocked', size: 0, duration: 0, strategy: 'block',
      error: 'Tracker blocked',
    });
    return;
  }

  e.respondWith(handleProxy(e.request, url));
});

function shouldIntercept(url, req) {
  // Proxy-mode: __nptn (iframe nav) or proxy?url= (subresource) always pass.
  // url param WITHOUT __nptn on neptune.svg is the INITIAL SVG LOAD — skip it.
  if (url.searchParams.has('__nptn')) return true;
  if (url.pathname === PROXY_PATH && url.searchParams.has('url')) return true;

  const localAssets = ['/neptune.svg','/template.svg','/sw.js','/server.py','/build.py','/index.html'];
  if (localAssets.some(a => url.pathname === a || url.pathname.endsWith(a))) return false;
  const ref = req.referrer ? new URL(req.referrer) : null;
  if (ref && ref.searchParams.has('__nptn')) return true;
  if (url.origin === self.location.origin) return true;
  return false;
}

function checkUrlFilter(url) {
  if (swConfig.urlBlacklist.length > 0) {
    for (const p of swConfig.urlBlacklist) { if (url.includes(p)) return false; }
  }
  if (swConfig.urlWhitelist.length > 0) {
    for (const p of swConfig.urlWhitelist) { if (url.includes(p)) return true; }
    return false;
  }
  return true;
}

function isTrackerUrl(url) {
  const lower = url.toLowerCase();
  for (const p of TRACKER_PATTERNS) {
    if (lower.includes(p)) return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════
// Main Proxy Handler
// ════════════════════════════════════════════════════════
async function handleProxy(req, url) {
  const startTime = performance.now();
  let targetUrl;

  // Parse proxy URL
  if (url.searchParams.has('__nptn') || url.searchParams.has('url') || url.searchParams.has('')) {
    targetUrl = url.searchParams.get('url') || url.searchParams.get('') || activeTarget;
  } else if (url.origin === self.location.origin) {
    const rel = url.pathname + url.search;
    targetUrl = resolveURL(rel, activeTarget);
  } else {
    return fetch(req);
  }

  if (!targetUrl) {
    return errorResponse('No target configured', 400);
  }

  // Build request headers
  const reqHeaders = new Headers(req.headers);
  if (swConfig.userAgent) {
    reqHeaders.set('User-Agent', swConfig.userAgent);
  }
  for (const [k, v] of Object.entries(swConfig.customHeaders)) {
    reqHeaders.set(k, v);
  }

  // Inject cookies
  if (swConfig.cookiesEnabled) {
    try {
      const domain = new URL(targetUrl).hostname;
      const cookies = cookieJar.get(domain);
      if (cookies && cookies.length > 0) {
        const valid = cookies.filter(c => !c.expires || c.expires > Date.now());
        if (valid.length > 0) {
          reqHeaders.set('Cookie', valid.map(c => c.name + '=' + c.value).join('; '));
        }
      }
    } catch (e) {}
  }

  // Check cache
  if (swConfig.cacheEnabled && req.method === 'GET') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) {
        const cachedTime = parseInt(cached.headers.get('x-neptune-cached') || '0');
        if (Date.now() - cachedTime < swConfig.maxCacheAge) {
          logRequest({
            url: url.toString(), method: req.method, status: cached.status,
            type: cached.headers.get('content-type') || 'unknown',
            size: 0, duration: Math.round(performance.now() - startTime),
            strategy: 'cache', fromCache: true,
          });
          return cached;
        }
      }
    } catch (e) {}
  }

  // Strategy selection
  const isDocument = req.destination === 'document' || req.destination === 'iframe';
  const strategies = activeStrategy && activeStrategy !== 'none'
    ? [activeStrategy]
    : (isDocument ? ['cors', 'iframe'] : ['cors', 'opaque']);

  let lastError;
  for (const strategy of strategies) {
    try {
      const resp = await tryStrategy(strategy, targetUrl, req, reqHeaders, isDocument);
      if (resp) {
        const duration = Math.round(performance.now() - startTime);
        const size = parseInt(resp.headers.get('content-length')) || 0;
        totalBytes += size;
        totalRequests++;

        // Store cookies from response
      // Note: Standard Fetch API in Service Workers cannot read Set-Cookie headers
      // (forbidden response-header name). We attempt CookieStore API where available.
      if (swConfig.cookiesEnabled) {
        try {
          const setCookie = resp.headers.get('set-cookie');
          if (setCookie) storeCookie(targetUrl, setCookie);
        } catch(e) {}
        // Fallback: CookieStore API (Chrome experimental)
        if (typeof self.cookieStore !== 'undefined' && self.cookieStore.getAll) {
          try {
            const domain = new URL(targetUrl).hostname;
            const all = await self.cookieStore.getAll({ domain });
            for (const c of all) {
              storeCookie(targetUrl, `${c.name}=${c.value}; domain=${domain}`);
            }
          } catch(e) {}
        }
      }

        // Cache successful GETs
        if (swConfig.cacheEnabled && req.method === 'GET' && resp.ok) {
          try {
            const cache = await caches.open(CACHE_NAME);
            const clone = resp.clone();
            const h = new Headers(clone.headers);
            h.set('x-neptune-cached', Date.now().toString());
            cache.put(req, new Response(clone.body, {
              status: clone.status, statusText: clone.statusText, headers: h,
            }));
          } catch (e) {}
        }

        // Download detection
        const cd = resp.headers.get('content-disposition');
        if (cd && cd.includes('attachment')) {
          broadcast({
            type: 'DOWNLOAD_DETECTED',
            url: targetUrl,
            filename: parseFilename(cd, url.pathname),
            size: size,
            mime: resp.headers.get('content-type') || 'application/octet-stream',
          });
        }

        logRequest({
          url: url.toString(), method: req.method, status: resp.status,
          type: resp.headers.get('content-type') || 'unknown',
          size, duration, strategy, fromCache: false,
        });

        return resp;
      }
    } catch (e) {
      lastError = e;
      console.log(`[SW] Strategy ${strategy} failed:`, e.message);
    }
  }

  // All failed
  const duration = Math.round(performance.now() - startTime);
  logRequest({
    url: url.toString(), method: req.method, status: 0,
    type: 'error', size: 0, duration,
    strategy: 'all-failed', error: lastError ? lastError.message : 'Unknown',
  });

  return errorResponse(
    buildErrorHtml(strategies, targetUrl, lastError),
    503
  );
}

function parseFilename(cd, fallback) {
  const m = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (m) return m[1].replace(/['"]/g, '');
  const parts = fallback.split('/');
  return parts[parts.length - 1] || 'download';
}

// ════════════════════════════════════════════════════════
// Cookie Storage
// ════════════════════════════════════════════════════════
function storeCookie(targetUrl, setCookieHeader) {
  try {
    const domain = new URL(targetUrl).hostname;
    if (!cookieJar.has(domain)) cookieJar.set(domain, []);
    const jar = cookieJar.get(domain);

    // Set-Cookie may contain commas in Expires dates (e.g., "Wed, 21 Oct 2025...").
    // The Fetch API in SW may join multiple headers with ", ".
    // We use a simple state-machine parser that splits only on unquoted semicolons.
    const cookies = parseSetCookieHeader(setCookieHeader);
    for (const ck of cookies) {
      if (!ck.name) continue;
      let expires = null;
      for (const attr of ck.attrs) {
        const low = attr.toLowerCase().trim();
        if (low.startsWith('expires=')) {
          try { expires = new Date(attr.slice(8)).getTime(); } catch(e) {}
        } else if (low.startsWith('max-age=')) {
          const sec = parseInt(attr.slice(8));
          if (!isNaN(sec)) expires = Date.now() + sec * 1000;
        }
      }
      jar.push({
        name: ck.name.trim(),
        value: ck.value || '',
        path: '',
        expires,
      });
    }
  } catch (e) {}
}

// Parse a possibly-combined Set-Cookie value.
// Splits on commas that are NOT inside a date value (which always follows "Expires=").
function parseSetCookieHeader(header) {
  const cookies = [];
  let current = '';
  let inExpiresDate = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    const rest = header.slice(i);
    if (!inExpiresDate && rest.toLowerCase().startsWith('expires=')) {
      inExpiresDate = true;
    }
    if (ch === ',' && !inExpiresDate) {
      // Commit current cookie
      const parsed = parseSingleCookie(current);
      if (parsed) cookies.push(parsed);
      current = '';
      continue;
    }
    if (inExpiresDate && (ch === ';' || i === header.length - 1)) {
      inExpiresDate = false;
    }
    current += ch;
  }
  if (current.trim()) {
    const parsed = parseSingleCookie(current);
    if (parsed) cookies.push(parsed);
  }
  return cookies;
}

function parseSingleCookie(str) {
  str = str.trim();
  if (!str) return null;
  const parts = str.split(';').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nv = parts[0];
  const eq = nv.indexOf('=');
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  return { name, value, attrs: parts.slice(1) };
}

// ════════════════════════════════════════════════════════
// Request Logger
// ════════════════════════════════════════════════════════
function logRequest(entry) {
  entry.timestamp = Date.now();
  requestLog.unshift(entry);
  if (requestLog.length > MAX_LOG) requestLog.pop();
  broadcast({ type: 'REQUEST_LOG_ENTRY', entry });
}

// ════════════════════════════════════════════════════════
// Strategy Implementations
// ════════════════════════════════════════════════════════
async function tryStrategy(strategy, targetUrl, req, reqHeaders, isDocument) {
  switch (strategy) {
    case 'cors':  return await corsFetch(targetUrl, req, reqHeaders, isDocument);
    case 'iframe':return await iframeDirectFetch(targetUrl);
    case 'opaque':return await opaqueFetch(targetUrl, req, reqHeaders);
    default:      return null;
  }
}

async function corsFetch(targetUrl, req, reqHeaders, isDocument) {
  // The ServiceWorker intercepts same-origin navigation requests and fetches
  // the real cross-origin target on behalf of the page. For navigation:
  // opaque responses CAN be passed to respondWith() but their body is
  // unreadable — we fall back to iframe mode. For subresources: opaque
  // responses still work for rendering (images, scripts, styles) even
  // though the JS-level body is null (the browser reads bytes at the
  // network layer for rendering, just not for JS access).
  const init = {
    method: req.method,
    redirect: 'follow',
    cache: 'no-store',
    headers: reqHeaders,
  };

  // Forward body for non-GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  // Phase 6: Light timing jitter for CORS direct fetch (0–50ms)
  await new Promise(r => setTimeout(r, Math.floor(Math.pow(Math.random(), 2) * 50)));

  const resp = await fetch(targetUrl, init);

  // Network errors (type 'error') or failed requests (status 0) — fall back.
  // Opaque responses (status 0, type 'opaque') are valid — the browser
  // rendering engine can still use them for images, scripts, and styles.
  if (!resp || resp.type === 'error' || (resp.status === 0 && resp.type !== 'opaque')) {
    return null;
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();

  // HTML → full rewrite if body is readable
  if (ct.includes('text/html') && resp.type !== 'opaque') {
    try {
      const html = await resp.text();
      const transformed = transformHTML(html, targetUrl, self.location.origin, swConfig);
      return new Response(transformed, {
        status: resp.status,
        statusText: resp.statusText,
        headers: sanitizeHeaders(resp.headers),
      });
    } catch (e) {
      // Body not readable (opaque) — fall through to passthrough
    }
  }

  // Opaque HTML can't be read — fall through to iframe visual proxy.
  // We check both Content-Type AND the request destination because some
  // browsers may filter Content-Type on opaque responses.
  if (resp.type === 'opaque' && (ct.includes('text/html') || isDocument)) {
    return null;
  }

  // Non-HTML → pass the original response through directly.
  // Opaque images/scripts/styles still work because the browser reads
  // bytes at the network layer for rendering (just not from JS).
  return resp;
}

async function opaqueFetch(targetUrl, req, reqHeaders) {
  try {
    const init = {
      method: req.method,
      mode: 'no-cors',
      redirect: 'follow',
      cache: 'no-store',
      headers: reqHeaders,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.arrayBuffer();
    }

    // Phase 6: Light timing jitter for opaque fallback traffic (0–100ms)
    await new Promise(r => setTimeout(r, Math.floor(Math.pow(Math.random(), 2) * 100)));

    const resp = await fetch(targetUrl, init);
    return resp;
  } catch (e) {
    console.log('[SW] Opaque fetch failed:', e.message);
    return null;
  }
}

async function iframeDirectFetch(targetUrl) {
  const html = buildIframeWrapper(targetUrl);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function buildIframeWrapper(targetUrl) {
  const esc = escapeHtml;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neptune — ${esc(targetUrl)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0a0a0f;font-family:'SF Mono','Fira Code',monospace,monospace;color:#00ff88}
#chrome{flex:0 0 auto;background:#111;border-bottom:1px solid #1a1a2e;padding:6px 12px;font-size:11px;display:flex;align-items:center;gap:10px;min-height:36px}
#chrome .badge{background:#1a3a2e;color:#00ff88;padding:2px 8px;border-radius:3px;font-size:10px;border:1px solid #004d33}
#chrome .url{color:#ccc;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
#chrome .url a{color:#00aa66;text-decoration:none}
#chrome .url a:hover{color:#00ff88;text-decoration:underline}
#chrome .hint{color:#555;font-size:10px}
#chrome .btn{background:#1a1a2e;border:1px solid #333;color:#00ff88;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:10px;font-family:inherit;transition:all .15s}
#chrome .btn:hover{background:#222;border-color:#00ff88}
#chrome .btn:disabled{opacity:.4;cursor:not-allowed}
#viewport{flex:1 1 auto;position:relative;overflow:hidden;display:flex;flex-direction:column}
iframe{width:100%;height:100%;border:none;background:#fff}
#blockmsg{display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:#0a0a0f;z-index:10;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:40px}
#blockmsg h3{color:#ff4444;margin-bottom:12px;font-size:16px}
#blockmsg p{color:#888;max-width:420px;line-height:1.6;margin-bottom:12px;font-size:12px}
#blockmsg a{color:#00aa66;text-decoration:none}
#blockmsg a:hover{color:#00ff88;text-decoration:underline}
#blockmsg code{background:#1a1a2e;padding:2px 6px;border-radius:2px;color:#00ff88;font-size:11px}
#status{display:flex;align-items:center;padding:4px 12px;background:#0f0f1a;border-top:1px solid #1a1a2e;font-size:10px;color:#555;gap:12px}
#status .ok{color:#00ff88}
#status .warn{color:#ffaa00}
</style></head>
<body style="display:flex;flex-direction:column;height:100vh">
<div id="chrome">
  <span class="badge">IFRAME</span>
  <span class="url" title="${esc(targetUrl)}"><a href="${esc(targetUrl)}" target="_blank">${esc(targetUrl)}</a></span>
  <span class="hint">visual proxy — standalone SW kernel</span>
  <button class="btn" onclick="history.back()" title="Back">← Back</button>
  <button class="btn" onclick="history.forward()" title="Forward">→ Forward</button>
  <button class="btn" onclick="reloadFrame()" title="Reload">↻ Reload</button>
</div>
<div id="viewport">
  <div id="blockmsg">
    <h3>⚠ Site blocked framing</h3>
    <p>This site sent <code>X-Frame-Options</code> or <code>Content-Security-Policy: frame-ancestors</code> headers that prevent it from being displayed in an iframe.</p>
    <p><a href="${esc(targetUrl)}" target="_blank">Open site directly in new tab →</a></p>
    <p style="margin-top:8px;color:#555">Some sites work with the direct fetch strategy instead. Try reloading.</p>
  </div>
  <iframe id="frame" src="${esc(targetUrl)}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-top-navigation allow-downloads allow-modals" allow="fullscreen; geolocation; microphone; camera; autoplay; display-capture"></iframe>
</div>
<div id="status">
  <span class="ok">● Connected</span>
  <span>Strategy: iframe visual</span>
  <span id="load-status">Loading...</span>
</div>
<script>
(function(){
  var frame = document.getElementById('frame');
  var blockmsg = document.getElementById('blockmsg');
  var loadStatus = document.getElementById('load-status');
  var hasContent = false;
  var loadTimer;

  function reloadFrame(){
    frame.src = frame.src;
    hasContent = false;
    loadStatus.textContent = 'Loading...';
    loadStatus.className = '';
    blockmsg.style.display = 'none';
    clearTimeout(loadTimer);
    loadTimer = setTimeout(checkBlocked, 8000);
  }
  window.reloadFrame = reloadFrame;

  frame.addEventListener('load', function(){
    clearTimeout(loadTimer);
    try {
      var d = frame.contentDocument;
      if (d && d.body && d.body.innerHTML.length > 0) {
        hasContent = true;
        loadStatus.textContent = 'Loaded';
        loadStatus.className = 'ok';
      }
    } catch(e) {
      hasContent = true;
      loadStatus.textContent = 'Loaded (cross-origin)';
      loadStatus.className = 'ok';
    }
  });

  function checkBlocked(){
    if (!hasContent) {
      blockmsg.style.display = 'flex';
      loadStatus.textContent = 'Blocked';
      loadStatus.className = 'warn';
    }
  }

  loadTimer = setTimeout(checkBlocked, 8000);
})();
</script>
</body></html>`;
}

// ════════════════════════════════════════════════════════
// HTML Transformation (CORS mode)
// ════════════════════════════════════════════════════════
function transformHTML(html, targetUrl, origin, cfg) {
  let t;
  try { t = new URL(targetUrl); } catch(e) { return html; }

  // Use SW's own location to compute proxy path (works with any CDN path)
  const proxyRoot = PROXY_ROOT;
  const targetOrigin = t.origin;

  const toProxy = (u) => {
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
    // Already rewritten — don't double-wrap
    if (u.startsWith(proxyRoot)) return u;
    if (u.startsWith('http://') || u.startsWith('https://')) return proxyRoot + encodeURIComponent(u);
    if (u.startsWith('//')) return proxyRoot + encodeURIComponent('https:' + u);
    if (u.startsWith('/')) return proxyRoot + encodeURIComponent(targetOrigin + u);
    if (u.startsWith('#') || u.startsWith('javascript:') || u.startsWith('mailto:') || u.startsWith('tel:')) return u;
    return proxyRoot + encodeURIComponent(resolveURL(u, targetUrl));
  };

  let out = html;

  // Inject fingerprint randomization engine (before any page scripts)
  if (cfg.fingerprintCode && cfg.fingerprintCode.length > 0) {
    const fpScript = '<script id="__nptn_fingerprint">' + cfg.fingerprintCode + '</script>';
    if (out.includes('<head>')) {
      out = out.replace('<head>', '<head>' + fpScript);
    } else if (out.includes('<html>')) {
      out = out.replace('<html>', '<html><head>' + fpScript + '</head>');
    } else {
      out = fpScript + out;
    }
  }

  // Strip tracker scripts
  if (cfg.stripTrackers) {
    // External tracker scripts by src URL pattern
    out = out.replace(/<script[^>]*src=["']([^"']*(?:google-analytics|gtag|googletagmanager|doubleclick|facebook\.com\/tr|mixpanel|amplitude|segment|hotjar|clarity\.ms|tracker|pixel|beacon|telemetry)[^"']*)["'][^>]*><\/script>/gi, '<!-- neptune: tracker blocked -->');
    // Inline tracker scripts — only strip if they contain analytics initialization code
    out = out.replace(/<script[^>]*>\s*(?:[\s\S]*?(?:gtag\s*\(|ga\s*\(\s*['"]create['"]\s*,|GoogleAnalyticsObject|analytics\.load|mixpanel\.init|amplitude\.init|clarity\s*\(|hj\s*\())\s*[\s\S]*?<\/script>/gi, '<!-- neptune: inline tracker blocked -->');
    // Tracking pixels / beacons
    out = out.replace(/<img[^>]*src=["']([^"']*(?:pixel|beacon|tracker|analytics)[^"']*)["'][^>]*\/?>/gi, '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="" />');
    // Google Tag Manager noscript iframe
    out = out.replace(/<noscript>\s*<iframe[^>]*src=["']https?:\/\/www\.googletagmanager\.com[^"']*["'][^>]*><\/iframe>\s*<\/noscript>/gi, '<!-- neptune: GTM noscript blocked -->');
  }

  // Rewrite URLs
  out = out.replace(/href="([^"]*)"/gi, (m, u) => `href="${toProxy(u)}"`);
  out = out.replace(/href='([^']*)'/gi, (m, u) => `href="${toProxy(u)}"`);
  out = out.replace(/src="([^"]*)"/gi, (m, u) => `src="${toProxy(u)}"`);
  out = out.replace(/src='([^']*)'/gi, (m, u) => `src="${toProxy(u)}"`);
  out = out.replace(/action="([^"]*)"/gi, (m, u) => `action="${toProxy(u)}"`);
  out = out.replace(/action='([^']*)'/gi, (m, u) => `action="${toProxy(u)}"`);
  out = out.replace(/url\((['"]?)([^'"\)]+)\1\)/gi, (m, q, u) => `url("${toProxy(u)}")`);

  // Rewrite srcset (responsive images)
  out = out.replace(/srcset="([^"]*)"/gi, (m, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const [url, ...desc] = part.trim().split(/\s+/);
      if (!url) return part;
      return toProxy(url.trim()) + ' ' + desc.join(' ');
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // Meta refresh
  out = out.replace(/content="\s*\d+\s*;\s*url=([^"]*)"/gi, (m, u) => `content="0; url=${toProxy(u)}"`);

  // Strip security headers that break proxy
  out = out.replace(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '<!-- CSP stripped by Neptune -->');
  out = out.replace(/<meta[^>]*http-equiv="X-Frame-Options"[^>]*>/gi, '<!-- XFO stripped by Neptune -->');

  // Lazy-load images
  out = out.replace(/<img([^>]*)>/gi, (m, attrs) => {
    if (attrs.includes('loading=')) return m;
    return `<img${attrs} loading="lazy">`;
  });

  // Dark mode injection
  if (cfg.darkMode) {
    const darkCSS = `<style id="__nptn_dark">html,body{background:#0a0a0f!important;color:#ddd!important}body *{background-color:transparent!important;color:#ccc!important;border-color:#333!important}a{color:#00ff88!important}</style>`;
    if (out.includes('</head>')) {
      out = out.replace('</head>', darkCSS + '</head>');
    } else {
      out = darkCSS + out;
    }
  }

  // Bridge script for parent ↔ iframe communication in CORS mode
  const bridgeScript = cfg.injectBridge ? `
<script id="__nptn_bridge">
(function(){
  'use strict';
  if(window.__nptn_bridge)return;window.__nptn_bridge=true;
  var parentOrigin='${origin}';
  window.addEventListener('message',function(e){
    if(!e.data||!e.data.__nptn)return;
    // Only accept messages from our parent (the proxy chrome)
    if(e.source!==window.parent)return;
    var d=e.data;
    if(d.type==='eval'){try{var r=eval(d.code);e.source.postMessage({__nptn:true,type:'eval_result',id:d.id,result:String(r),error:null},'*');}catch(ex){e.source.postMessage({__nptn:true,type:'eval_result',id:d.id,result:null,error:ex.message},'*');}}
    if(d.type==='get_title'){e.source.postMessage({__nptn:true,type:'title',title:document.title},'*');}
    if(d.type==='get_html'){e.source.postMessage({__nptn:true,type:'html',html:document.documentElement.outerHTML},'*');}
    if(d.type==='get_text'){e.source.postMessage({__nptn:true,type:'text',text:document.body.innerText},'*');}
    if(d.type==='scroll_to'){window.scrollTo(d.x||0,d.y||0);}
    if(d.type==='click'){var el=document.elementFromPoint(d.x,d.y);if(el)el.click();}
    if(d.type==='css'){var s=document.getElementById('__nptn_user_css');if(!s){s=document.createElement('style');s.id='__nptn_user_css';document.head.appendChild(s);}s.textContent=d.css;}
  });
  // Report navigation
  var op=history.pushState, or=history.replaceState;
  history.pushState=function(){op.apply(this,arguments);window.parent.postMessage({__nptn:true,type:'nav',url:location.href},'*');};
  history.replaceState=function(){or.apply(this,arguments);window.parent.postMessage({__nptn:true,type:'nav',url:location.href},'*');};
  window.addEventListener('popstate',function(){window.parent.postMessage({__nptn:true,type:'nav',url:location.href},'*');});
  window.addEventListener('DOMContentLoaded',function(){window.parent.postMessage({__nptn:true,type:'ready',title:document.title,url:location.href},'*');});
})();
</script>` : '';

  // Runtime for intercepting fetch/XHR/clicks/forms
  const runtime = `<script id="__nptn_runtime">
(function(){
  'use strict';
  if(window.__nptn_injected)return;window.__nptn_injected=true;
  var base='${targetOrigin}', proxy='${proxyRoot}';
  function p(u){if(!u||u.startsWith('data:')||u.startsWith('blob:'))return u;if((u.startsWith('http://')||u.startsWith('https://'))&&!u.startsWith(location.origin))return proxy+encodeURIComponent(u);if(u.startsWith('//'))return proxy+encodeURIComponent('https:'+u);if(u.startsWith('/')&&!u.startsWith('/proxy'))return proxy+encodeURIComponent(base+u);return u;}
  var of=window.fetch;
  window.fetch=function(i,init){
    if(typeof i==='string'){
      var u=i;
      if(u&&u.startsWith('http')&&!u.startsWith(location.origin))u=p(u);
      else if(u&&u.startsWith('/')&&!u.startsWith('/proxy'))u=p(u);
      return of(u,init);
    }
    if(i&&i.url){
      var u=i.url;
      if(u&&u.startsWith('http')&&!u.startsWith(location.origin))u=p(u);
      else if(u&&u.startsWith('/')&&!u.startsWith('/proxy'))u=p(u);
      return of(new Request(u,i),init);
    }
    return of(i,init);
  };
  var ox=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u,a,uu,pp){if(u&&u.startsWith('http')&&!u.startsWith(location.origin)){u=p(u);}else if(u&&u.startsWith('/')&&!u.startsWith('/proxy')){u=p(u);}return ox.call(this,m,u,a,uu,pp);};
  document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href');if(h&&!h.startsWith('javascript:')&&!h.startsWith('#')&&!h.startsWith('mailto:')&&!h.startsWith('tel:')){if(h.startsWith('http')||h.startsWith('/')){a.setAttribute('href',p(h));}}},true);
  document.addEventListener('submit',function(e){var f=e.target;if(f.tagName!=='FORM')return;var a=f.getAttribute('action');if(a&&a.startsWith('http')&&!a.startsWith(location.origin)){f.setAttribute('action',p(a));}else if(a&&a.startsWith('/')&&!a.startsWith('/proxy')){f.setAttribute('action',p(a));}},true);
  var op=history.pushState, or=history.replaceState;
  function patchHistory(orig){return function(){var args=Array.from(arguments);if(args.length>=3&&typeof args[2]==='string'){args[2]=p(args[2]);}return orig.apply(this,args);};}
  history.pushState=patchHistory(op);
  history.replaceState=patchHistory(or);
  window.addEventListener('popstate',function(){if(window.__nptn_navigate)window.__nptn_navigate(location.href);});
})();
</script>`;

  // Inject scripts
  if (out.includes('</head>')) {
    out = out.replace('</head>', bridgeScript + runtime + '</head>');
  } else if (out.includes('<body')) {
    out = out.replace('<body', bridgeScript + runtime + '<body');
  } else {
    out = bridgeScript + runtime + out;
  }

  return out;
}

function trackerBlockResponse(destination) {
  const isImg = destination === 'image';
  if (isImg) {
    // 1x1 transparent GIF
    const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
    return new Response(gif.buffer, {
      status: 200,
      headers: { 'Content-Type': 'image/gif', 'Content-Length': '43', 'X-Neptune-Blocked': 'tracker' },
    });
  }
  return new Response('', {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'X-Neptune-Blocked': 'tracker' },
  });
}

// ════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════
function resolveURL(rel, base) {
  try { return new URL(rel, base).toString(); }
  catch(e) { return base + (base.endsWith('/') ? '' : '/') + rel; }
}

function sanitizeHeaders(headers) {
  const safe = new Headers();
  const drop = [
    'set-cookie','content-security-policy','content-security-policy-report-only',
    'x-frame-options','strict-transport-security','permissions-policy',
    'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
    'x-content-type-options', // can cause issues with proxied content
  ];
  headers.forEach((v,k) => { if (!drop.includes(k.toLowerCase())) safe.set(k, v); });
  return safe;
}

function errorResponse(msg, status) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
     body{background:#0a0a0f;color:#ccc;font-family:'SF Mono','Fira Code',monospace,monospace;padding:20px;line-height:1.6;max-width:700px;margin:0 auto}
     h1{color:#ff4444;border-bottom:1px solid #333;padding-bottom:10px;font-size:18px}
     code{background:#1a1a2e;padding:2px 6px;border-radius:2px;color:#00ff88;font-size:12px}
     .box{background:#111;padding:15px;border-radius:4px;margin-top:15px;color:#ff4444;font-size:13px}
     .ok{color:#00ff88}
     a{color:#00aa66}
     p{margin:8px 0}
     .hint{color:#555;font-size:11px}
     .retry-btn{background:#1a3a2e;border:1px solid #004d33;color:#00ff88;padding:6px 14px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:12px;margin-top:10px}
     .retry-btn:hover{background:#224433}
     </style></head><body>
     <h1>Neptune Proxy Error ${status}</h1>
     <div class="box">${msg}</div>
     <p class="ok" style="margin-top:20px">Strategy: ${activeStrategy || 'detecting...'}</p>
     <p>Requests: ${totalRequests} | Blocked: ${blockedCount} | Bandwidth: ${formatBytes(totalBytes)}</p>
     <p class="hint">v${SW_VERSION} — standalone SW proxy kernel</p>
     <button class="retry-btn" onclick="location.reload()">&#x21BB; Retry</button>
     </body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function buildErrorHtml(strategies, targetUrl, lastError) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{background:#0a0a0f;color:#ccc;font-family:'SF Mono','Fira Code',monospace,monospace;padding:20px;line-height:1.6;max-width:600px;margin:40px auto}
h2{color:#ff4444;border-bottom:1px solid #333;padding-bottom:10px}
code{background:#1a1a2e;padding:2px 6px;border-radius:2px;color:#00ff88;font-size:12px}
.box{background:#111;padding:15px;border-radius:4px;margin-top:15px;color:#ff4444;font-size:13px}
h3{color:#00ff88}
hr{border-color:#333;border-style:solid;border-width:1px 0 0 0;margin:16px 0}
li{margin:8px 0}
a{color:#00aa66;text-decoration:none}
a:hover{color:#00ff88;text-decoration:underline}
.retry-btn{background:#1a3a2e;border:1px solid #004d33;color:#00ff88;padding:8px 18px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:13px;margin-top:12px}
.retry-btn:hover{background:#224433}
.diag{color:#555;font-size:11px;margin-top:12px}
</style></head><body>
<h2>Neptune — Cannot load target</h2>
<p><strong>Target:</strong> <code>${escapeHtml(targetUrl)}</code></p>
<p><strong>Tried:</strong> ${strategies.join(', ')}</p>
${lastError ? `<div class="box">${escapeHtml(lastError.message || lastError)}</div>` : ''}
<hr>
<h3>Why this happens</h3>
<p>This cartridge is fully standalone — no proxy servers, no extensions, no external URLs. The ServiceWorker kernel can fetch most sites, but some origins block all cross-origin access.</p>
<hr>
<h3>How the proxy works</h3>
<ol>
<li><strong>SW Navigation Fetch:</strong> The ServiceWorker intercepts navigation requests and fetches the target URL. As a trusted browser context, SWs can read cross-origin responses for navigation.</li>
<li><strong>HTML Rewriting:</strong> All resource URLs (scripts, styles, images, links) are rewritten to go through the proxy path, keeping everything same-origin.</li>
<li><strong>Subresource Passthrough:</strong> Images, scripts, and other resources are fetched and streamed back. Opaque responses work for most resource types.</li>
<li><strong>iframe Fallback:</strong> Sites that can't be fetched directly load in a sandboxed iframe for visual browsing.</li>
</ol>
<p class="diag">Strategy: ${activeStrategy || 'detecting'} | Requests: ${totalRequests} | Blocked: ${blockedCount} | Version: ${SW_VERSION}</p>
<button class="retry-btn" onclick="location.reload()">↻ Retry Connection</button>
</body></html>`;
}

function blockedResponse(url) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{background:#0a0a0f;color:#ff4444;font-family:'SF Mono','Fira Code',monospace,monospace;padding:40px 20px;text-align:center;line-height:1.6;max-width:600px;margin:0 auto}
h1{font-size:28px;margin-bottom:12px}
p{color:#888;font-size:13px;margin:8px 0}
code{background:#1a1a2e;padding:2px 8px;border-radius:3px;color:#ffaa00;font-size:12px;word-break:break-all}
.retry-btn{background:#1a3a2e;border:1px solid #004d33;color:#00ff88;padding:8px 18px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:13px;margin-top:16px;transition:all .15s}
.retry-btn:hover{background:#224433}
</style></head><body>
<h1>🚫 Blocked by Filter</h1>
<p><code>${escapeHtml(url)}</code></p>
<p>URL matched blacklist rule or failed whitelist check.</p>
<button class="retry-btn" onclick="history.back()">← Go Back</button>
</body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Neptune-Blocked': 'filter' } }
  );
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024*1024*1024) return (b/(1024*1024)).toFixed(1) + ' MB';
  return (b/(1024*1024*1024)).toFixed(1) + ' GB';
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════
// Network Adapter Bridge — fetch()-based Ethernet transport
// ════════════════════════════════════════════════════════

// Per-connection state: localPort → { host, port, controller }
const netAdaptConnections = new Map();

async function handleNetAdaptConnect(d, src) {
  const { localPort, targetHost, targetPort } = d;
  if (!localPort || !targetHost) return;

  // Store the connection state — do NOT fetch yet. The actual HTTP request
  // comes via NET_ADAPT_DATA once smoltcp completes the TCP handshake
  // and sends the HTTP request bytes.
  netAdaptConnections.set(localPort, {
    host: targetHost,
    port: targetPort || 80,
    controller: new AbortController(),
    connected: true,
  });

  console.log('[SW-NETADAPT] CONNECT local_port=' + localPort + ' → ' + targetHost + ':' + (targetPort || 80));

  // Acknowledge the connection back to the NetworkAdapter
  // (the adapter already sent SYN-ACK to smoltcp; this just confirms SW state)
  if (src) src.postMessage({
    type: 'NET_ADAPT_CONNECTED',
    localPort,
  });
}

async function handleNetAdaptData(d, src) {
  const { localPort, data } = d;
  if (!localPort || !data) return;

  const conn = netAdaptConnections.get(localPort);
  if (!conn) {
    console.warn('[SW-NETADAPT] DATA for unknown port', localPort);
    return;
  }

  // Parse the HTTP request from the TCP payload bytes
  try {
    const text = new TextDecoder().decode(new Uint8Array(data));
    const lines = text.split('\r\n');
    const requestLine = lines[0] || '';
    const parts = requestLine.split(' ');
    const method = parts[0] || 'GET';
    let path = parts[1] || '/';
    // Handle absolute-URI form: GET http://host/path HTTP/1.1
    if (path.startsWith('http://') || path.startsWith('https://')) {
      try {
        path = new URL(path).pathname + new URL(path).search;
      } catch (e) {}
    }

    // Parse headers
    const headers = {};
    let i = 1;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line) break;
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    // Body starts after the empty line
    let body = null;
    const bodyStart = text.indexOf('\r\n\r\n');
    if (bodyStart >= 0 && bodyStart + 4 < data.length) {
      body = data.slice(bodyStart + 4);
    }

    const url = `http://${conn.host}:${conn.port}${path}`;

    // Build request init with optional traffic obfuscation
    const reqInit = buildObfuscatedRequest(method, conn.host, headers, body);

    // Phase 6: Apply timing jitter to obfuscate request timing patterns
    await applyTimingJitter();

    // Wire abort controller so handleNetAdaptClose can cancel in-flight requests
    let resp;
    try {
      resp = await fetch(url, { ...reqInit, signal: conn.controller.signal });
    } catch (e) {
      // Silently swallow abort errors from handleNetAdaptClose — they are expected
      if (e.name === 'AbortError') {
        console.log('[SW-NETADAPT] Fetch aborted for port', localPort);
        return;
      }
      throw e;
    }

    const buf = await resp.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buf));

    if (src) src.postMessage({
      type: 'NET_ADAPT_RESPONSE',
      localPort,
      data: bytes,
      close: headers['connection'] === 'close',
    });

    totalBytes += buf.byteLength;
    totalRequests++;
  } catch (e) {
    console.error('[SW-NETADAPT] Data fetch failed:', e.message);
    if (src) src.postMessage({
      type: 'NET_ADAPT_ERROR',
      localPort,
      error: e.message,
    });
  }
}

function handleNetAdaptClose(d, src) {
  const { localPort } = d;
  if (!localPort) return;

  const conn = netAdaptConnections.get(localPort);
  if (conn && conn.controller) {
    try { conn.controller.abort(); } catch (e) {}
  }
  netAdaptConnections.delete(localPort);
  console.log('[SW-NETADAPT] CLOSE local_port=' + localPort);

  if (src) src.postMessage({
    type: 'NET_ADAPT_CLOSED',
    localPort,
  });
}

/**
 * Build a fetch init object with Phase 6 traffic obfuscation:
 *   - Randomized header ordering and casing
 *   - Accept-Language rotation
 *   - Referer injection
 *   - Timing jitter (handled by caller via setTimeout)
 */
function buildObfuscatedRequest(method, host, headers, body) {
  const init = {
    method: method,
    redirect: 'follow',
    cache: 'no-store',
    mode: 'cors',
  };

  // Phase 6: Header randomization profiles
  const profiles = [
    // Chrome 120 on Windows
    {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'dnt': '1',
    },
    // Firefox 121 on macOS
    {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
      'dnt': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    // Safari 17 on macOS
    {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'upgrade-insecure-requests': '1',
    },
  ];

  // Select random profile
  const profile = profiles[Math.floor(Math.random() * profiles.length)];

  // Build randomized header order using Headers constructor for deduplication.
  // NOTE: The Fetch API Headers object does not guarantee transmission order;
  // browsers normalize and may reorder headers. The shuffle here provides
  // some defense-in-depth but is not a strict order guarantee.
  const headerKeys = Object.keys(profile);
  // Fisher-Yates shuffle
  for (let i = headerKeys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [headerKeys[i], headerKeys[j]] = [headerKeys[j], headerKeys[i]];
  }

  const randomizedHeaders = new Headers();
  for (const key of headerKeys) {
    randomizedHeaders.set(key, profile[key]);
  }

  // Override with any headers from the actual HTTP request (normalized lowercase)
  const preserveHeaders = ['host', 'content-type', 'content-length', 'authorization', 'cookie', 'x-requested-with'];
  for (const key of Object.keys(headers)) {
    const lowerKey = key.toLowerCase();
    if (preserveHeaders.includes(lowerKey)) {
      randomizedHeaders.set(lowerKey, headers[key]);
    }
  }

  // Inject dynamic referer for obfuscation
  const referers = [
    'https://www.google.com/',
    'https://duckduckgo.com/',
    'https://www.bing.com/',
    'https://search.yahoo.com/',
    'https://www.reddit.com/',
  ];
  if (!randomizedHeaders.has('referer') && Math.random() > 0.3) {
    randomizedHeaders.set('referer', referers[Math.floor(Math.random() * referers.length)]);
  }

  // Apply user agent override from config if set
  if (swConfig.userAgent) {
    randomizedHeaders.set('user-agent', swConfig.userAgent);
  } else {
    // Rotate User-Agent from profile pool
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    ];
    randomizedHeaders.set('user-agent', uas[Math.floor(Math.random() * uas.length)]);
  }

  init.headers = randomizedHeaders;

  if (body && body.length > 0) {
    init.body = new Uint8Array(body);
  }

  // Timing jitter: return init immediately; actual jitter applied by caller
  return init;
}

/**
 * Apply timing jitter to an async operation to obfuscate traffic patterns.
 * Returns a Promise that resolves after a random delay.
 */
function applyTimingJitter() {
  // Random delay between 0ms and 500ms, weighted toward shorter delays
  const jitter = Math.floor(Math.pow(Math.random(), 2) * 500);
  return new Promise(r => setTimeout(r, jitter));
}

function broadcast(msg) {
  clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage(msg)));
}
