/**
 * project: neptune — Transport Detector v1.0.0
 * Phase 2: Transport Detection Matrix
 *
 * Auto-detects all available transport mechanisms in the current browser,
 * probes connectivity, and returns them sorted by priority.
 * Called by the bootloader at startup.
 */

'use strict';

const TransportDetector = (function() {

  // ═══════════════════════════════════════════════════════
  // Transport registry
  // ═══════════════════════════════════════════════════════
  const transportDefinitions = {
    directSockets: {
      name: 'direct-sockets',
      tier: 'gold',
      priority: 1,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 100000,
      latency: 2,
      browserSupport: ['chrome'],
      async detect() {
        // Direct Sockets API (Isolated Web Apps only)
        if (typeof navigator === 'undefined') return { available: false, reason: 'No navigator' };
        // Check for TCPSocket / UDPSocket globals
        if (typeof TCPSocket !== 'undefined') {
          return { available: true };
        }
        // Check for direct-sockets permission
        if (navigator.permissions) {
          try {
            const status = await navigator.permissions.query({ name: 'direct-sockets' });
            if (status.state === 'granted') return { available: true };
          } catch (e) {}
        }
        return { available: false, reason: 'Direct Sockets not available (requires Isolated Web App)' };
      }
    },

    turnRelay: {
      name: 'turn-relay',
      tier: 'silver',
      priority: 2,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: true,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 5000,
      latency: 50,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (typeof RTCPeerConnection === 'undefined') {
          return { available: false, reason: 'WebRTC not available' };
        }
        // Probe public STUN/TURN servers
        const servers = [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun.cloudflare.com:3478',
        ];
        try {
          const pc = new RTCPeerConnection({
            iceServers: servers.map(url => ({ urls: url })),
            iceTransportPolicy: 'all',
          });
          let resolved = false;
          const result = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              if (!resolved) { resolved = true; resolve({ available: false, reason: 'ICE gathering timeout' }); }
            }, 5000);
            pc.onicegatheringstatechange = () => {
              if (pc.iceGatheringState === 'complete' && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                const hasSrflx = pc.localDescription && pc.localDescription.sdp &&
                  pc.localDescription.sdp.includes('srflx');
                resolve({ available: hasSrflx, reason: hasSrflx ? null : 'No srflx candidates' });
              }
            };
            pc.onicecandidate = (e) => {
              if (!e.candidate && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve({ available: false, reason: 'No ICE candidates' });
              }
            };
            pc.createDataChannel('probe');
            pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {
              if (!resolved) { resolved = true; clearTimeout(timeout); resolve({ available: false, reason: 'ICE negotiation failed' }); }
            });
          });
          pc.close();
          return result;
        } catch (e) {
          return { available: false, reason: 'WebRTC error: ' + e.message };
        }
      }
    },

    smoltcpWasm: {
      name: 'smoltcp-wasm',
      tier: 'bronze',
      priority: 3,
      requiresServiceWorker: true,
      requiresWASM: true,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 2000,
      latency: 10,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (typeof WebAssembly === 'undefined') {
          return { available: false, reason: 'WebAssembly not supported' };
        }
        if (!('serviceWorker' in navigator)) {
          return { available: false, reason: 'ServiceWorker not supported' };
        }
        try {
          // Check WASM threading support (SharedArrayBuffer)
          const hasSab = typeof SharedArrayBuffer !== 'undefined';
          return { available: true, hasSharedArrayBuffer: hasSab };
        } catch (e) {
          return { available: false, reason: 'WASM check failed: ' + e.message };
        }
      }
    },

    webrtcDataChannel: {
      name: 'webrtc-datachannel',
      tier: 'copper',
      priority: 4,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: true,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 800,
      latency: 30,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (typeof RTCPeerConnection === 'undefined') {
          return { available: false, reason: 'WebRTC not available' };
        }
        try {
          const pc = new RTCPeerConnection({ iceServers: [] });
          const dc = pc.createDataChannel('test');
          pc.close();
          return { available: true };
        } catch (e) {
          return { available: false, reason: 'DataChannel not available: ' + e.message };
        }
      }
    },

    cssHoudini: {
      name: 'css-houdini',
      tier: 'experimental',
      priority: 5,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 100,
      latency: 10,
      browserSupport: ['chrome', 'edge'],
      async detect() {
        if (typeof CSS === 'undefined' || !CSS.paintWorklet) {
          return { available: false, reason: 'CSS Paint Worklet not available' };
        }
        return { available: true };
      }
    },

    svgGpuPipeline: {
      name: 'svg-gpu-pipeline',
      tier: 'experimental',
      priority: 6,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 50,
      latency: 20,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        // Requires WebGL or Canvas 2D for pixel reading
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
          if (!gl) return { available: false, reason: 'WebGL not available' };
          // Check if we can read pixels
          const ctx = canvas.getContext('2d');
          if (!ctx) return { available: false, reason: 'Canvas 2D not available' };
          return { available: true };
        } catch (e) {
          return { available: false, reason: 'SVG GPU check failed: ' + e.message };
        }
      }
    },

    midiLoopback: {
      name: 'midi-loopback',
      tier: 'experimental',
      priority: 7,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: true,
      supportsEncrypted: false,
      maxThroughput: 200,
      latency: 5,
      browserSupport: ['chrome', 'edge'],
      async detect() {
        if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
          return { available: false, reason: 'Web MIDI not available' };
        }
        try {
          const midi = await navigator.requestMIDIAccess();
          const hasLoopback = Array.from(midi.outputs.values()).length > 0 &&
            Array.from(midi.inputs.values()).length > 0;
          return { available: hasLoopback, reason: hasLoopback ? null : 'No MIDI ports found (requires loopback driver)' };
        } catch (e) {
          return { available: false, reason: 'MIDI access denied: ' + e.message };
        }
      }
    },

    serialLoopback: {
      name: 'serial-loopback',
      tier: 'experimental',
      priority: 8,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: true,
      supportsEncrypted: false,
      maxThroughput: 1000,
      latency: 3,
      browserSupport: ['chrome', 'edge'],
      async detect() {
        if (typeof navigator === 'undefined' || !navigator.serial) {
          return { available: false, reason: 'Web Serial not available' };
        }
        try {
          const ports = await navigator.serial.getPorts();
          return { available: ports.length > 0, reason: ports.length > 0 ? null : 'No serial ports (requires loopback device)' };
        } catch (e) {
          return { available: false, reason: 'Serial access denied: ' + e.message };
        }
      }
    },

    webCodecs: {
      name: 'webcodecs',
      tier: 'experimental',
      priority: 9,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 500,
      latency: 40,
      browserSupport: ['chrome', 'edge'],
      async detect() {
        if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
          return { available: false, reason: 'WebCodecs not available' };
        }
        return { available: true };
      }
    },

    torWasm: {
      name: 'tor-wasm',
      tier: 'fallback',
      priority: 10,
      requiresServiceWorker: false,
      requiresWASM: true,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 200,
      latency: 1500,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (typeof WebAssembly === 'undefined') {
          return { available: false, reason: 'WebAssembly not supported' };
        }
        // Tor WASM is always potentially available, but needs the WASM binary loaded
        return { available: true, requiresBinary: true };
      }
    },

    wispProtocol: {
      name: 'wisp-protocol',
      tier: 'copper',
      priority: 11,
      requiresServiceWorker: false,
      requiresWASM: true,
      requiresExternalRelay: true,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 1000,
      latency: 100,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (typeof WebSocket === 'undefined') {
          return { available: false, reason: 'WebSocket not available' };
        }
        return { available: true, requiresRelay: true };
      }
    },

    iframeVisual: {
      name: 'iframe-visual',
      tier: 'fallback',
      priority: 12,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 0,
      latency: 0,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        // Always available as last resort
        return { available: true };
      }
    },

    serviceWorkerCors: {
      name: 'sw-cors',
      tier: 'gold',
      priority: 0,
      requiresServiceWorker: true,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: true,
      maxThroughput: 50000,
      latency: 5,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
      async detect() {
        if (!('serviceWorker' in navigator)) {
          return { available: false, reason: 'ServiceWorker not supported' };
        }
        if (!navigator.serviceWorker.controller) {
          return { available: false, reason: 'No active ServiceWorker controller' };
        }
        return { available: true };
      }
    },
  };

  // ═══════════════════════════════════════════════════════
  // Detection engine
  // ═══════════════════════════════════════════════════════

  /**
   * Detect all available transports in parallel.
   * @param {Object} options
   * @param {number} options.timeout - Max detection time per transport (ms). Default 5000.
   * @param {string[]} options.only - Only check specific transport names.
   * @param {boolean} options.includeExperimental - Include experimental transports. Default true.
   * @returns {Promise<Array>} Sorted array of transport results (best first)
   */
  async function detectAll(options = {}) {
    const timeout = options.timeout || 5000;
    const only = options.only || null;
    const includeExperimental = options.includeExperimental !== false;

    // Determine which transports to probe
    let transportsToProbe = Object.keys(transportDefinitions);
    if (only) {
      transportsToProbe = transportsToProbe.filter(name => only.includes(name));
    }
    if (!includeExperimental) {
      transportsToProbe = transportsToProbe.filter(name => {
        const def = transportDefinitions[name];
        return def && def.tier !== 'experimental';
      });
    }

    console.log('[DETECTOR] Probing ' + transportsToProbe.length + ' transports...');

    // Probe all in parallel with timeout
    const results = await Promise.all(
      transportsToProbe.map(async (name) => {
        const def = transportDefinitions[name];
        if (!def) return null;

        try {
          const probe = await Promise.race([
            def.detect(),
            new Promise(resolve =>
              setTimeout(() => resolve({ available: false, reason: 'Probe timeout' }), timeout)
            ),
          ]);

          return {
            name: def.name,
            tier: def.tier,
            priority: def.priority,
            available: probe.available,
            reason: probe.reason || null,
            requiresServiceWorker: def.requiresServiceWorker,
            requiresWASM: def.requiresWASM,
            requiresExternalRelay: def.requiresExternalRelay,
            requiresLocalHelper: def.requiresLocalHelper,
            supportsEncrypted: def.supportsEncrypted,
            maxThroughput: def.maxThroughput,
            latency: def.latency,
            browserSupport: def.browserSupport,
            extra: probe.extra || {},
          };
        } catch (e) {
          return {
            name: def.name,
            tier: def.tier,
            priority: def.priority,
            available: false,
            reason: 'Detection error: ' + e.message,
            requiresServiceWorker: def.requiresServiceWorker,
            requiresWASM: def.requiresWASM,
            requiresExternalRelay: def.requiresExternalRelay,
            requiresLocalHelper: def.requiresLocalHelper,
            supportsEncrypted: def.supportsEncrypted,
            maxThroughput: def.maxThroughput,
            latency: def.latency,
            browserSupport: def.browserSupport,
            extra: {},
          };
        }
      })
    );

    // Filter nulls and sort by priority (best first)
    const sorted = results
      .filter(r => r !== null)
      .filter(r => r.available)
      .sort((a, b) => a.priority - b.priority);

    // Also return unavailable for diagnostics
    const unavailable = results
      .filter(r => r !== null)
      .filter(r => !r.available)
      .sort((a, b) => a.priority - b.priority);

    console.log('[DETECTOR] Found ' + sorted.length + ' available transports, ' + unavailable.length + ' unavailable');
    console.log('[DETECTOR] Best: ' + (sorted[0] ? sorted[0].name + ' (' + sorted[0].tier + ')' : 'none'));

    return { available: sorted, unavailable, best: sorted[0] || null };
  }

  /**
   * Quick detect: returns the single best available transport.
   * Stops probing once a gold-tier transport is found.
   * @returns {Promise<Object|null>}
   */
  async function quickDetect() {
    // Check gold tiers first, sequentially
    const goldOrder = ['swCors', 'directSockets'];

    for (const name of goldOrder) {
      const def = transportDefinitions[name];
      if (!def) continue;
      try {
        const result = await def.detect();
        if (result.available) {
          return {
            name: def.name,
            tier: def.tier,
            priority: def.priority,
            available: true,
            requiresServiceWorker: def.requiresServiceWorker,
            requiresWASM: def.requiresWASM,
            requiresExternalRelay: def.requiresExternalRelay,
            requiresLocalHelper: def.requiresLocalHelper,
            supportsEncrypted: def.supportsEncrypted,
            maxThroughput: def.maxThroughput,
            latency: def.latency,
            extra: result.extra || {},
          };
        }
      } catch (e) {}
    }

    // Fall back to full detection
    const all = await detectAll({ timeout: 3000 });
    return all.best;
  }

  /**
   * Get a transport definition by name.
   */
  function getDefinition(name) {
    return transportDefinitions[name] || null;
  }

  /**
   * Get human-readable summary of all transports.
   */
  function getSummary() {
    return Object.values(transportDefinitions).map(def => ({
      name: def.name,
      tier: def.tier,
      priority: def.priority,
      requires: [
        def.requiresServiceWorker && 'SW',
        def.requiresWASM && 'WASM',
        def.requiresExternalRelay && 'Relay',
        def.requiresLocalHelper && 'LocalBinary',
      ].filter(Boolean),
      throughput: def.maxThroughput > 0 ? (def.maxThroughput >= 1000
        ? (def.maxThroughput / 1000).toFixed(0) + ' MB/s'
        : def.maxThroughput + ' KB/s') : 'N/A',
      latency: def.latency + 'ms',
      encrypted: def.supportsEncrypted,
      browsers: def.browserSupport.join(', '),
    }));
  }

  return {
    detectAll,
    quickDetect,
    getDefinition,
    getSummary,
    definitions: transportDefinitions,
  };

})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TransportDetector;
}
if (typeof window !== 'undefined') {
  window.TransportDetector = TransportDetector;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TransportDetector = TransportDetector;
}
