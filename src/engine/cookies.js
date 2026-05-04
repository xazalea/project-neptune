/**
 * project: neptune — Cookie Jar Module v1.0.0
 * Phase 4.2: Per-domain cookie isolation and management
 *
 * Simulates cookies per domain using a Map-based cookie jar.
 * Intercepts Set-Cookie headers from responses and injects
 * Cookie headers into requests.
 */

'use strict';

const NeptuneCookies = (function() {

  // domain → [{name, value, path, domain, expires, secure, httpOnly, sameSite}]
  const jar = new Map();

  /**
   * Parse a Set-Cookie header value into one or more cookie objects.
   * Handles comma-separated cookies (multiple Set-Cookie values).
   * @param {string} header - Set-Cookie header value
   * @param {string} defaultDomain - Domain to use if not specified
   * @returns {Array} Parsed cookie objects
   */
  function parseSetCookie(header, defaultDomain) {
    if (!header) return [];
    const cookies = [];

    // Split on commas that aren't inside date values
    let current = '';
    let inExpires = false;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      const rest = header.slice(i).toLowerCase();
      if (!inExpires && rest.indexOf('expires=') === 0) {
        inExpires = true;
      }
      if (ch === ',' && !inExpires) {
        const parsed = parseOneCookie(current, defaultDomain);
        if (parsed) cookies.push(parsed);
        current = '';
        continue;
      }
      if (inExpires && (ch === ';' || i === header.length - 1)) {
        inExpires = false;
      }
      current += ch;
    }
    if (current.trim()) {
      const parsed = parseOneCookie(current, defaultDomain);
      if (parsed) cookies.push(parsed);
    }

    return cookies;
  }

  function parseOneCookie(str, defaultDomain) {
    str = str.trim();
    if (!str) return null;
    const parts = str.split(';').map(function(s) { return s.trim(); }).filter(Boolean);
    if (parts.length === 0) return null;

    const nv = parts[0];
    const eq = nv.indexOf('=');
    if (eq < 0) return null;

    const cookie = {
      name: nv.slice(0, eq).trim(),
      value: nv.slice(eq + 1).trim(),
      path: '/',
      domain: defaultDomain || '',
      expires: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
    };

    // Parse attributes
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].toLowerCase();
      if (attr.indexOf('expires=') === 0) {
        try { cookie.expires = new Date(attr.slice(8)).getTime(); } catch (e) {}
      } else if (attr.indexOf('max-age=') === 0) {
        const sec = parseInt(attr.slice(8));
        if (!isNaN(sec)) cookie.expires = Date.now() + sec * 1000;
      } else if (attr.indexOf('domain=') === 0) {
        cookie.domain = attr.slice(7).trim();
      } else if (attr.indexOf('path=') === 0) {
        cookie.path = attr.slice(5).trim();
      } else if (attr === 'secure') {
        cookie.secure = true;
      } else if (attr === 'httponly') {
        cookie.httpOnly = true;
      } else if (attr.indexOf('samesite=') === 0) {
        cookie.sameSite = attr.slice(9).trim();
      }
    }

    // Use domain attribute if present, otherwise default
    if (!cookie.domain && defaultDomain) cookie.domain = defaultDomain;
    return cookie;
  }

  /**
   * Store cookies for a given URL.
   * @param {string} targetUrl - The URL that set the cookie
   * @param {string} setCookieHeader - Set-Cookie header value
   */
  function storeCookie(targetUrl, setCookieHeader) {
    if (!targetUrl || !setCookieHeader) return;
    try {
      const domain = new URL(targetUrl).hostname;
      const cookies = parseSetCookie(setCookieHeader, domain);

      cookies.forEach(function(ck) {
        const cookieDomain = ck.domain || domain;
        if (!jar.has(cookieDomain)) jar.set(cookieDomain, []);
        const bucket = jar.get(cookieDomain);

        // Replace existing cookie with same name
        const existingIdx = bucket.findIndex(function(c) { return c.name === ck.name; });
        if (existingIdx >= 0) {
          bucket[existingIdx] = ck;
        } else {
          bucket.push(ck);
        }
      });
    } catch (e) {}
  }

  /**
   * Get the Cookie header value for a given URL.
   * @param {string} targetUrl - The URL being requested
   * @returns {string} Cookie header value
   */
  function getCookieHeader(targetUrl) {
    if (!targetUrl) return '';
    try {
      const url = new URL(targetUrl);
      const domain = url.hostname;
      const path = url.pathname;

      // Collect cookies from matching domains
      const validCookies = [];
      jar.forEach(function(cookies, cookieDomain) {
        if (domain === cookieDomain || domain.endsWith('.' + cookieDomain)) {
          cookies.forEach(function(ck) {
            // Check path
            if (ck.path && path.indexOf(ck.path) !== 0) return;
            // Check expiry
            if (ck.expires && ck.expires < Date.now()) return;
            validCookies.push(ck);
          });
        }
      });

      return validCookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
    } catch (e) {
      return '';
    }
  }

  /**
   * Remove expired cookies from all domains.
   */
  function purgeExpired() {
    const now = Date.now();
    jar.forEach(function(cookies, domain) {
      const filtered = cookies.filter(function(ck) {
        return !ck.expires || ck.expires > now;
      });
      jar.set(domain, filtered);
    });
  }

  /**
   * Clear all cookies.
   */
  function clearAll() {
    jar.clear();
  }

  /**
   * Get all cookies for a specific domain.
   * @param {string} domain
   * @returns {Array}
   */
  function getCookiesForDomain(domain) {
    return jar.get(domain) || [];
  }

  /**
   * Get count of total stored cookies.
   * @returns {number}
   */
  function getCookieCount() {
    let count = 0;
    jar.forEach(function(cookies) { count += cookies.length; });
    return count;
  }

  /**
   * Get all domains that have cookies.
   * @returns {Array}
   */
  function getDomains() {
    return Array.from(jar.keys());
  }

  return {
    parseSetCookie: parseSetCookie,
    storeCookie: storeCookie,
    getCookieHeader: getCookieHeader,
    purgeExpired: purgeExpired,
    clearAll: clearAll,
    getCookiesForDomain: getCookiesForDomain,
    getCookieCount: getCookieCount,
    getDomains: getDomains,
  };

})();

if (typeof window !== 'undefined') {
  window.NeptuneCookies = NeptuneCookies;
}
if (typeof self !== 'undefined') {
  self.NeptuneCookies = NeptuneCookies;
}
