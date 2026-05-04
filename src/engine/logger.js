/**
 * project: neptune — Request Logger v1.0.0
 * Phase 4: Network request logging and statistics
 *
 * Captures all proxied requests/responses for the network inspector.
 * Designed for both ServiceWorker and page context use.
 */

'use strict';

const NeptuneLogger = (function() {

  const MAX_ENTRIES = 1000;
  const MAX_BUFFER_SIZE = 500;

  // Event buffers (before flush)
  let buffer = [];
  let entries = [];

  // Aggregated statistics
  let stats = {
    totalRequests: 0,
    totalBytes: 0,
    totalBytesRcvd: 0,
    blockedCount: 0,
    cachedCount: 0,
    errorCount: 0,
    startTime: Date.now(),
    strategies: {},    // strategy → count
    statusCodes: {},   // status → count
    domains: {},       // domain → count
    contentTypes: {},  // type → count
  };

  // Flush callback for UI updates
  let flushCallback = null;
  let flushTimer = null;
  let flushInterval = 1000; // ms

  /**
   * Log a request/response entry.
   * @param {Object} entry
   * @param {string} entry.url - Request URL
   * @param {string} entry.method - HTTP method
   * @param {number} entry.status - HTTP status code
   * @param {string} entry.type - Content type
   * @param {number} entry.size - Response size in bytes
   * @param {number} entry.duration - Request duration in ms
   * @param {string} entry.strategy - Proxy strategy used
   * @param {boolean} entry.fromCache - Whether served from cache
   * @param {boolean} entry.blocked - Whether blocked
   */
  function log(entry) {
    entry = entry || {};
    entry.timestamp = Date.now();
    entry.id = stats.totalRequests;

    // Prepend to entries (most recent first)
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.pop();

    // Add to buffer for delayed flush
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER_SIZE) buffer.shift();

    // Update statistics
    stats.totalRequests++;
    if (entry.size) {
      stats.totalBytes += entry.size;
      stats.totalBytesRcvd += Math.max(0, entry.size - (entry.requestSize || 0));
    }
    if (entry.blocked) stats.blockedCount++;
    if (entry.fromCache) stats.cachedCount++;
    if (entry.status >= 400 || entry.error) stats.errorCount++;

    // Strategy counting
    var strat = entry.strategy || 'unknown';
    stats.strategies[strat] = (stats.strategies[strat] || 0) + 1;

    // Status code counting
    if (entry.status) {
      var statusKey = String(entry.status);
      stats.statusCodes[statusKey] = (stats.statusCodes[statusKey] || 0) + 1;
    }

    // Domain counting
    try {
      var u = new URL(entry.url);
      var domain = u.hostname;
      stats.domains[domain] = (stats.domains[domain] || 0) + 1;
    } catch (e) {}

    // Content type counting
    if (entry.type) {
      var simpleType = entry.type.split(';')[0].trim().toLowerCase() || 'unknown';
      stats.contentTypes[simpleType] = (stats.contentTypes[simpleType] || 0) + 1;
    }

    // Schedule flush
    scheduleFlush();
  }

  /**
   * Schedule a flush to the UI callback.
   */
  function scheduleFlush() {
    if (!flushCallback) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, flushInterval);
  }

  /**
   * Flush buffered entries to the callback.
   */
  function flush() {
    if (!flushCallback || buffer.length === 0) return;
    var batch = buffer.slice();
    buffer = [];
    flushCallback(batch);
  }

  /**
   * Set flush callback and interval.
   * @param {Function} callback - Called with array of new entries
   * @param {number} interval - Flush interval in ms
   */
  function setFlushCallback(callback, interval) {
    flushCallback = callback;
    if (interval) flushInterval = interval;
  }

  /**
   * Get all entries.
   * @returns {Array}
   */
  function getEntries() {
    return entries;
  }

  /**
   * Get aggregated statistics.
   * @returns {Object}
   */
  function getStats() {
    // Compute derived stats
    var elapsed = Date.now() - stats.startTime;
    var elapsedSec = Math.max(1, elapsed / 1000);
    return {
      totalRequests: stats.totalRequests,
      totalBytes: stats.totalBytes,
      totalBytesRcvd: stats.totalBytesRcvd,
      blockedCount: stats.blockedCount,
      cachedCount: stats.cachedCount,
      errorCount: stats.errorCount,
      uptimeMs: elapsed,
      requestsPerSec: Math.round(stats.totalRequests / elapsedSec * 10) / 10,
      bytesPerSec: Math.round(stats.totalBytes / elapsedSec),
      strategies: Object.assign({}, stats.strategies),
      statusCodes: Object.assign({}, stats.statusCodes),
      topDomains: getTopN(stats.domains, 10),
      contentTypes: Object.assign({}, stats.contentTypes),
    };
  }

  /**
   * Get top N entries from a frequency map.
   */
  function getTopN(map, n) {
    return Object.entries(map)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, n)
      .map(function(e) { return { key: e[0], count: e[1] }; });
  }

  /**
   * Filter entries by criteria.
   * @param {Object} filter
   * @param {string} filter.strategy - Strategy filter
   * @param {number} filter.minStatus - Min status code
   * @param {number} filter.maxStatus - Max status code
   * @param {string} filter.domain - Domain filter
   * @param {string} filter.search - URL search string
   * @returns {Array}
   */
  function filter(filter) {
    filter = filter || {};
    return entries.filter(function(e) {
      if (filter.strategy && e.strategy !== filter.strategy) return false;
      if (filter.minStatus && e.status < filter.minStatus) return false;
      if (filter.maxStatus && e.status > filter.maxStatus) return false;
      if (filter.search) {
        var searchLower = filter.search.toLowerCase();
        if (e.url.toLowerCase().indexOf(searchLower) < 0) return false;
      }
      if (filter.domain) {
        try {
          var u = new URL(e.url);
          if (u.hostname !== filter.domain) return false;
        } catch (ex) { return false; }
      }
      return true;
    });
  }

  /**
   * Clear all entries and reset stats.
   */
  function clear() {
    entries = [];
    buffer = [];
    stats = {
      totalRequests: 0,
      totalBytes: 0,
      totalBytesRcvd: 0,
      blockedCount: 0,
      cachedCount: 0,
      errorCount: 0,
      startTime: Date.now(),
      strategies: {},
      statusCodes: {},
      domains: {},
      contentTypes: {},
    };
  }

  /**
   * Export entries as JSON.
   * @returns {Object}
   */
  function exportJSON() {
    return {
      entries: entries,
      stats: getStats(),
      exportedAt: Date.now(),
      version: '1.0.0',
    };
  }

  /**
   * Import entries from JSON.
   * @param {Object} data
   */
  function importJSON(data) {
    if (!data || !data.entries) return;
    entries = data.entries.slice(0, MAX_ENTRIES);
    // Recalculate stats
    clear();
    entries.slice().reverse().forEach(function(e) {
      log(e);
    });
  }

  return {
    log: log,
    flush: flush,
    getEntries: getEntries,
    getStats: getStats,
    filter: filter,
    clear: clear,
    exportJSON: exportJSON,
    importJSON: importJSON,
    setFlushCallback: setFlushCallback,
    MAX_ENTRIES: MAX_ENTRIES,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneLogger;
}
if (typeof window !== 'undefined') {
  window.NeptuneLogger = NeptuneLogger;
}
if (typeof self !== 'undefined') {
  self.NeptuneLogger = NeptuneLogger;
}
