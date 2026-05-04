/**
 * project: neptune — Web Locks API Coordination Bus v1.0.0
 * Track K: Web Locks API as Coordination Bus
 *
 * Coordinates multiple Neptune tabs/instances to avoid resource
 * contention. Uses navigator.locks for exclusive transport access
 * and BroadcastChannel for shared state propagation.
 *
 * Key features:
 *   - Supernode election: one tab acts as relay coordinator
 *   - Transport lock: prevents multiple tabs fighting over TURN allocations
 *   - Shared state: broadcast settings/tab changes to all instances
 *   - Graceful handoff: when supernode closes, next tab takes over
 */

'use strict';

class LocksTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      lockPrefix: 'neptune-lock-',
      stateChannel: 'neptune-state',
      coordinationChannel: 'neptune-coordination',
      supernodeTimeout: 15000,
      heartbeatInterval: 10000,
      electionTimeout: 5000,
    }, options);

    this.stateChannel = null;
    this.coordinationChannel = null;
    this.initialized = false;
    this.isSupernode = false;
    this.instanceId = 'neptune-' + Math.random().toString(36).substr(2, 8);
    this.heartbeatTimer = null;
    this.peerStates = new Map(); // instanceId → { role, lastSeen, capabilities }
    this.sharedState = {};
    this.pendingCallbacks = [];
    this.stats = {
      locksAcquired: 0,
      locksReleased: 0,
      locksTimedOut: 0,
      elections: 0,
      messagesSent: 0,
      messagesReceived: 0,
    };
  }

  // ── Detection ──────────────────────────────────────
  static async detect() {
    if (typeof navigator === 'undefined' || typeof navigator.locks === 'undefined') {
      return { available: false, reason: 'Web Locks API not available' };
    }
    return {
      available: true,
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      queryable: typeof navigator.locks.query === 'function',
    };
  }

  static getCapabilities() {
    return {
      name: 'web-locks',
      tier: 'auxiliary',
      priority: 1,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
    };
  }

  // ── Initialization ────────────────────────────────
  async init() {
    if (this.initialized) return true;

    // Set up BroadcastChannel for inter-tab communication
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.stateChannel = new BroadcastChannel(this.options.stateChannel);
        this.coordinationChannel = new BroadcastChannel(this.options.coordinationChannel);

        this.coordinationChannel.onmessage = (e) => this._onCoordinationMessage(e.data);
        this.stateChannel.onmessage = (e) => this._onStateMessage(e.data);

        // Announce presence
        this._broadcast('coordination', {
          type: 'peer-announce',
          instanceId: this.instanceId,
          capabilities: this._getLocalCapabilities(),
          timestamp: Date.now(),
        });
      } catch (e) {
        console.warn('[LOCKS] BroadcastChannel unavailable:', e.message);
      }
    }

    // Start heartbeat
    this.heartbeatTimer = setInterval(
      () => this._heartbeat(),
      this.options.heartbeatInterval
    );

    // Run election
    await this._runElection();

    this.initialized = true;
    console.log('[LOCKS] Initialized — ' + this.instanceId +
      (this.isSupernode ? ' [SUPERNODE]' : ' [follower]'));
    return true;
  }

  // ── Lock API ───────────────────────────────────────
  /**
   * Acquire an exclusive lock for a named resource.
   * Returns a release function.
   */
  async acquireLock(name, options = {}) {
    const lockName = this.options.lockPrefix + name;
    const timeout = options.timeout || 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.locksTimedOut++;
        reject(new Error(`Lock timeout: ${name}`));
      }, timeout);

      navigator.locks.request(lockName, { mode: 'exclusive' }, async (lock) => {
        clearTimeout(timer);
        this.stats.locksAcquired++;
        const startTime = Date.now();

        // Return a release callback
        resolve(async () => {
          this.stats.locksReleased++;
          const heldMs = Date.now() - startTime;
          console.log(`[LOCKS] Released "${name}" — held ${heldMs}ms`);
          // Lock auto-releases when callback returns
        });

        // Hold the lock open. navigator.locks will keep it alive
        // as long as the promise doesn't resolve, but we need to
        // resolve with the release function immediately. So we
        // create a held promise that never resolves until released.
        return new Promise((holdResolve) => {
          // Store the resolve function — called by the release function
          resolve.realRelease = holdResolve;
        });
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });

      // Patch the release to trigger holdResolve
      const origResolve = resolve;
      resolve = (releaseFn) => {
        const wrappedRelease = async () => {
          if (origResolve.realRelease) origResolve.realRelease();
          if (typeof releaseFn === 'function') await releaseFn();
        };
        origResolve(wrappedRelease);
      };
    });
  }

  /**
   * Acquire a shared (read) lock for a named resource.
   */
  async acquireSharedLock(name, options = {}) {
    const lockName = this.options.lockPrefix + 'shared-' + name;
    const timeout = options.timeout || 15000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Shared lock timeout: ${name}`));
      }, timeout);

      navigator.locks.request(lockName, { mode: 'shared' }, async () => {
        clearTimeout(timer);
        this.stats.locksAcquired++;

        // Hold until released
        return new Promise((holdResolve) => {
          resolve(async () => {
            this.stats.locksReleased++;
            holdResolve();
          });
        });
      }).catch(reject);
    });
  }

  /**
   * Query all held locks (for debugging).
   */
  async queryLocks() {
    if (typeof navigator.locks.query !== 'function') return [];
    try {
      const snapshot = await navigator.locks.query();
      return snapshot.held || [];
    } catch (e) {
      return [];
    }
  }

  // ── Supernode Coordination ─────────────────────────
  /**
   * Run supernode election. The instance with the lowest
   * instanceId (lexicographically) becomes supernode.
   */
  async _runElection() {
    this.stats.elections++;

    // Wait for peer announcements
    await new Promise(r => setTimeout(r, this.options.electionTimeout));

    let lowest = this.instanceId;
    for (const [id, peer] of this.peerStates) {
      if (peer.lastSeen > Date.now() - this.options.supernodeTimeout) {
        if (id < lowest) lowest = id;
      }
    }

    const wasSupernode = this.isSupernode;
    this.isSupernode = (lowest === this.instanceId);

    if (this.isSupernode && !wasSupernode) {
      console.log('[LOCKS] Elected SUPERNODE');
    } else if (!this.isSupernode && wasSupernode) {
      console.log('[LOCKS] Stepped down — new supernode:', lowest);
    }
  }

  /**
   * Heartbeat: announce liveness and prune stale peers.
   */
  _heartbeat() {
    // Announce
    this._broadcast('coordination', {
      type: 'peer-heartbeat',
      instanceId: this.instanceId,
      isSupernode: this.isSupernode,
      load: this._getLoad(),
      timestamp: Date.now(),
    });

    // Prune stale peers
    const cutoff = Date.now() - this.options.supernodeTimeout * 2;
    for (const [id, peer] of this.peerStates) {
      if (peer.lastSeen < cutoff) {
        this.peerStates.delete(id);
        console.log('[LOCKS] Peer timed out:', id);
      }
    }

    // Re-elect if supernode seems gone
    const supernodePeer = Array.from(this.peerStates.values())
      .find(p => p.isSupernode && p.lastSeen > Date.now() - this.options.supernodeTimeout);

    if (!supernodePeer && !this.isSupernode) {
      this._runElection().catch(() => {});
    }
  }

  // ── Shared State ───────────────────────────────────
  /**
   * Broadcast a state update to all peers.
   */
  setSharedState(key, value) {
    this.sharedState[key] = value;
    this._broadcast('state', {
      type: 'state-update',
      instanceId: this.instanceId,
      key,
      value,
      timestamp: Date.now(),
    });
  }

  getSharedState(key) {
    return this.sharedState[key];
  }

  getAllSharedState() {
    return { ...this.sharedState };
  }

  // ── Messaging ──────────────────────────────────────
  _onCoordinationMessage(msg) {
    if (!msg || msg.instanceId === this.instanceId) return;
    this.stats.messagesReceived++;

    switch (msg.type) {
      case 'peer-announce':
        this.peerStates.set(msg.instanceId, {
          role: 'peer',
          capabilities: msg.capabilities || {},
          isSupernode: false,
          lastSeen: Date.now(),
          load: 0,
        });
        console.log('[LOCKS] Peer discovered:', msg.instanceId);
        this._runElection().catch(() => {});
        break;

      case 'peer-heartbeat':
        const peer = this.peerStates.get(msg.instanceId);
        if (peer) {
          peer.lastSeen = Date.now();
          peer.isSupernode = msg.isSupernode || false;
          peer.load = msg.load || 0;
        } else {
          this.peerStates.set(msg.instanceId, {
            role: 'peer',
            capabilities: {},
            isSupernode: msg.isSupernode || false,
            lastSeen: Date.now(),
            load: msg.load || 0,
          });
        }
        break;

      case 'peer-goodbye':
        this.peerStates.delete(msg.instanceId);
        console.log('[LOCKS] Peer departed:', msg.instanceId);
        this._runElection().catch(() => {});
        break;
    }
  }

  _onStateMessage(msg) {
    if (!msg || msg.instanceId === this.instanceId) return;
    this.stats.messagesReceived++;

    if (msg.type === 'state-update') {
      this.sharedState[msg.key] = msg.value;
      // Notify any registered listeners
      for (const cb of this.pendingCallbacks) {
        try { cb(msg.key, msg.value); } catch (e) {}
      }
    }
  }

  onStateChange(callback) {
    this.pendingCallbacks.push(callback);
  }

  _broadcast(channel, msg) {
    const ch = channel === 'state' ? this.stateChannel : this.coordinationChannel;
    if (ch) {
      try {
        ch.postMessage(msg);
        this.stats.messagesSent++;
      } catch (e) {}
    }
  }

  // ── Utilities ──────────────────────────────────────
  _getLocalCapabilities() {
    return {
      serviceWorker: 'serviceWorker' in navigator,
      webRTC: typeof RTCPeerConnection !== 'undefined',
      webLocks: true,
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      fileSystem: typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',
      webCodecs: typeof VideoEncoder !== 'undefined',
      webGPU: typeof navigator !== 'undefined' && typeof navigator.gpu !== 'undefined',
    };
  }

  _getLoad() {
    return {
      tabs: typeof document !== 'undefined' ? 1 : 0,
      memoryEstimate: typeof performance !== 'undefined' && performance.memory
        ? performance.memory.usedJSHeapSize : 0,
    };
  }

  getStats() {
    return {
      ...this.stats,
      isSupernode: this.isSupernode,
      instanceId: this.instanceId,
      peerCount: this.peerStates.size,
      peers: Array.from(this.peerStates.entries()).map(([id, p]) => ({
        id,
        isSupernode: p.isSupernode,
        lastSeen: p.lastSeen,
        age: Date.now() - p.lastSeen,
      })),
      initialized: this.initialized,
    };
  }

  async destroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this._broadcast('coordination', {
      type: 'peer-goodbye',
      instanceId: this.instanceId,
      timestamp: Date.now(),
    });

    if (this.stateChannel) {
      try { this.stateChannel.close(); } catch (e) {}
      this.stateChannel = null;
    }
    if (this.coordinationChannel) {
      try { this.coordinationChannel.close(); } catch (e) {}
      this.coordinationChannel = null;
    }

    this.peerStates.clear();
    this.initialized = false;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocksTransport;
}
if (typeof window !== 'undefined') {
  window.LocksTransport = LocksTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.LocksTransport = LocksTransport;
}
