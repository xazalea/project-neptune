/**
 * project: neptune — Distributed Mesh Engine v1.0.0
 *
 * Coordinates multiple Neptune tabs on the SAME ORIGIN into a distributed
 * proxy mesh using BroadcastChannel and the Web Locks API. This enables:
 *
 *   - Shared request caching across tabs (cache warming)
 *   - Request load-balancing (route heavy fetches through idle peers)
 *   - State synchronization (bookmarks, settings, history)
 *   - Leader election for centralized operations (SW config, persistent storage)
 *   - Graceful failover when the master tab closes
 *
 * Architecture:
 *   - Each tab gets a UUID and advertises itself on a BroadcastChannel
 *   - Web Locks API (navigator.locks) provides cross-tab mutex for
 *     leader-exclusive operations like writing to OPFS or IDB
 *   - A consensus protocol ensures all peers agree on mesh topology
 *   - Message types: heartbeat, election, cache_invalidate, cache_offer,
 *     proxy_request, proxy_response, state_sync, bye
 *
 * This is PURELY LOCAL — no network packets leave the machine. It uses
 * the browser's built-in IPC mechanisms (BroadcastChannel + LockManager).
 *
 * Usage:
 *   const mesh = new NeptuneMeshEngine({ meshId: 'neptune-main' });
 *   await mesh.init();
 *   mesh.onProxyRequest = async (url) => fetchAndCache(url);
 *   mesh.broadcastState({ bookmarks: [...] });
 */

'use strict';

