/**
 * project: neptune — Fingerprint Randomization Engine v1.0.0
 * Phase 5: Maximum Anonymity
 *
 * Injected into every proxied page BEFORE any page scripts run.
 * Spoofs browser fingerprint surfaces to prevent tracking.
 * Uses per-session deterministic noise for consistency within a session.
 */

(function() {
  'use strict';
  if (window.__neptune_fingerprint_loaded) return;
  window.__neptune_fingerprint_loaded = true;

  // ═══════════════════════════════════════════════════════
  // Per-session PRNG (deterministic within session)
  // ═══════════════════════════════════════════════════════
  var SESSION_SEED = Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0);
  function mulberry32(a) {
    return function() {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 0xFFFFFFFF;
    };
  }
  var prng = mulberry32(SESSION_SEED);

  function generateNoise(length) {
    var arr = new Uint8Array(length);
    for (var i = 0; i < length; i++) arr[i] = Math.floor(prng() * 256);
    return arr;
  }

  function randInRange(min, max) {
    return Math.floor(prng() * (max - min + 1)) + min;
  }

  function pickRandom(arr) {
    return arr[randInRange(0, arr.length - 1)];
  }

  var NOISE = generateNoise(256);

  // ═══════════════════════════════════════════════════════
  // Category 1: Navigator Overrides
  // ═══════════════════════════════════════════════════════
  function applyNavigatorSpoofs() {
    var uaProfiles = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
    var platformProfiles = ['Win32', 'MacIntel', 'Linux x86_64'];
    var cpuCores = [4, 8, 12, 16];
    var deviceMemory = [4, 8, 16, 32];

    var overrides = {
      userAgent: pickRandom(uaProfiles),
      platform: pickRandom(platformProfiles),
      hardwareConcurrency: pickRandom(cpuCores),
      deviceMemory: pickRandom(deviceMemory),
      language: 'en-US',
      languages: ['en-US', 'en'],
      maxTouchPoints: 0,
      vendor: 'Google Inc.',
      vendorSub: '',
      productSub: '20030107',
      cookieEnabled: true,
      doNotTrack: null,
      appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      appName: 'Netscape',
      appCodeName: 'Mozilla',
      product: 'Gecko',
    };

    for (var key in overrides) {
      try {
        (function(k, v) {
          Object.defineProperty(navigator, k, {
            get: function() { return v; },
            configurable: true
          });
        })(key, overrides[key]);
      } catch(e) {}
    }

    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: function() { return false; },
        configurable: true
      });
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════════════
  // Category 2: Screen Overrides
  // ═══════════════════════════════════════════════════════
  function applyScreenSpoofs() {
    var resolutions = [
      { w: 1920, h: 1080, aw: 1920, ah: 1040 },
      { w: 2560, h: 1440, aw: 2560, ah: 1400 },
      { w: 1680, h: 1050, aw: 1680, ah: 1010 },
      { w: 1366, h: 768, aw: 1366, ah: 728 },
    ];
    var res = pickRandom(resolutions);
    var colorDepths = [24, 30, 48];
    var cd = pickRandom(colorDepths);

    var overrides = {
      width: res.w,
      height: res.h,
      availWidth: res.aw,
      availHeight: res.ah,
      colorDepth: cd,
      pixelDepth: cd,
    };

    for (var key in overrides) {
      try {
        (function(k, v) {
          Object.defineProperty(screen, k, {
            get: function() { return v; },
            configurable: true
          });
        })(key, overrides[key]);
      } catch(e) {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // Category 3: Canvas Fingerprinting Protection
  // ═══════════════════════════════════════════════════════
  function spoofCanvas(noise) {
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      var ctx = this.getContext('2d');
      if (ctx) addCanvasNoise(ctx, this.width, this.height, noise);
      return origToDataURL.apply(this, arguments);
    };

    var origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb) {
      var ctx = this.getContext('2d');
      if (ctx) addCanvasNoise(ctx, this.width, this.height, noise);
      return origToBlob.apply(this, arguments);
    };

    var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function() {
      var result = origGetImageData.apply(this, arguments);
      addImageDataNoise(result, noise);
      return result;
    };

    // Slightly modify text rendering
    var origFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function() {
      var origAlpha = this.globalAlpha;
      this.globalAlpha = 0.001;
      try { origFillText.apply(this, arguments); } catch(e) {}
      this.globalAlpha = origAlpha;
      return origFillText.apply(this, arguments);
    };
  }

  function addCanvasNoise(ctx, w, h, noise) {
    if (!w || !h || w * h > 1000000) return;
    try {
      var imageData = ctx.getImageData(0, 0, w, h);
      addImageDataNoise(imageData, noise);
      ctx.putImageData(imageData, 0, 0);
    } catch(e) {}
  }

  function addImageDataNoise(imageData, noise) {
    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
      var idx = ((i / 4) * 3) % noise.length;
      data[i]     = Math.min(255, Math.max(0, data[i]     + (noise[idx] % 3) - 1));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + (noise[(idx + 1) % noise.length] % 3) - 1));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + (noise[(idx + 2) % noise.length] % 3) - 1));
    }
  }

  // ═══════════════════════════════════════════════════════
  // Category 4: WebGL Fingerprinting Protection
  // ═══════════════════════════════════════════════════════
  function spoofWebGL() {
    var vendorSpoofs = [
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    ];
    var spoof = pickRandom(vendorSpoofs);

    var UNMASKED_VENDOR_WEBGL = 0x9245;
    var UNMASKED_RENDERER_WEBGL = 0x9246;

    if (typeof WebGLRenderingContext !== 'undefined') {
      var origGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === UNMASKED_VENDOR_WEBGL || param === WebGLRenderingContext.VENDOR) {
          return spoof.vendor;
        }
        if (param === UNMASKED_RENDERER_WEBGL || param === WebGLRenderingContext.RENDERER) {
          return spoof.renderer;
        }
        return origGetParameter.call(this, param);
      };
    }

    if (typeof WebGL2RenderingContext !== 'undefined') {
      var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === UNMASKED_VENDOR_WEBGL || param === WebGL2RenderingContext.VENDOR) return spoof.vendor;
        if (param === UNMASKED_RENDERER_WEBGL || param === WebGL2RenderingContext.RENDERER) return spoof.renderer;
        return origGetParameter2.call(this, param);
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Category 5: AudioContext Fingerprinting Protection
  // ═══════════════════════════════════════════════════════
  function spoofAudioContext(noise) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    var origCreateAnalyser = AC.prototype.createAnalyser;
    AC.prototype.createAnalyser = function() {
      var analyser = origCreateAnalyser.call(this);
      var origGetByteFreq = analyser.getByteFrequencyData;
      analyser.getByteFrequencyData = function(array) {
        origGetByteFreq.call(this, array);
        for (var i = 0; i < array.length; i++) {
          array[i] = Math.min(255, Math.max(0, array[i] + (noise[i % noise.length] % 3) - 1));
        }
      };
      var origGetFloatFreq = analyser.getFloatFrequencyData;
      analyser.getFloatFrequencyData = function(array) {
        origGetFloatFreq.call(this, array);
        for (var j = 0; j < array.length; j++) {
          array[j] += (noise[j % noise.length] / 255 - 0.5) * 0.1;
        }
      };
      return analyser;
    };
  }

  // ═══════════════════════════════════════════════════════
  // Category 6: Font Enumeration Protection
  // ═══════════════════════════════════════════════════════
  function spoofFonts() {
    if (typeof window.queryLocalFonts === 'function') {
      window.queryLocalFonts = function() {
        return Promise.resolve([
          { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT', style: 'Regular' },
          { family: 'Times New Roman', fullName: 'Times New Roman', postscriptName: 'TimesNewRomanPSMT', style: 'Regular' },
          { family: 'Courier New', fullName: 'Courier New', postscriptName: 'CourierNewPSMT', style: 'Regular' },
          { family: 'Georgia', fullName: 'Georgia', postscriptName: 'Georgia', style: 'Regular' },
          { family: 'Verdana', fullName: 'Verdana', postscriptName: 'Verdana', style: 'Regular' },
        ]);
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Category 7: Timezone Spoofing
  // ═══════════════════════════════════════════════════════
  function spoofTimezone() {
    var tzOffsets = [0, -60, -120, -180, 60, 120, 180, 240, 300];
    var spoofedOffset = pickRandom(tzOffsets);

    var origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return spoofedOffset;
    };

    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      var origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function() {
        var opts = origResolvedOptions.call(this);
        opts.timeZone = 'UTC';
        return opts;
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Category 8: WebRTC Leak Protection
  // ═══════════════════════════════════════════════════════
  function blockWebRTCLeaks() {
    if (typeof RTCPeerConnection === 'undefined') return;

    var origCreateOffer = RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer = function() {
      var args = arguments;
      return origCreateOffer.apply(this, args).then(function(offer) {
        if (offer && offer.sdp) {
          offer.sdp = offer.sdp.replace(/a=candidate:\S+ (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g,
            'a=candidate:0 1 UDP 2122252543 0.0.0.0');
        }
        return offer;
      });
    };

    var origCreateAnswer = RTCPeerConnection.prototype.createAnswer;
    RTCPeerConnection.prototype.createAnswer = function() {
      var args = arguments;
      return origCreateAnswer.apply(this, args).then(function(answer) {
        if (answer && answer.sdp) {
          answer.sdp = answer.sdp.replace(/a=candidate:\S+ (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g,
            'a=candidate:0 1 UDP 2122252543 0.0.0.0');
        }
        return answer;
      });
    };
  }

  // ═══════════════════════════════════════════════════════
  // Category 9: Plugin/MimeType Spoofing
  // ═══════════════════════════════════════════════════════
  function spoofPlugins() {
    try {
      var fakePluginArray = {
        length: 0,
        item: function() { return null; },
        namedItem: function() { return null; },
        refresh: function() {},
      };
      Object.setPrototypeOf(fakePluginArray, PluginArray.prototype);
      Object.defineProperty(navigator, 'plugins', {
        get: function() { return fakePluginArray; },
        configurable: true
      });
    } catch(e) {}

    try {
      var fakeMimeArray = {
        length: 0,
        item: function() { return null; },
        namedItem: function() { return null; },
      };
      Object.setPrototypeOf(fakeMimeArray, MimeTypeArray.prototype);
      Object.defineProperty(navigator, 'mimeTypes', {
        get: function() { return fakeMimeArray; },
        configurable: true
      });
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════════════
  // Category 10: Battery API Spoofing
  // ═══════════════════════════════════════════════════════
  function spoofBattery() {
    if (!navigator.getBattery) return;
    var origGetBattery = navigator.getBattery.bind(navigator);
    navigator.getBattery = function() {
      return origGetBattery().then(function(battery) {
        try {
          Object.defineProperty(battery, 'level', { get: function() { return 1.0; }, configurable: true });
          Object.defineProperty(battery, 'charging', { get: function() { return true; }, configurable: true });
          Object.defineProperty(battery, 'chargingTime', { get: function() { return 0; }, configurable: true });
          Object.defineProperty(battery, 'dischargingTime', { get: function() { return Infinity; }, configurable: true });
        } catch(e) {}
        return battery;
      });
    };
  }

  // ═══════════════════════════════════════════════════════
  // Category 11: Miscellaneous API Spoofing
  // ═══════════════════════════════════════════════════════
  function spoofMiscApis() {
    // Block Permission API queries
    if (navigator.permissions && navigator.permissions.query) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(desc) {
        var blocked = ['geolocation','camera','microphone','notifications','midi','clipboard-read','clipboard-write'];
        if (blocked.indexOf(desc.name) >= 0) {
          return Promise.resolve({
            state: 'prompt',
            onchange: null,
            addEventListener: function() {},
            removeEventListener: function() {},
          });
        }
        return origQuery(desc);
      };
    }

    // Connection info
    if (navigator.connection) {
      try {
        Object.defineProperty(navigator.connection, 'type', { get: function() { return 'wifi'; }, configurable: true });
        Object.defineProperty(navigator.connection, 'effectiveType', { get: function() { return '4g'; }, configurable: true });
        Object.defineProperty(navigator.connection, 'downlink', { get: function() { return 10; }, configurable: true });
        Object.defineProperty(navigator.connection, 'rtt', { get: function() { return 50; }, configurable: true });
      } catch(e) {}
    }

    // Touch support
    try {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 0; }, configurable: true });
    } catch(e) {}

    // Media devices
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      var origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = function() {
        return origEnumerate().then(function(devices) {
          var standard = devices.filter(function(d) {
            return d.deviceId === '' || d.deviceId === 'default';
          });
          return standard.length > 0 ? standard : devices.slice(0, 2);
        });
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Apply All Protections
  // ═══════════════════════════════════════════════════════
  try { applyNavigatorSpoofs(); } catch(e) {}
  try { applyScreenSpoofs(); } catch(e) {}
  try { spoofCanvas(NOISE); } catch(e) {}
  try { spoofWebGL(); } catch(e) {}
  try { spoofAudioContext(NOISE); } catch(e) {}
  try { spoofFonts(); } catch(e) {}
  try { spoofTimezone(); } catch(e) {}
  try { blockWebRTCLeaks(); } catch(e) {}
  try { spoofPlugins(); } catch(e) {}
  try { spoofBattery(); } catch(e) {}
  try { spoofMiscApis(); } catch(e) {}

  console.log('[Neptune] Fingerprint randomization active (seed: ' + SESSION_SEED + ')');
})();
