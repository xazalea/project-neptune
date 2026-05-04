/**
 * project: neptune — Tracker Blocking Module v1.0.0
 * Phase 4.2: Pattern-based tracker detection and blocking
 *
 * Matches known analytics, ad, and tracking domains against request URLs.
 * Updated regularly with common patterns from EasyList/Disconnect lists.
 */

'use strict';

const NeptuneTracker = (function() {

  // ── Tracker patterns by category ────────────────────
  const PATTERNS = {
    analytics: [
      'google-analytics', 'googletagmanager', 'doubleclick', 'googleadservices',
      'facebook.com/tr', 'fbcdn.net', 'connect.facebook.net',
      'analytics.twitter.com', 'ads.twitter.com',
      'mixpanel', 'amplitude.com', 'segment.io', 'segment.com',
      'hotjar', 'clarity.ms', 'gtag', 'google.tag',
      'optimizely', 'crazyegg', 'mouseflow', 'fullstory',
      'heap.io', 'heap-api.com', 'heap-analytics.com',
      'pendo.io', 'logrocket.com', 'rollbar.com',
      'sentry.io', 'datadoghq.com', 'newrelic.com',
      'chartbeat.com', 'quantcast.com', 'comscore.com',
      'statcounter.com', 'histats.com', 'w3counter.com',
      'addthis.com', 'sharethis.com', 'disqus.com',
    ],
    advertising: [
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'adnxs.com', 'adsrvr.org', 'advertising.com',
      'openx.net', 'pubmatic.com', 'rubiconproject.com',
      'criteo.com', 'criteo.net', 'casalemedia.com',
      'taboola.com', 'outbrain.com', 'revcontent.com',
      'sharethrough.com', 'adform.net', 'bidswitch.net',
      'bluekai.com', 'exelator.com', 'eyeota.net',
      'moatads.com', 'adsafeprotected.com', 'adsymptotic.com',
      'amazon-adsystem.com', 'aaxads.com',
    ],
    trackers: [
      'tracker', 'pixel', 'beacon', 'telemetry',
      'collect', 'analytics', 'metrics', 'events',
    ],
    social: [
      'platform.twitter.com/widgets.js',
      'platform.linkedin.com',
      'platform.instagram.com',
      'connect.facebook.net/en_US/sdk.js',
    ],
  };

  // Cache DOMAIN_PATTERNS for fast lookup
  const DOMAIN_CACHE = new Set();

  function initCache() {
    if (DOMAIN_CACHE.size > 0) return;
    for (var cat in PATTERNS) {
      var patterns = PATTERNS[cat];
      for (var i = 0; i < patterns.length; i++) {
        DOMAIN_CACHE.add(patterns[i].toLowerCase());
      }
    }
  }

  /**
   * Check if a URL is a known tracker/analytics domain.
   * @param {string} url - Full URL to check
   * @returns {{blocked: boolean, category: string|null}}
   */
  function isTracker(url) {
    if (!url) return { blocked: false, category: null };
    initCache();
    const lower = url.toLowerCase();

    // Check exact patterns first
    for (var cat in PATTERNS) {
      var patterns = PATTERNS[cat];
      for (var i = 0; i < patterns.length; i++) {
        if (lower.indexOf(patterns[i]) >= 0) {
          return { blocked: true, category: cat };
        }
      }
    }

    return { blocked: false, category: null };
  }

  /**
   * Extract tracker blocking statistics from request log.
   * @param {Array} requestLog - Array of request log entries
   * @returns {Object} Statistics
   */
  function getStats(requestLog) {
    if (!requestLog) return { blocked: 0, byDomain: {} };

    var byDomain = {};
    var blocked = 0;

    requestLog.forEach(function(entry) {
      if (entry.type === 'tracker-blocked' || entry.strategy === 'blocked') {
        blocked++;
        try {
          var u = new URL(entry.url);
          var host = u.hostname;
          byDomain[host] = (byDomain[host] || 0) + 1;
        } catch (e) {}
      }
    });

    return { blocked: blocked, byDomain: byDomain };
  }

  /**
   * Add custom tracker patterns at runtime.
   * @param {string} pattern - Domain or URL fragment to block
   * @param {string} category - Category label
   */
  function addPattern(pattern, category) {
    category = category || 'custom';
    if (!PATTERNS[category]) PATTERNS[category] = [];
    PATTERNS[category].push(pattern.toLowerCase());
  }

  return {
    isTracker: isTracker,
    getStats: getStats,
    addPattern: addPattern,
    PATTERNS: PATTERNS,
  };

})();

if (typeof window !== 'undefined') {
  window.NeptuneTracker = NeptuneTracker;
}
if (typeof self !== 'undefined') {
  self.NeptuneTracker = NeptuneTracker;
}
