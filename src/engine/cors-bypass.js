/**
 * project: neptune — CORS Bypass Engine v1.0.0
 * Phase 7: Novel CORS-bypass techniques for fully standalone browser proxy.
 *
 * Techniques:
 *   1. CSS @import bypass — cross-origin CSS is NOT CORS-restricted via @import
 *   2. object/embed tag body extraction — loads cross-origin content
 *   3. window.name relay — iframe sets window.name, navigates back to same-origin
 *   4. Cache API reader — reads cached opaque responses from page context
 *   5. CSSStyleSheet readback — reads cross-origin stylesheet rules
 *
 * Runs in the SVG UI thread (page context). The SW handles the SW-side techniques
 * (Navigation Preload, importScripts, Cache put-then-match).
 */

'use strict';

const NeptuneCORSBypass = (function() {
  const L = { DBG: 0, INF: 1, WRN: 2, ERR: 3 };
  const C = ['#555', '#00ff88', '#ffaa00', '#ff4444'];

  let logFn = function(l, msg) { console.log(['[CORS DBG]', '[CORS]', '[CORS WRN]', '[CORS ERR]'][l] + ' ' + msg); };

  // ═══════════════════════════════════════════════════════
  // Technique 1: CSS @import Bypass
  // ═══════════════════════════════════════════════════════
  // CSS @import is NOT subject to CORS in browsers. We can create a
  // <style> with @import, wait for it to load, then read cssRules.
  // This works for cross-origin CSS files that the browser otherwise
  // wouldn't let us read via fetch().

  /**
   * Load cross-origin CSS via @import and return its text content.
   * @param {string} url - Cross-origin CSS URL
   * @param {number} timeout - Max wait time in ms (default 8000)
   * @returns {Promise<string|null>} CSS text or null if failed
   */
  async function loadCSSViaImport(url, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve) {
      var style = document.createElement('style');
      style.setAttribute('data-nptn-cors', '1');
      style.textContent = '@import url("' + url + '");';

      var resolved = false;
      var timer = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          // Last attempt: try reading cssRules anyway
          try {
            var text = readStyleRules(style.sheet);
            cleanup();
            logFn(L.INF, 'CSS @import loaded (late): ' + url);
            resolve(text);
          } catch(e) {
            cleanup();
            logFn(L.WRN, 'CSS @import timeout: ' + url);
            resolve(null);
          }
        }
      }, timeout);

      function cleanup() {
        try { style.parentNode && style.parentNode.removeChild(style); } catch(e) {}
      }

      // Attach to DOM so browser loads it
      document.head.appendChild(style);

      // Poll for stylesheet load
      var attempts = 0;
      var maxPoll = 50;
      var poll = setInterval(function() {
        attempts++;
        try {
          var sheet = style.sheet;
          if (sheet && sheet.cssRules && sheet.cssRules.length > 0) {
            clearInterval(poll);
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              var text = readStyleRules(sheet);
              cleanup();
              logFn(L.INF, 'CSS @import loaded: ' + url + ' (' + text.length + ' bytes)');
              resolve(text);
            }
          }
        } catch(e) {
          // Still loading or cross-origin — if we got a SecurityError on cssRules,
          // the @import approach failed for this origin
          if (e.name === 'SecurityError' || e.code === 18) {
            clearInterval(poll);
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              cleanup();
              logFn(L.WRN, 'CSS @import blocked by browser: ' + url + ' — ' + e.message);
              resolve(null);
            }
          }
        }
        if (attempts >= maxPoll) {
          clearInterval(poll);
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            try {
              var text = readStyleRules(style.sheet);
              cleanup();
              resolve(text);
            } catch(e2) {
              cleanup();
              resolve(null);
            }
          }
        }
      }, 100);
    });
  }

  function readStyleRules(sheet) {
    if (!sheet) return null;
    var parts = [];
    try {
      for (var i = 0; i < sheet.cssRules.length; i++) {
        parts.push(sheet.cssRules[i].cssText);
      }
    } catch(e) {
      // SecurityError — can't read
      return null;
    }
    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // Technique 2: <link rel="stylesheet"> + CSSStyleSheet Readback
  // ═══════════════════════════════════════════════════════
  // Some browsers allow reading document.styleSheets[n].cssRules
  // for cross-origin stylesheets loaded via <link>. This varies by
  // browser version but is worth attempting.

  /**
   * Load cross-origin CSS via <link> and read back via styleSheets API.
   * @param {string} url - Cross-origin CSS URL
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<string|null>}
   */
  async function loadCSSViaLink(url, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.setAttribute('data-nptn-cors', '1');
      link.crossOrigin = 'anonymous'; // Request CORS headers, but may still work without

      var resolved = false;
      var timer = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          try {
            var text = findStyleSheet(url);
            cleanup();
            if (text) logFn(L.INF, 'CSS <link> loaded (late): ' + url);
            resolve(text);
          } catch(e) {
            cleanup();
            resolve(null);
          }
        }
      }, timeout);

      function cleanup() {
        try { link.parentNode && link.parentNode.removeChild(link); } catch(e) {}
      }

      function findStyleSheet(u) {
        for (var i = document.styleSheets.length - 1; i >= 0; i--) {
          var s = document.styleSheets[i];
          if (s.href && s.href.indexOf(u.replace(/^https?:/, '').split('?')[0]) >= 0) {
            try { return readStyleRules(s); } catch(e) {}
          }
        }
        return null;
      }

      link.onload = function() {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          var text = findStyleSheet(url);
          cleanup();
          if (text) {
            logFn(L.INF, 'CSS <link> loaded: ' + url + ' (' + text.length + ' bytes)');
          }
          resolve(text);
        }
      };

      link.onerror = function() {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          cleanup();
          logFn(L.WRN, 'CSS <link> failed to load: ' + url);
          resolve(null);
        }
      };

      document.head.appendChild(link);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Technique 3: object/embed Tag Body Extraction
  // ═══════════════════════════════════════════════════════
  // <object data="cross-origin-url" type="text/html"> may allow
  // contentDocument access if CORS headers permit, or in some
  // browser configs.

  /**
   * Load cross-origin content via <object> tag and attempt to read body.
   * @param {string} url - Cross-origin URL
   * @param {string} mimeType - MIME type hint (e.g., 'text/html')
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<string|null>} Body text or null
   */
  async function loadViaObjectTag(url, mimeType, timeout) {
    timeout = timeout || 10000;
    mimeType = mimeType || 'text/html';
    return new Promise(function(resolve) {
      var obj = document.createElement('object');
      obj.data = url;
      obj.type = mimeType;
      obj.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      obj.setAttribute('data-nptn-cors', '1');

      var resolved = false;
      var timer = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          try { var html = readObjectBody(obj); } catch(e) {}
          cleanup();
          if (html) logFn(L.INF, 'object tag loaded (late): ' + url);
          resolve(html || null);
        }
      }, timeout);

      function cleanup() {
        try { obj.parentNode && obj.parentNode.removeChild(obj); } catch(e) {}
      }

      function readObjectBody(el) {
        try {
          var doc = el.contentDocument;
          if (doc && doc.documentElement) {
            return doc.documentElement.outerHTML;
          }
        } catch(e) {}
        try {
          var doc2 = el.getSVGDocument && el.getSVGDocument();
          if (doc2 && doc2.documentElement) {
            return doc2.documentElement.outerHTML;
          }
        } catch(e2) {}
        return null;
      }

      obj.onload = function() {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          var html = readObjectBody(obj);
          cleanup();
          if (html) logFn(L.INF, 'object tag loaded: ' + url + ' (' + html.length + ' bytes)');
          resolve(html || null);
        }
      };

      obj.onerror = function() {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      };

      document.body.appendChild(obj);
    });
  }

  /**
   * Load cross-origin content via <embed> tag.
   * @param {string} url - Cross-origin URL
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<string|null>}
   */
  async function loadViaEmbedTag(url, timeout) {
    timeout = timeout || 10000;
    return new Promise(function(resolve) {
      var embed = document.createElement('embed');
      embed.src = url;
      embed.type = 'text/html';
      embed.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      embed.setAttribute('data-nptn-cors', '1');

      var resolved = false;
      var timer = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          try { var html = embed.getSVGDocument && embed.getSVGDocument(); } catch(e) {}
          cleanup();
          resolve(null);
        }
      }, timeout);

      function cleanup() {
        try { embed.parentNode && embed.parentNode.removeChild(embed); } catch(e) {}
      }

      embed.onload = function() {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          try {
            var doc = embed.getSVGDocument && embed.getSVGDocument();
            var html = doc && doc.documentElement ? doc.documentElement.outerHTML : null;
            cleanup();
            if (html) logFn(L.INF, 'embed tag loaded: ' + url);
            resolve(html || null);
          } catch(e) {
            cleanup();
            resolve(null);
          }
        }
      };

      embed.onerror = function() {
        clearTimeout(timer);
        if (!resolved) { resolved = true; cleanup(); resolve(null); }
      };

      document.body.appendChild(embed);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Technique 4: window.name Relay
  // ═══════════════════════════════════════════════════════
  // If an iframe can load the target site (no XFO/CSP blocking), we can:
  // 1. Load target in iframe (same-origin via proxy path)
  // 2. Inject a script into the iframe that sets window.name = full HTML
  // 3. Navigate the iframe to about:blank (same-origin to us)
  // 4. Read window.name from the parent

  /**
   * Create a hidden iframe relay that attempts to extract HTML via window.name.
   * The SW must inject a relay script into the iframed page.
   * This is the PAGE-SIDE consumer that reads window.name after navigation.
   *
   * @param {string} proxyUrl - The proxy URL that loads target in iframe
   * @param {number} timeout - Max wait in ms
   * @returns {Promise<string|null>} HTML body or null
   */
  async function windowNameRelay(proxyUrl, timeout) {
    timeout = timeout || 15000;
    logFn(L.INF, 'window.name relay: ' + proxyUrl);
    return new Promise(function(resolve) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      iframe.setAttribute('data-nptn-cors', '1');
      iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups';
      iframe.src = proxyUrl;

      var resolved = false;
      var phase1Timer;

      function cleanup() {
        clearTimeout(phase1Timer);
        try { iframe.parentNode && iframe.parentNode.removeChild(iframe); } catch(e) {}
      }

      // Phase 1: Wait for the target to load and set window.name
      phase1Timer = setTimeout(function() {
        if (!resolved) {
          // Try navigating to about:blank and reading window.name
          navigateAndRead();
        }
      }, timeout);

      function navigateAndRead() {
        try {
          iframe.contentWindow.location.replace('about:blank');
        } catch(e) {
          // Cross-origin — can't navigate. The iframe is blocked.
          if (!resolved) {
            resolved = true;
            cleanup();
            logFn(L.WRN, 'window.name relay: cannot navigate iframe (blocked)');
            resolve(null);
          }
          return;
        }

        // Poll for about:blank navigation
        var attempts = 0;
        var poll = setInterval(function() {
          attempts++;
          try {
            // When on about:blank, we should be able to read window.name
            var name = iframe.contentWindow.name;
            if (name && name.length > 0 && name !== iframe.src && name !== proxyUrl) {
              clearInterval(poll);
              if (!resolved) {
                resolved = true;
                logFn(L.INF, 'window.name relay success: ' + name.length + ' chars');
                cleanup();
                resolve(name);
              }
            }
            // Also check if the iframe's location is now about:blank
            try {
              if (iframe.contentWindow.location.href === 'about:blank' || attempts > 30) {
                var wname = iframe.contentWindow.name;
                clearInterval(poll);
                if (!resolved) {
                  resolved = true;
                  cleanup();
                  if (wname && wname.length > 0 && wname !== proxyUrl) {
                    logFn(L.INF, 'window.name relay success (late): ' + wname.length + ' chars');
                    resolve(wname);
                  } else {
                    logFn(L.WRN, 'window.name relay: window.name empty after navigation');
                    resolve(null);
                  }
                }
              }
            } catch(e2) {}
          } catch(e) {
            // Still cross-origin — target hasn't navigated away yet
          }
          if (attempts > 40) {
            clearInterval(poll);
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(null);
            }
          }
        }, 200);
      }

      // Listen for messages from the iframe if bridge is injected
      var msgHandler = function(e) {
        if (!e.data || !e.data.__nptn) return;
        if (e.data.type === 'window_name' && !resolved) {
          resolved = true;
          cleanup();
          window.removeEventListener('message', msgHandler);
          logFn(L.INF, 'window.name relay via postMessage: ' + (e.data.html || '').length + ' chars');
          resolve(e.data.html || null);
        }
      };
      window.addEventListener('message', msgHandler);

      document.body.appendChild(iframe);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Technique 5: Cache API Reader (page-side)
  // ═══════════════════════════════════════════════════════
  // The SW can cache opaque responses. The page may be able to
  // read them from Cache API if the SW puts them there with
  // proper headers.

  /**
   * Read a cached response from the Cache API that the SW stored.
   * @param {string} cacheName - Name of the cache
   * @param {string} url - URL to look up
   * @returns {Promise<Response|null>}
   */
  async function readFromCache(cacheName, url) {
    try {
      var cache = await caches.open(cacheName);
      var match = await cache.match(url);
      if (match) {
        try {
          var text = await match.text();
          logFn(L.INF, 'Cache read success: ' + url + ' (' + text.length + ' bytes)');
          return text;
        } catch(e) {
          logFn(L.WRN, 'Cache read failed (body opaque): ' + url);
          return null;
        }
      }
      return null;
    } catch(e) {
      logFn(L.WRN, 'Cache API error: ' + e.message);
      return null;
    }
  }

  /**
   * Try to find and read a URL from all available caches.
   * @param {string} url - URL to look up
   * @returns {Promise<string|null>}
   */
  async function readFromAllCaches(url) {
    try {
      var names = await caches.keys();
      for (var n of names) {
        var text = await readFromCache(n, url);
        if (text) return text;
      }
    } catch(e) {}
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // Technique 6: fetch() no-cors + response passthrough for subresources
  // ═══════════════════════════════════════════════════════
  // For JS/CSS/images, opaque responses work fine when the browser
  // renders them via <script src>, <link>, <img>. We just need to
  // pass them through. This is already handled in the SW.

  /**
   * Build a subresource proxy URL that forces no-cors mode.
   * Used for JS/CSS when direct CORS fetch fails.
   * @param {string} url - Original URL
   * @param {string} proxyRoot - Proxy root URL
   * @returns {string} Proxy URL with no-cors hint
   */
  function buildNoCorsProxyUrl(url, proxyRoot) {
    return proxyRoot + encodeURIComponent(url) + '&__nptn_nocors=1';
  }

  // ═══════════════════════════════════════════════════════
  // Combined: Try all techniques in cascade
  // ═══════════════════════════════════════════════════════

  /**
   * Try to load cross-origin CSS content using all available techniques.
   * Returns the first successful result.
   * @param {string} url - Cross-origin CSS URL
   * @param {number} timeout - Per-technique timeout
   * @returns {Promise<string|null>}
   */
  async function loadCSS(url, timeout) {
    // Technique A: @import (most reliable)
    var result = await loadCSSViaImport(url, timeout || 4000);
    if (result) return result;

    // Technique B: <link> + styleSheets readback
    result = await loadCSSViaLink(url, timeout || 4000);
    if (result) return result;

    // Technique C: Cache API read (if SW cached it)
    result = await readFromAllCaches(url);
    if (result) return result;

    return null;
  }

  /**
   * Try to load cross-origin HTML content using all available techniques.
   * This is the page-side companion to the SW's Navigation Preload.
   * Used when the SW can't get a readable response and falls back to iframe.
   * @param {string} url - Cross-origin URL
   * @param {string} proxyRoot - Proxy root URL
   * @param {number} timeout - Per-technique timeout
   * @returns {Promise<string|null>}
   */
  async function loadHTML(url, proxyRoot, timeout) {
    // Technique A: window.name relay via proxy iframe
    var proxyUrl = proxyRoot + encodeURIComponent(url) + '&__nptn=1&__nptn_relay=1';
    var result = await windowNameRelay(proxyUrl, timeout || 12000);
    if (result) return result;

    // Technique B: object tag
    result = await loadViaObjectTag(url, 'text/html', timeout || 8000);
    if (result) return result;

    // Technique C: embed tag
    result = await loadViaEmbedTag(url, timeout || 8000);
    if (result) return result;

    // Technique D: Cache API read
    result = await readFromAllCaches(url);
    if (result) return result;

    return null;
  }

  /**
   * Load a JS file cross-origin using techniques that bypass CORS.
   * Note: importScripts() is used in the SW. This is the page-side fallback.
   * @param {string} url - Cross-origin JS URL
   * @param {number} timeout - Max wait time
   * @returns {Promise<string|null>}
   */
  async function loadJS(url, timeout) {
    // Technique A: If SW has already cached it, read from cache
    var result = await readFromAllCaches(url);
    if (result) return result;

    // Technique B: Create a script tag and use the error handler to detect
    // if the script loaded (we can't read the source, but we know it loaded)
    // For reading source, we rely on the SW's importScripts technique.
    return null;
  }

  /**
   * Check if a URL is a CSS resource (based on extension or content-type hint).
   */
  function isCSSUrl(url) {
    return /\.css(\?.*)?$/i.test(url) || url.toLowerCase().indexOf('.css') >= 0;
  }

  /**
   * Check if a URL is a JS resource.
   */
  function isJSUrl(url) {
    return /\.js(\?.*)?$/i.test(url);
  }

  // ═══════════════════════════════════════════════════════
  // Cleanup: remove all CORS bypass elements from DOM
  // ═══════════════════════════════════════════════════════
  function cleanup() {
    var elements = document.querySelectorAll('[data-nptn-cors]');
    for (var i = 0; i < elements.length; i++) {
      try { elements[i].parentNode && elements[i].parentNode.removeChild(elements[i]); } catch(e) {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════
  return {
    // CSS techniques
    loadCSSViaImport: loadCSSViaImport,
    loadCSSViaLink: loadCSSViaLink,
    loadCSS: loadCSS,

    // HTML techniques
    loadViaObjectTag: loadViaObjectTag,
    loadViaEmbedTag: loadViaEmbedTag,
    windowNameRelay: windowNameRelay,
    loadHTML: loadHTML,

    // JS techniques
    loadJS: loadJS,

    // Cache
    readFromCache: readFromCache,
    readFromAllCaches: readFromAllCaches,

    // Helpers
    buildNoCorsProxyUrl: buildNoCorsProxyUrl,
    isCSSUrl: isCSSUrl,
    isJSUrl: isJSUrl,
    cleanup: cleanup,
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneCORSBypass;
}
if (typeof window !== 'undefined') {
  window.NeptuneCORSBypass = NeptuneCORSBypass;
}
