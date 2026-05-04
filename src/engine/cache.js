/**
 * project: neptune — Cache Module v1.0.0
 * Phase 4.3: Cache API wrapper for proxied resources
 *
 * Wraps the Cache API with TTL-based eviction and size tracking.
 * Used by the ServiceWorker to cache proxied responses.
 */

'use strict';

const NeptuneCache = (function() {

  const CACHE_NAME = 'neptune-v3';
  const DEFAULT_TTL = 86400000; // 24 hours

  /**
   * Open the Neptune cache.
   * @returns {Promise<Cache>}
   */
  async function open() {
    return caches.open(CACHE_NAME);
  }

  /**
   * Store a response in the cache with TTL.
   * @param {Request|string} key - Cache key
   * @param {Response} response - Response to cache
   * @param {number} ttl - TTL in milliseconds
   */
  async function put(key, response, ttl) {
    ttl = ttl || DEFAULT_TTL;
    try {
      const cache = await open();
      const clone = response.clone();
      const headers = new Headers(clone.headers);
      headers.set('x-neptune-cached', Date.now().toString());
      headers.set('x-neptune-ttl', ttl.toString());

      const cachedResponse = new Response(clone.body, {
        status: clone.status,
        statusText: clone.statusText,
        headers: headers,
      });

      await cache.put(key, cachedResponse);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get a cached response if not expired.
   * @param {Request|string} key - Cache key
   * @param {number} maxAge - Maximum age in ms (overrides stored TTL)
   * @returns {Promise<Response|null>}
   */
  async function get(key, maxAge) {
    try {
      const cache = await open();
      const cached = await cache.match(key);
      if (!cached) return null;

      const cachedTime = parseInt(cached.headers.get('x-neptune-cached') || '0');
      const storedTTL = parseInt(cached.headers.get('x-neptune-ttl') || String(DEFAULT_TTL));
      const effectiveMaxAge = maxAge || storedTTL;

      if (Date.now() - cachedTime > effectiveMaxAge) {
        // Expired — remove and return null
        await cache.delete(key);
        return null;
      }

      return cached;
    } catch (e) {
      return null;
    }
  }

  /**
   * Delete a specific entry.
   * @param {Request|string} key
   */
  async function remove(key) {
    try {
      const cache = await open();
      await cache.delete(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Clear all cached entries.
   */
  async function clearAll() {
    try {
      await caches.delete(CACHE_NAME);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get cache size estimate.
   * @returns {Promise<{count: number, totalSize: number}>}
   */
  async function getStats() {
    try {
      const cache = await open();
      const keys = await cache.keys();
      let totalSize = 0;
      for (const req of keys) {
        const resp = await cache.match(req);
        if (resp) {
          const cl = resp.headers.get('content-length');
          if (cl) totalSize += parseInt(cl) || 0;
        }
      }
      return { count: keys.length, totalSize: totalSize };
    } catch (e) {
      return { count: 0, totalSize: 0 };
    }
  }

  /**
   * Purge expired entries from cache.
   */
  async function purgeExpired() {
    try {
      const cache = await open();
      const keys = await cache.keys();
      for (const req of keys) {
        const resp = await cache.match(req);
        if (resp) {
          const cachedTime = parseInt(resp.headers.get('x-neptune-cached') || '0');
          const ttl = parseInt(resp.headers.get('x-neptune-ttl') || String(DEFAULT_TTL));
          if (Date.now() - cachedTime > ttl) {
            await cache.delete(req);
          }
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    open: open,
    put: put,
    get: get,
    remove: remove,
    clearAll: clearAll,
    getStats: getStats,
    purgeExpired: purgeExpired,
    CACHE_NAME: CACHE_NAME,
    DEFAULT_TTL: DEFAULT_TTL,
  };

})();

if (typeof window !== 'undefined') {
  window.NeptuneCache = NeptuneCache;
}
if (typeof self !== 'undefined') {
  self.NeptuneCache = NeptuneCache;
}