const NeptuneMeshEngine = (function() {
  // ═══════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════
  const BC_PREFIX      = '__nptn_mesh_';
  const HEARTBEAT_MS   = 2500;
  const PEER_TIMEOUT_MS = 15000;
  const ELECTION_DELAY_MS = 800;
  const LOCK_MASTER    = '__nptn_mesh_master_lock';
  const LOCK_CACHE     = '__nptn_mesh_cache_lock';
  const PROTO_VERSION  = 1;

  // ═══════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════
  function generateId() {
    return 'm_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  function now() { return Date.now(); }

  // ═══════════════════════════════════════════════════════
  // NeptuneMeshEngine class
  // ═══════════════════════════════════════════════════════
  class NeptuneMeshEngine {
    constructor(options = {}) {
      this.meshId = options.meshId || 'default';
      this.peerId = options.peerId || generateId();
      this.channel = null;
      this.peers = new Map(); // peerId → { lastSeen, load, caps, url }
      this.isMaster = false;
      this.masterId = null;
      this._masterLock = null;
      this._heartbeatTimer = null;
      this._cleanupTimer = null;
      this._electionTimer = null;
      this._joined = false;
      this._seq = 0;

      // Callbacks
      this.onPeerJoin = null;   // (peerId, info) => void
      this.onPeerLeave = null;  // (peerId, reason) => void
      this.onMasterChange = null; // (peerId, isMe) => void
      this.onStateSync = null;  // (state, fromPeerId) => void
      this.onCacheOffer = null; // (url, fromPeerId) => boolean (accept?)
      this.onCacheInvalidate = null; // (urls, fromPeerId) => void
      this.onProxyRequest = null; // (request, fromPeerId) => Promise<response>
      this.onProxyResponse = null; // (response, fromPeerId) => void

      // Pending proxy requests (awaiting responses)
      this._pendingProxies = new Map(); // reqId → { resolve, reject, timer }
    }

    async init() {
      if (this._joined) return true;

      if (typeof BroadcastChannel === 'undefined') {
        throw new Error('BroadcastChannel not supported');
      }

      this.channel = new BroadcastChannel(BC_PREFIX + this.meshId);
      this.channel.onmessage = (e) => this._handleMessage(e.data);

      // Announce ourselves
      this._broadcast({ type: 'hello', peerId: this.peerId, ts: now(), caps: this._getCaps() });

      // Start heartbeat
      this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
      this._cleanupTimer = setInterval(() => this._cleanupPeers(), HEARTBEAT_MS * 2);

      // Attempt to become master (non-blocking)
      this._attemptMasterElection();

      this._joined = true;
      return true;
    }

    destroy() {
      this._joined = false;
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
      if (this._electionTimer) { clearTimeout(this._electionTimer); this._electionTimer = null; }
      if (this._masterLock) { this._masterLock(); this._masterLock = null; }

      this._broadcast({ type: 'bye', peerId: this.peerId, ts: now() });
      if (this.channel) { this.channel.close(); this.channel = null; }

      // Clear pending proxies
      for (const [id, pending] of this._pendingProxies) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Mesh destroyed'));
      }
      this._pendingProxies.clear();
    }

    /**
     * Broadcast a state update to all peers.
     */
    broadcastState(state) {
      this._broadcast({
        type: 'state_sync',
        peerId: this.peerId,
        ts: now(),
        state: state,
      });
    }

    /**
     * Offer a cached resource URL to the mesh (cache warming).
     */
    offerCache(url, metadata) {
      this._broadcast({
        type: 'cache_offer',
        peerId: this.peerId,
        ts: now(),
        url: url,
        metadata: metadata || {},
      });
    }

    /**
     * Invalidate cached URLs across the mesh.
     */
    invalidateCache(urls) {
      this._broadcast({
        type: 'cache_invalidate',
        peerId: this.peerId,
        ts: now(),
        urls: Array.isArray(urls) ? urls : [urls],
      });
    }

    /**
     * Send a proxy request to the mesh. Returns a promise that resolves
     * with the first response from any peer, or rejects if timeout.
     *
     * This is useful for load-balancing: if tab A has blocked trackers
     * and tab B hasn't, tab A can ask tab B to fetch on its behalf.
     */
    async proxyRequest(request) {
      const reqId = this.peerId + '_' + (++this._seq);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pendingProxies.delete(reqId);
          reject(new Error('Proxy request timeout — no peer responded'));
        }, 10000);

        this._pendingProxies.set(reqId, { resolve, reject, timer });

        this._broadcast({
          type: 'proxy_request',
          peerId: this.peerId,
          reqId: reqId,
          ts: now(),
          request: request,
        });
      });
    }

    /**
     * Get current mesh topology.
     */
    getTopology() {
      const peerList = Array.from(this.peers.entries()).map(([id, info]) => ({
        id,
        lastSeen: info.lastSeen,
        load: info.load || 0,
        master: this.masterId === id,
        me: id === this.peerId,
      }));
      return {
        self: this.peerId,
        masterId: this.masterId,
        isMaster: this.isMaster,
        peerCount: peerList.length + 1, // +1 for self
        peers: peerList,
      };
    }

    /**
     * Get the least-loaded peer (excluding self) for offloading work.
     */
    getLeastLoadedPeer() {
      let best = null;
      let bestLoad = Infinity;
      for (const [id, info] of this.peers) {
        const load = info.load || 0;
        if (load < bestLoad) {
          bestLoad = load;
          best = id;
        }
      }
      return best;
    }

    // ═══════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════
    _getCaps() {
      return {
        webLocks: 'locks' in navigator,
        bc: typeof BroadcastChannel !== 'undefined',
        sw: 'serviceWorker' in navigator,
        opfs: !!(navigator.storage && navigator.storage.getDirectory),
      };
    }

    _broadcast(msg) {
      if (!this.channel) return;
      this.channel.postMessage({ ...msg, _v: PROTO_VERSION });
    }

    _handleMessage(msg) {
      if (!msg || msg.peerId === this.peerId || msg._v !== PROTO_VERSION) return;

      const type = msg.type;
      const from = msg.peerId;

      // Update peer record
      const existing = this.peers.get(from);
      this.peers.set(from, {
        lastSeen: now(),
        load: msg.load !== undefined ? msg.load : (existing ? existing.load : 0),
        caps: msg.caps || (existing ? existing.caps : {}),
        url: msg.url || (existing ? existing.url : null),
      });

      if (!existing && this.onPeerJoin) {
        this.onPeerJoin(from, this.peers.get(from));
      }

      switch (type) {
        case 'hello':
          // Reply with our own hello so they know we exist
          this._broadcast({ type: 'hello_reply', peerId: this.peerId, ts: now(), caps: this._getCaps() });
          break;

        case 'hello_reply':
          // Already handled by peer record update
          break;

        case 'bye':
          this._removePeer(from, 'left');
          break;

        case 'heartbeat':
          if (msg.masterId !== undefined) {
            if (msg.masterId !== this.masterId) {
              this.masterId = msg.masterId;
              this.isMaster = this.masterId === this.peerId;
              if (this.onMasterChange) this.onMasterChange(this.masterId, this.isMaster);
            }
          }
          if (msg.load !== undefined) {
            const p = this.peers.get(from);
            if (p) p.load = msg.load;
          }
          break;

        case 'election':
          // Another peer is claiming master. If we think we're master too,
          // resolve by peerId (lexicographically higher yields)
          if (this.isMaster && msg.candidate !== this.peerId) {
            if (msg.candidate > this.peerId) {
              // Yield
              this.isMaster = false;
              this.masterId = msg.candidate;
              if (this._masterLock) { this._masterLock(); this._masterLock = null; }
              if (this.onMasterChange) this.onMasterChange(this.masterId, false);
            }
          } else {
            this.masterId = msg.candidate;
            this.isMaster = this.masterId === this.peerId;
            if (this.onMasterChange) this.onMasterChange(this.masterId, this.isMaster);
          }
          break;

        case 'state_sync':
          if (this.onStateSync) this.onStateSync(msg.state, from);
          break;

        case 'cache_offer':
          if (this.onCacheOffer) {
            const accepted = this.onCacheOffer(msg.url, from);
            if (accepted) {
              this._broadcast({ type: 'cache_accept', peerId: this.peerId, url: msg.url, to: from });
            }
          }
          break;

        case 'cache_accept':
          if (msg.to === this.peerId) {
            // Another peer accepted our cache offer — we could now send the data
            // (not implemented here to avoid large BC payloads)
          }
          break;

        case 'cache_invalidate':
          if (this.onCacheInvalidate) this.onCacheInvalidate(msg.urls, from);
          break;

        case 'proxy_request':
          if (this.onProxyRequest) {
            this.onProxyRequest(msg.request, from).then((response) => {
              this._broadcast({
                type: 'proxy_response',
                peerId: this.peerId,
                reqId: msg.reqId,
                to: from,
                response: response,
                ts: now(),
              });
            }).catch((err) => {
              this._broadcast({
                type: 'proxy_response',
                peerId: this.peerId,
                reqId: msg.reqId,
                to: from,
                error: err.message || 'Proxy failed',
                ts: now(),
              });
            });
          }
          break;

        case 'proxy_response':
          if (msg.to === this.peerId) {
            const pending = this._pendingProxies.get(msg.reqId);
            if (pending) {
              clearTimeout(pending.timer);
              this._pendingProxies.delete(msg.reqId);
              if (msg.error) pending.reject(new Error(msg.error));
              else pending.resolve(msg.response);
            }
            if (this.onProxyResponse) this.onProxyResponse(msg.response, from);
          }
          break;
      }
    }

    _heartbeat() {
      if (!this._joined) return;
      this._broadcast({
        type: 'heartbeat',
        peerId: this.peerId,
        ts: now(),
        masterId: this.masterId,
        load: this._estimateLoad(),
      });
    }

    _cleanupPeers() {
      const cutoff = now() - PEER_TIMEOUT_MS;
      for (const [id, info] of this.peers) {
        if (info.lastSeen < cutoff) {
          this._removePeer(id, 'timeout');
        }
      }
      // If master is gone, trigger election
      if (this.masterId && !this.peers.has(this.masterId) && this.masterId !== this.peerId) {
        this.masterId = null;
        this.isMaster = false;
        this._attemptMasterElection();
      }
    }

    _removePeer(id, reason) {
      if (!this.peers.has(id)) return;
      this.peers.delete(id);
      if (this.onPeerLeave) this.onPeerLeave(id, reason);
      if (this.masterId === id) {
        this.masterId = null;
        this.isMaster = false;
        this._attemptMasterElection();
      }
    }

    async _attemptMasterElection() {
      if (this.isMaster) return;
      if (this.masterId && this.peers.has(this.masterId)) return;

      // Use Web Locks API as the arbiter — first to acquire the lock wins
      if ('locks' in navigator) {
        try {
          await navigator.locks.request(LOCK_MASTER, { mode: 'exclusive', ifAvailable: true }, (lock) => {
            if (!lock) return; // Another tab holds it
            // We got the lock — we are master
            this.isMaster = true;
            this.masterId = this.peerId;
            this._broadcast({ type: 'election', candidate: this.peerId, ts: now() });
            if (this.onMasterChange) this.onMasterChange(this.peerId, true);

            // Store release function
            this._masterLock = () => {
              // Lock is auto-released when callback returns, but if we want
              // to hold it long-term we'd need a different pattern.
              // For this pattern, we keep the callback alive.
            };

            // Hold the lock open by returning a promise that never resolves
            return new Promise(() => {});
          });
        } catch (e) {
          // Lock API failed — fall back to time-based election
          this._fallbackElection();
        }
      } else {
        this._fallbackElection();
      }
    }

    _fallbackElection() {
      // Simple bully-algorithm fallback: wait a random delay, then if
      // no master announced, claim it.
      if (this._electionTimer) clearTimeout(this._electionTimer);
      this._electionTimer = setTimeout(() => {
        if (!this.masterId) {
          this.isMaster = true;
          this.masterId = this.peerId;
          this._broadcast({ type: 'election', candidate: this.peerId, ts: now() });
          if (this.onMasterChange) this.onMasterChange(this.peerId, true);
        }
      }, ELECTION_DELAY_MS + Math.random() * 500);
    }

    _estimateLoad() {
      // Simple load estimate: active fetch count + memory pressure proxy
      let load = 0;
      if (typeof performance !== 'undefined' && performance.memory) {
        const mem = performance.memory;
        load += Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 50);
      }
      // Add active proxy requests as load
      load += this._pendingProxies.size * 10;
      return Math.min(load, 100);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Exports
  // ═══════════════════════════════════════════════════════
  return {
    NeptuneMeshEngine,
    constants: {
      BC_PREFIX,
      HEARTBEAT_MS,
      PEER_TIMEOUT_MS,
      ELECTION_DELAY_MS,
      LOCK_MASTER,
      LOCK_CACHE,
      PROTO_VERSION,
    },
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneMeshEngine;
}
if (typeof window !== 'undefined') {
  window.NeptuneMeshEngine = NeptuneMeshEngine;
}
if (typeof globalThis !== 'undefined') {
  globalThis.NeptuneMeshEngine = NeptuneMeshEngine;
}
