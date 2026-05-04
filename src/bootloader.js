/**
 * project: neptune — Bootloader v1.0.0
 *
 * Handles the SVG boot sequence:
 *   1. Decode embedded base64 artifacts
 *   2. Register ServiceWorker from blob URL
 *   3. Load WASM kernel (smoltcp TCP/IP stack)
 *   4. Run TransportDetector to find best transport
 *   5. Initialize NetworkAdapter bridge
 *   6. Wire up UI chrome
 *   7. Handle ?url= and ?transport= query params
 *
 * This runs inside the SVG's <script> section after all
 * embedded artifacts (SW, WASM, fingerprint, transports, engine, ui)
 * have been decoded and injected.
 */

'use strict';

const NeptuneBoot = (function() {
  const L = { DBG: 0, INF: 1, WRN: 2, ERR: 3 };
  const C = ['#555', '#00ff88', '#ffaa00', '#ff4444'];

  let logFn = function(l, msg) { console.log(['[BOOT DBG]', '[BOOT]', '[BOOT WRN]', '[BOOT ERR]'][l] + ' ' + msg); };
  let bootStatusEl = null;

  // Boot phases with timing
  const phases = [];
  let bootStartTime = 0;

  function setStatus(msg) {
    if (bootStatusEl) bootStatusEl.textContent = msg;
    logFn(L.INF, msg);
  }

  function recordPhase(name, ok, detail) {
    phases.push({ name, ok, detail, elapsed: Date.now() - bootStartTime });
  }

  /**
   * Main boot sequence. Called by template.svg after DOM is ready.
   * @param {Object} opts
   * @param {Object} opts.artifacts - Decoded base64 artifacts { swCode, wasmJs, wasmBin, ... }
   * @param {Object} opts.dom - DOM references { bootOverlay, bootStatus, ... }
   * @param {Function} opts.onReady - Called when boot completes
   * @param {Object} opts.config - Initial config
   */
  async function boot(opts = {}) {
    bootStartTime = Date.now();
    const artifacts = opts.artifacts || {};
    const dom = opts.dom || {};
    const onReady = opts.onReady || function() {};
    const config = opts.config || {};

    bootStatusEl = dom.bootStatus;
    const bootOverlay = dom.bootOverlay;

    if (bootOverlay) bootOverlay.style.display = 'flex';

    try {
      // ── Phase 1: Validate artifacts ─────────────────
      setStatus('Validating artifacts...');
      const checks = [
        ['SW_CODE', artifacts.swCode],
        ['WASM_BIN', artifacts.wasmBin],
        ['FINGERPRINT_JS', artifacts.fingerprintJs],
        ['TRANSPORT_DETECTOR', artifacts.transportDetector],
      ];
      const missing = checks.filter(c => !c[1] || c[1] === '{{' + c[0] + '}}');
      if (missing.length > 0) {
        recordPhase('validate', false, 'Missing: ' + missing.map(m => m[0]).join(', '));
        setStatus('Build incomplete — rebuild with: python3 build.py');
        return false;
      }
      recordPhase('validate', true, 'All artifacts present');

      // ── Phase 2: Register ServiceWorker ──────────────
      setStatus('Registering ServiceWorker...');
      const swReady = await bootSW(artifacts.swCode, config);
      recordPhase('sw', swReady, swReady ? 'Active' : 'Failed');

      // ── Phase 3: Load WASM kernel ────────────────────
      setStatus('Loading WASM kernel...');
      const kernelReady = await bootWasm(artifacts.wasmJs, artifacts.wasmBin);
      recordPhase('wasm', kernelReady, kernelReady ? 'Loaded' : 'Missing/unavailable');

      // ── Phase 4: Load fingerprint engine ─────────────
      setStatus('Loading fingerprint engine...');
      const fpReady = bootFingerprint(artifacts.fingerprintJs);
      recordPhase('fingerprint', fpReady, fpReady ? 'Loaded' : 'Missing');

      // ── Phase 5: Load transport detector ─────────────
      setStatus('Detecting transports...');
      const transports = await bootTransports(
        artifacts.transportDetector,
        artifacts.transportModules || {}
      );
      recordPhase('transports', transports.best !== null,
        transports.best ? transports.best.name + ' (' + transports.best.tier + ')' : 'None available');

      // ── Phase 6: Load engine modules ─────────────────
      setStatus('Loading engine modules...');
      const engineReady = bootEngine(artifacts.engineModules || {});
      recordPhase('engine', engineReady, 'Engine modules loaded');

      // ── Phase 7: Load UI modules ─────────────────────
      setStatus('Loading UI modules...');
      const uiReady = bootUI(artifacts.uiModules || {});
      recordPhase('ui', uiReady, 'UI modules loaded');

      // ── Phase 8: Network adapter ─────────────────────
      setStatus('Initializing network adapter...');
      const netAdapterReady = bootNetworkAdapter(artifacts.networkAdapter, artifacts.netStack);
      recordPhase('network', netAdapterReady, netAdapterReady ? 'Ready' : 'Missing WASM stack');

      // ── Phase 9: Parse URL params ────────────────────
      const params = parseQueryParams();
      recordPhase('params', true, params.url ? 'url=' + params.url : 'No URL');

      // ── Hide boot overlay ────────────────────────────
      if (bootOverlay) {
        bootOverlay.style.opacity = '0';
        bootOverlay.style.transition = 'opacity 0.4s';
        setTimeout(function() { bootOverlay.style.display = 'none'; }, 400);
      }

      // ── Finalize ─────────────────────────────────────
      const bootResult = {
        success: true,
        phases: phases,
        totalMs: Date.now() - bootStartTime,
        swReady: swReady,
        kernelReady: kernelReady,
        fingerprintReady: fpReady,
      };

      setStatus('Neptune v3.0.0 ready — ' + (Date.now() - bootStartTime) + 'ms');

      onReady(bootResult, transports, params, config);
      return bootResult;

    } catch (e) {
      recordPhase('boot', false, e.message);
      setStatus('Boot failed: ' + e.message);
      console.error('[BOOT] Fatal:', e);
      return { success: false, error: e.message, phases };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Phase implementations
  // ═══════════════════════════════════════════════════════

  async function bootSW(swCode, config) {
    if (!('serviceWorker' in navigator)) return false;
    if (!swCode) return false;

    try {
      // Decode base64 SW code
      const decoded = atob(swCode);

      // Create blob URL for SW
      const blob = new Blob([decoded], { type: 'application/javascript' });
      const swUrl = URL.createObjectURL(blob);

      // Register from blob URL
      const reg = await navigator.serviceWorker.register(swUrl, {
        scope: './',
        updateViaCache: 'none',
      });

      // Wait for activation
      await new Promise(function(resolve) {
        var sw = reg.installing || reg.waiting || reg.active;
        if (!sw || sw.state === 'activated') { resolve(); return; }
        sw.addEventListener('statechange', function(e) {
          if (e.target.state === 'activated') resolve();
        });
      });

      // Wait for controller
      if (!navigator.serviceWorker.controller) {
        await new Promise(function(resolve) {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        });
      }

      // Send config
      if (navigator.serviceWorker.controller && config) {
        navigator.serviceWorker.controller.postMessage({
          type: 'SET_CONFIG',
          ...config,
        });
      }

      return true;
    } catch (e) {
      logFn(L.ERR, 'SW boot failed: ' + e.message);
      return false;
    }
  }

  async function bootWasm(wasmJsB64, wasmBinB64) {
    if (!wasmJsB64 || !wasmBinB64) return false;
    if (!('WebAssembly' in window)) return false;

    try {
      // Decode WASM binary
      const wasmBytes = Uint8Array.from(atob(wasmBinB64), function(c) { return c.charCodeAt(0); });
      const wasmResp = new Response(wasmBytes.buffer, {
        headers: { 'Content-Type': 'application/wasm' },
      });

      // Decode JS glue
      const jsCode = atob(wasmJsB64);
      const jsBlob = new Blob([jsCode], { type: 'text/javascript' });
      const jsUrl = URL.createObjectURL(jsBlob);

      // Dynamic import
      const mod = await import(jsUrl);

      // Initialize WASM
      if (mod.default) {
        try { await mod.default(wasmResp); } catch (e) { logFn(L.WRN, 'WASM init: ' + e.message); }
      }

      // Store references globally for other modules
      if (mod.NeptuneKernel) {
        window.__nptn_kernel = new mod.NeptuneKernel();
      }
      if (mod.NeptuneNetStack) {
        window.__nptn_netStack = new mod.NeptuneNetStack(function() {});
      }

      URL.revokeObjectURL(jsUrl);
      return true;
    } catch (e) {
      logFn(L.ERR, 'WASM boot failed: ' + e.message);
      return false;
    }
  }

  function bootFingerprint(fpCodeB64) {
    if (!fpCodeB64) return false;
    try {
      const decoded = atob(fpCodeB64);
      // Store for SW to inject into pages
      window.__nptn_fingerprintCode = decoded;

      // Execute locally for the chrome UI itself
      try { eval(decoded); } catch (e) { logFn(L.WRN, 'Fingerprint local exec: ' + e.message); }

      return true;
    } catch (e) {
      logFn(L.ERR, 'Fingerprint boot failed: ' + e.message);
      return false;
    }
  }

  async function bootTransports(detectorCode, transportModules) {
    if (!detectorCode) return { available: [], unavailable: [], best: null };

    try {
      // Execute the TransportDetector code
      eval(atob(detectorCode));

      // Execute transport module implementations
      for (const [name, codeB64] of Object.entries(transportModules)) {
        try {
          eval(atob(codeB64));
        } catch (e) {
          logFn(L.WRN, 'Transport ' + name + ' load failed: ' + e.message);
        }
      }

      // Run detection
      if (window.TransportDetector) {
        window.__nptn_transportDetector = window.TransportDetector;
        const result = await window.TransportDetector.detectAll({
          timeout: 5000,
          includeExperimental: true,
        });
        window.__nptn_transports = result;
        return result;
      }

      return { available: [], unavailable: [], best: null };
    } catch (e) {
      logFn(L.ERR, 'Transport boot failed: ' + e.message);
      return { available: [], unavailable: [], best: null };
    }
  }

  function bootEngine(engineModules) {
    let loaded = 0;
    const decoded = {};
    for (const [name, codeB64] of Object.entries(engineModules)) {
      try {
        const src = atob(codeB64);
        eval(src);
        decoded[name] = src;
        loaded++;
      } catch (e) {
        logFn(L.WRN, 'Engine module ' + name + ' failed: ' + e.message);
      }
    }
    // Send engine modules to ServiceWorker so it can use injected modules
    if (loaded > 0 && navigator.serviceWorker && navigator.serviceWorker.controller) {
      try {
        navigator.serviceWorker.controller.postMessage({
          type: 'SET_MODULES',
          modules: decoded,
        });
        logFn(L.INF, 'Sent ' + loaded + ' engine modules to SW');
      } catch (e) {
        logFn(L.WRN, 'Failed to send engine modules to SW: ' + e.message);
      }
    }
    return loaded > 0;
  }

  function bootUI(uiModules) {
    let loaded = 0;
    for (const [name, codeB64] of Object.entries(uiModules)) {
      try {
        if (name.endsWith('.css')) {
          // Inject CSS
          const css = atob(codeB64);
          const style = document.createElement('style');
          style.id = '__nptn_ui_' + name.replace('.css', '');
          style.textContent = css;
          document.head.appendChild(style);
          loaded++;
        } else {
          eval(atob(codeB64));
          loaded++;
        }
      } catch (e) {
        logFn(L.WRN, 'UI module ' + name + ' failed: ' + e.message);
      }
    }
    return loaded > 0;
  }

  function bootNetworkAdapter(adapterCode, netStack) {
    if (!adapterCode) return false;
    try {
      eval(atob(adapterCode));
      if (window.NetworkAdapter && (netStack || window.__nptn_netStack)) {
        const stack = netStack || window.__nptn_netStack;
        const adapter = new window.NetworkAdapter(stack);
        window.__nptn_networkAdapter = adapter;
        adapter.start();
        return true;
      }
      return false;
    } catch (e) {
      logFn(L.ERR, 'Network adapter boot failed: ' + e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════

  function parseQueryParams() {
    const params = {};
    try {
      const search = window.location.search;
      const sp = new URLSearchParams(search);
      params.url = sp.get('url') || null;
      params.transport = sp.get('transport') || null;
      params.__nptn = sp.get('__nptn') || null;
    } catch (e) {}
    return params;
  }

  function getBootReport() {
    return {
      phases: phases,
      totalMs: Date.now() - bootStartTime,
      transports: window.__nptn_transports || null,
      kernel: !!window.__nptn_kernel,
      netStack: !!window.__nptn_netStack,
      adapter: !!window.__nptn_networkAdapter,
    };
  }

  return {
    boot,
    getBootReport,
    phases: phases,
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneBoot;
}
if (typeof window !== 'undefined') {
  window.NeptuneBoot = NeptuneBoot;
}
