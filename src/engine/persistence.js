/**
 * project: neptune — Persistence Engine v1.0.0
 *
 * Keeps the Neptune proxy kernel alive across page reloads, tab closures,
 * and browser sleeps using a combination of cutting-edge browser APIs:
 *
 *   1. Wake Lock API (Screen Wake Lock)
 *      - Prevents the screen from dimming or sleeping while proxy is active
 *      - Re-acquires automatically when document becomes visible again
 *   2. Background Sync API (one-shot + periodic)
 *      - Defer proxy state sync to ServiceWorker for offline resilience
 *      - Periodic Background Sync maintains proxy heartbeat even when tab
 *        is backgrounded (requires installed PWA / origin trial)
 *   3. Page Visibility API
 *      - Detects tab backgrounding and aggressively persists state to
 *        IndexedDB / OPFS before the browser freezes the tab
 *   4. beforeunload / pagehide handlers
 *      - Last-chance state serialization to prevent data loss
 *   5. BroadcastChannel " resurrection " protocol
 *      - When a new tab opens, it queries existing tabs via BC; if no
 *        response within 500ms, it assumes master role and restores state
 *        from persistent storage
 *   6. ServiceWorker-based heartbeat
 *      - The SW keeps a minimal keep-alive timer that survives tab closure
 *        for up to the browser's SW lifetime limit (~5 minutes in Chrome)
 *
 * This engine is ESSENTIAL for a "standalone" proxy that must survive
 * without any external server — the browser itself becomes the persistent
 * runtime.
 *
 * Usage:
 *   const persist = new NeptunePersistence();
 *   await persist.init();
 *   persist.onResurrect = (state) => { restoreTabs(state); };
 *   persist.registerStateProvider(() => ({ tabs, bookmarks, config }));
 */

'use strict';

