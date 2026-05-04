/**
 * project: neptune — Traffic Obfuscation Module v1.0.0
 * Phase 6: Header randomization, timing jitter, referer rotation
 *
 * Provides randomized HTTP header profiles to make proxied
 * traffic look like normal browser traffic from diverse browsers.
 */

'use strict';

const NeptuneObfuscator = (function() {

  // ── Browser header profiles ──────────────────────────
  const PROFILES = [
    {
      name: 'Chrome 120 Windows',
      weight: 0.45,
      headers: {
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
      },
    },
    {
      name: 'Firefox 121 Windows',
      weight: 0.20,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
    },
    {
      name: 'Safari 17 macOS',
      weight: 0.15,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    },
    {
      name: 'Edge 120 Windows',
      weight: 0.10,
      headers: {
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    },
    {
      name: 'Chrome 120 macOS',
      weight: 0.08,
      headers: {
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Upgrade-Insecure-Requests': '1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    },
    {
      name: 'Chrome Android',
      weight: 0.02,
      headers: {
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'Upgrade-Insecure-Requests': '1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    },
  ];

  // Build cumulative weight array for weighted random selection
  let cumulativeWeights = [];
  let totalWeight = 0;
  (function buildWeights() {
    totalWeight = PROFILES.reduce(function(acc, p) { return acc + p.weight; }, 0);
    let acc = 0;
    cumulativeWeights = PROFILES.map(function(p) {
      acc += p.weight;
      return acc;
    });
  })();

  // ── User-Agent rotation pool ───────────────────────
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  // ── Accept-Language rotation ───────────────────────
  const LANGUAGES = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,fr;q=0.7',
    'en-GB,en;q=0.9,en-US;q=0.8',
    'en-US,en;q=0.9,es;q=0.7',
    'en-US,en;q=0.9,de;q=0.5',
  ];

  // ── Referer policy ─────────────────────────────────
  const REFERER_POLICIES = ['no-referrer', 'same-origin', 'origin-when-cross-origin'];

  // Session state
  let activeProfile = null;
  let sessionSeed = 0;
  let requestCounter = 0;

  /**
   * Initialize obfuscator with a random profile.
   */
  function init() {
    sessionSeed = Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0);
    activeProfile = selectRandomProfile();
    return activeProfile;
  }

  /**
   * Select a random browser profile based on weights.
   */
  function selectRandomProfile() {
    var r = Math.random() * totalWeight;
    for (var i = 0; i < cumulativeWeights.length; i++) {
      if (r <= cumulativeWeights[i]) {
        return JSON.parse(JSON.stringify(PROFILES[i]));
      }
    }
    return JSON.parse(JSON.stringify(PROFILES[0]));
  }

  /**
   * Rotate to a new profile (call periodically).
   */
  function rotateProfile() {
    var current = activeProfile ? activeProfile.name : null;
    var tries = 0;
    while (tries < 20) {
      activeProfile = selectRandomProfile();
      if (activeProfile.name !== current || tries > 10) break;
      tries++;
    }
    return activeProfile;
  }

  /**
   * Apply obfuscated headers to an existing Headers object.
   * @param {Headers} headers - Headers object to modify
   * @param {Object} opts - Options
   * @param {string} opts.referer - Actual referer URL (will be stripped/transformed)
   * @param {string} opts.userAgent - Optional forced User-Agent
   * @param {boolean} opts.stripReferer - Strip Referer header entirely
   */
  function applyHeaders(headers, opts) {
    opts = opts || {};
    if (!activeProfile) init();

    // Apply profile headers
    var headerMap = activeProfile.headers;
    for (var key in headerMap) {
      if (headerMap.hasOwnProperty(key)) {
        headers.set(key, headerMap[key]);
      }
    }

    // Randomize Accept-Language
    headers.set('Accept-Language', LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)]);

    // Set User-Agent
    var ua = opts.userAgent || activeProfile.name;
    // Match actual UA strings from pool
    var uaIdx = Math.floor(Math.random() * USER_AGENTS.length);
    headers.set('User-Agent', opts.userAgent || USER_AGENTS[uaIdx]);

    // Handle referer
    if (opts.stripReferer) {
      headers.delete('Referer');
      headers.set('Referrer-Policy', 'no-referrer');
    } else {
      headers.set('Referrer-Policy', REFERER_POLICIES[Math.floor(Math.random() * REFERER_POLICIES.length)]);
    }

    // Add randomized DNT header
    if (Math.random() < 0.3) {
      headers.set('DNT', '1');
    }

    requestCounter++;
    return headers;
  }

  /**
   * Calculate a jitter delay for timing obfuscation.
   * @param {number} baseDelay - Base delay in ms
   * @returns {number} Jittered delay
   */
  function jitter(baseDelay) {
    baseDelay = baseDelay || 0;
    // Normal distribution approximation via Box-Muller
    var u1 = Math.random();
    var u2 = Math.random();
    var gaussian = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
    // Scale: mean=0, stddev=50ms
    var j = gaussian * 50;
    // Clamp between -100 and 200
    j = Math.max(-100, Math.min(200, j));
    return Math.max(0, baseDelay + Math.round(j));
  }

  /**
   * Get a randomized User-Agent string.
   * @returns {string}
   */
  function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  /**
   * Get current profile name.
   * @returns {string}
   */
  function currentProfile() {
    return activeProfile ? activeProfile.name : 'none';
  }

  /**
   * Reset session state.
   */
  function reset() {
    activeProfile = null;
    requestCounter = 0;
    init();
  }

  return {
    init: init,
    applyHeaders: applyHeaders,
    jitter: jitter,
    randomUA: randomUA,
    rotateProfile: rotateProfile,
    currentProfile: currentProfile,
    reset: reset,
    profiles: PROFILES,
    userAgents: USER_AGENTS,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneObfuscator;
}
if (typeof window !== 'undefined') {
  window.NeptuneObfuscator = NeptuneObfuscator;
}
if (typeof self !== 'undefined') {
  self.NeptuneObfuscator = NeptuneObfuscator;
}
