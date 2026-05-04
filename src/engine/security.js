/**
 * project: neptune — Security Module v1.0.0
 * Phase 4.2: Header sanitization, CSP injection, security policy enforcement
 */

'use strict';

const NeptuneSecurity = (function() {

  // Security-sensitive headers to strip from proxied responses
  const DROP_RESPONSE_HEADERS = [
    'set-cookie',
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'strict-transport-security',
    'permissions-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'x-content-type-options',
    'x-xss-protection',
    'referrer-policy',
    'expect-ct',
    'nel',
    'report-to',
  ];

  // Headers to strip from outbound requests for privacy
  const STRIP_REQUEST_HEADERS = [
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
    'sec-ch-ua-model',
    'sec-ch-ua-platform-version',
    'sec-ch-ua-wow64',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'x-client-data',
    'x-chrome-connected',
    'x-chrome-uma-enabled',
  ];

  /**
   * Sanitize response headers — remove security-sensitive headers
   * that would break proxying or restrict the iframe/content.
   * @param {Headers} headers - Original response headers
   * @returns {Headers} Sanitized headers
   */
  function sanitizeResponseHeaders(headers) {
    const safe = new Headers();
    headers.forEach(function(v, k) {
      if (DROP_RESPONSE_HEADERS.indexOf(k.toLowerCase()) < 0) {
        safe.set(k, v);
      }
    });
    return safe;
  }

  /**
   * Sanitize request headers — remove tracking headers from outbound requests.
   * @param {Headers} headers - Original request headers
   * @returns {Headers} Sanitized headers
   */
  function sanitizeRequestHeaders(headers) {
    const safe = new Headers();
    headers.forEach(function(v, k) {
      if (STRIP_REQUEST_HEADERS.indexOf(k.toLowerCase()) < 0) {
        safe.set(k, v);
      }
    });
    return safe;
  }

  /**
   * Generate a permissive CSP to inject into proxied pages.
   * Allows the page to function while keeping it sandboxed in our iframe.
   * @returns {string} CSP header value
   */
  function getPermissiveCSP() {
    return [
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
      "frame-ancestors *",
      "form-action *",
      "connect-src * data: blob:",
      "img-src * data: blob:",
      "style-src * 'unsafe-inline'",
      "script-src * 'unsafe-inline' 'unsafe-eval'",
      "font-src * data:",
      "media-src * data: blob:",
    ].join('; ');
  }

  /**
   * Check if a URL is safe to proxy (no internal protocols).
   * @param {string} url
   * @returns {boolean}
   */
  function isSafeUrl(url) {
    if (!url) return false;
    const blocked = ['javascript:', 'data:', 'file:', 'about:', 'chrome:', 'chrome-extension:', 'moz-extension:'];
    const lower = url.toLowerCase();
    for (var i = 0; i < blocked.length; i++) {
      if (lower.indexOf(blocked[i]) === 0) return false;
    }
    return true;
  }

  /**
   * Sanitize HTML content to remove scripts and event handlers.
   * Used for reader mode and local preview.
   * @param {string} html
   * @returns {string}
   */
  function sanitizeHTML(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '');
  }

  return {
    sanitizeResponseHeaders: sanitizeResponseHeaders,
    sanitizeRequestHeaders: sanitizeRequestHeaders,
    getPermissiveCSP: getPermissiveCSP,
    isSafeUrl: isSafeUrl,
    sanitizeHTML: sanitizeHTML,
    DROP_RESPONSE_HEADERS: DROP_RESPONSE_HEADERS,
    STRIP_REQUEST_HEADERS: STRIP_REQUEST_HEADERS,
  };

})();

if (typeof window !== 'undefined') {
  window.NeptuneSecurity = NeptuneSecurity;
}
if (typeof self !== 'undefined') {
  self.NeptuneSecurity = NeptuneSecurity;
}