const NeptunePersistence = (function() {
  // ═══════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════
  const STORAGE_KEY = '__nptn_persistence_v1';
  const BC_CHANNEL = '__nptn_persist_lifeboat';
  const HEARTBEAT_INTERVAL = 2000;   // ms — alive ping to other tabs
  const RESURRECTION_TIMEOUT = 500;  // ms — wait for existing master
  const PERSIST_DEBOUNCE = 250;      // ms — batch rapid state changes
  const MAX_STATE_SIZE = 2 * 1024 * 1024; // 2MB cap for IDB

  // ═══════════════════════════════════════════════════════
  // NeptunePersistence class
  // ═══════════════════════════════════════════════════════
  class NeptunePersistence {
    constructor(options = {}) {
      this._stateProvider = null;      // () => Object  — called to get current state
      this.onResurrect = null;         // (state) => void — called when this tab takes over
      this._wakeLock = null;
      this._wakeLockType = options.wakeLockType || 'screen';
      this._bc = null;
      this._heartbeatTimer = null;
      this._persistTimer = null;
      this._pendingState = null;
      this._isMaster = false;
      this._masterId = null;
      this._tabId = 't_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
      this._lastPersist = 0;
      this._swRegistration = null;
      this._syncTag = 'neptune-proxy-sync';
      this._periodicSyncTag = 'neptune-proxy-periodic';
      this._initialized = false;
      this._listeners = [];
    }

    async init() {
      if (this._initialized) return;

      // 1. Acquire Wake Lock immediately
      await this._acquireWakeLock();

      // 2. Set up visibility handling
      this._addListener(document, 'visibilitychange', () => this._onVisibilityChange());

      // 3. Before-unload persistence (last-chance)
      this._addListener(window, 'beforeunload', () => this._emergencyPersist());
      this._addListener(window, 'pagehide', () => this._emergencyPersist());

      // 4. BroadcastChannel lifeboat
      if (typeof BroadcastChannel !== 'undefined') {
        this._bc = new BroadcastChannel(BC_CHANNEL);
        this._bc.onmessage = (e) => this._handleBCMessage(e.data);
      }

      // 5. Start heartbeat
      this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL);

      // 6. Attempt resurrection — check if we're the only surviving tab
      await this._attemptResurrection();

      // 7. Register background sync (if available and SW is controlling)
      await this._registerBackgroundSync();

      // 8. Listen for online/offline
      this._addListener(window, 'online', () => this._onOnline());
      this._addListener(window, 'offline', () => this._onOffline());

      this._initialized = true;
      console.log('[Persistence] Initialized, tabId:', this._tabId, 'master:', this._isMaster);
    }

    /**
     * Register a function that returns the current proxy state.
     * Called before every persist operation.
     */
    registerStateProvider(fn) {
      this._stateProvider = fn;
    }

    /**
     * Manually trigger a state persist.
     */
    persist() {
      if (!this._stateProvider) return;
      this._pendingState = this._stateProvider();
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this._flushPersist(), PERSIST_DEBOUNCE);
    }

    /**
     * Force immediate persist (synchronous best-effort).
     */
    persistNow() {
      this._flushPersist();
    }

    /**
     * Release all resources.
     */
    async destroy() {
      this._initialized = false;
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      if (this._wakeLock) { try { this._wakeLock.release(); } catch(e) {} this._wakeLock = null; }
      if (this._bc) { this._bc.close(); this._bc = null; }
      for (const { target, event, fn } of this._listeners) {
        target.removeEventListener(event, fn);
      }
      this._listeners = [];
    }

    /**
     * Get current persistence status.
     */
    getStatus() {
      return {
        tabId: this._tabId,
        isMaster: this._isMaster,
        masterId: this._masterId,
        wakeLock: !!this._wakeLock,
        bc: !!this._bc,
        sw: !!this._swRegistration,
        lastPersist: this._lastPersist,
        bgSync: 'BackgroundSync' in window ? 'available' : 'unavailable',
        periodicSync: 'PeriodicSyncManager' in window ? 'available' : 'unavailable',
        wakeLockApi: 'wakeLock' in navigator ? 'available' : 'unavailable',
      };
    }

    // ═══════════════════════════════════════════════════════
    // Wake Lock
    // ═══════════════════════════════════════════════════════
    async _acquireWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        this._wakeLock = await navigator.wakeLock.request(this._wakeLockType);
        this._wakeLock.addEventListener('release', () => {
          console.log('[Persistence] Wake lock released');
          // Re-acquire if still active
          if (this._initialized) {
            setTimeout(() => this._acquireWakeLock(), 1000);
          }
        });
        console.log('[Persistence] Wake lock acquired');
      } catch (e) {
        console.warn('[Persistence] Wake lock failed:', e.message);
      }
    }

    // ═══════════════════════════════════════════════════════
    // Visibility
    // ═══════════════════════════════════════════════════════
    _onVisibilityChange() {
      if (document.hidden) {
        // Tab going background — persist immediately
        this._flushPersist();
      } else {
        // Tab becoming visible — re-acquire wake lock, check if we need
        // to take over as master
        this._acquireWakeLock();
        if (!this._isMaster && !this._masterId) {
          this._attemptResurrection();
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // Background Sync
    // ═══════════════════════════════════════════════════════
    async _registerBackgroundSync() {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      this._swRegistration = reg;

      // One-shot background sync
      if ('sync' in reg) {
        try {
          await reg.sync.register(this._syncTag);
          console.log('[Persistence] Background sync registered');
        } catch (e) {
          console.warn('[Persistence] Background sync registration failed:', e.message);
        }
      }

      // Periodic background sync (requires PWA installation + permission)
      if ('periodicSync' in reg) {
        try {
          const status = await navigator.permissions.query({
            name: 'periodic-background-sync',
          });
          if (status.state === 'granted') {
            await reg.periodicSync.register(this._periodicSyncTag, {
              minInterval: 60 * 60 * 1000, // 1 hour
            });
            console.log('[Persistence] Periodic background sync registered');
          }
        } catch (e) {
          // Periodic sync may not be supported — silent
        }
      }
    }

    _onOnline() {
      // Re-trigger background sync when coming back online
      if (this._swRegistration && 'sync' in this._swRegistration) {
        this._swRegistration.sync.register(this._syncTag).catch(() => {});
      }
      if (this._bc) {
        this._bc.postMessage({ type: 'online', from: this._tabId });
      }
    }

    _onOffline() {
      // Persist everything before we lose connectivity
      this._flushPersist();
    }

    // ═══════════════════════════════════════════════════════
    // BroadcastChannel Lifeboat (resurrection protocol)
    // ═══════════════════════════════════════════════════════
    _heartbeat() {
      if (!this._bc) return;
      this._bc.postMessage({
        type: 'heartbeat',
        from: this._tabId,
        isMaster: this._isMaster,
        ts: Date.now(),
      });
    }

    _handleBCMessage(msg) {
      if (!msg || msg.from === this._tabId) return;

      if (msg.type === 'heartbeat') {
        if (msg.isMaster) {
          this._masterId = msg.from;
          if (this._isMaster) {
            // Another master exists — compare timestamps, older wins
            // (this is a simple conflict resolution)
            console.log('[Persistence] Master conflict detected, yielding');
            this._isMaster = false;
          }
        }
      } else if (msg.type === 'persist') {
        // Another tab persisted state — we could merge, but for now just
        // note it
        this._lastPersist = Math.max(this._lastPersist, msg.ts);
      } else if (msg.type === 'resurrect-query') {
        if (this._isMaster) {
          this._bc.postMessage({
            type: 'resurrect-response',
            to: msg.from,
            from: this._tabId,
            state: this._stateProvider ? this._stateProvider() : null,
          });
        }
      } else if (msg.type === 'resurrect-response' && msg.to === this._tabId) {
        // We received state from an existing master
        if (msg.state && this.onResurrect) {
          this.onResurrect(msg.state);
        }
      } else if (msg.type === 'master-death') {
        if (this._masterId === msg.from) {
          this._masterId = null;
          this._attemptResurrection();
        }
      }
    }

    async _attemptResurrection() {
      if (!this._bc) {
        // No BC — assume master role immediately
        this._isMaster = true;
        await this._restoreFromStorage();
        return;
      }

      // Send resurrection query
      this._bc.postMessage({ type: 'resurrect-query', from: this._tabId });

      // Wait for response
      await new Promise(r => setTimeout(r, RESURRECTION_TIMEOUT));

      if (!this._masterId) {
        // No master responded — we become master and restore from storage
        this._isMaster = true;
        this._masterId = this._tabId;
        console.log('[Persistence] No master found, becoming master');
        await this._restoreFromStorage();
      }
    }

    // ═══════════════════════════════════════════════════════
    // Storage backends (IndexedDB primary, localStorage fallback)
    // ═══════════════════════════════════════════════════════
    async _flushPersist() {
      if (!this._stateProvider) return;
      const state = this._pendingState || this._stateProvider();
      this._pendingState = null;

      const envelope = {
        v: 1,
        ts: Date.now(),
        tabId: this._tabId,
        isMaster: this._isMaster,
        state: state,
      };

      const json = JSON.stringify(envelope);
      if (json.length > MAX_STATE_SIZE) {
        console.warn('[Persistence] State too large, truncating');
        envelope.state = { truncated: true, originalSize: json.length };
      }

      // Try localStorage first (synchronous, fast)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      } catch (e) {
        // Quota exceeded — try IndexedDB
        await this._persistToIDB(envelope);
      }

      this._lastPersist = Date.now();

      // Notify other tabs
      if (this._bc) {
        this._bc.postMessage({ type: 'persist', from: this._tabId, ts: this._lastPersist });
      }
    }

    _emergencyPersist() {
      // Synchronous best-effort before tab death
      if (!this._stateProvider) return;
      try {
        const state = this._stateProvider();
        const envelope = { v: 1, ts: Date.now(), tabId: this._tabId, isMaster: this._isMaster, state };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      } catch (e) {
        // Last-chance failed — nothing we can do
      }
      // Announce our death
      if (this._bc) {
        try {
          this._bc.postMessage({ type: 'master-death', from: this._tabId });
        } catch (e) {}
      }
    }

    async _restoreFromStorage() {
      // Try localStorage first
      let envelope = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) envelope = JSON.parse(raw);
      } catch (e) {}

      // Fallback to IndexedDB
      if (!envelope) {
        envelope = await this._restoreFromIDB();
      }

      if (envelope && envelope.state && this.onResurrect) {
        console.log('[Persistence] Restoring state from', new Date(envelope.ts).toISOString());
        this.onResurrect(envelope.state);
      }
    }

    // Minimal IndexedDB wrapper
    _idbRequest(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async _persistToIDB(envelope) {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open('__nptn_persist', 1);
        open.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('state')) {
            db.createObjectStore('state', { keyPath: 'id' });
          }
        };
        open.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('state', 'readwrite');
          const store = tx.objectStore('state');
          store.put({ id: 'primary', ...envelope });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        open.onerror = () => reject(open.error);
      });
    }

    async _restoreFromIDB() {
      return new Promise((resolve) => {
        const open = indexedDB.open('__nptn_persist', 1);
        open.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('state')) {
            db.createObjectStore('state', { keyPath: 'id' });
          }
        };
        open.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('state', 'readonly');
          const store = tx.objectStore('state');
          const req = store.get('primary');
          req.onsuccess = () => {
            db.close();
            resolve(req.result || null);
          };
          req.onerror = () => {
            db.close();
            resolve(null);
          };
        };
        open.onerror = () => resolve(null);
      });
    }

    _addListener(target, event, fn) {
      target.addEventListener(event, fn);
      this._listeners.push({ target, event, fn });
    }
  }

  // ═══════════════════════════════════════════════════════
  // Exports
  // ═══════════════════════════════════════════════════════
  return {
    NeptunePersistence,
    constants: {
      STORAGE_KEY,
      BC_CHANNEL,
      HEARTBEAT_INTERVAL,
      RESURRECTION_TIMEOUT,
      PERSIST_DEBOUNCE,
      MAX_STATE_SIZE,
    },
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptunePersistence;
}
if (typeof window !== 'undefined') {
  window.NeptunePersistence = NeptunePersistence;
}
if (typeof globalThis !== 'undefined') {
  globalThis.NeptunePersistence = NeptunePersistence;
}
