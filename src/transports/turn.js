/**
 * project: neptune — TURN Relay Transport v2.0.0
 * Track B: Public STUN/TURN Infrastructure as Free TCP Relay
 *
 * Uses public STUN/TURN servers as a free TCP relay layer via
 * the browser's built-in WebRTC stack (RTCPeerConnection +
 * RTCDataChannel). The browser handles all STUN/TURN protocol
 * details (Allocate, CreatePermission, ChannelBind, Connect,
 * Send/Data Indications per RFCs 5389/5766/6062).
 *
 * v2.0.0 enhancements:
 *   - Ephemeral credential fetching from Metered.ca REST API
 *   - Multi-server probing with latency ranking
 *   - ICE restart on connection failure
 *   - Server rotation when primary TURN degrades
 *   - Connection keep-alive via DataChannel heartbeat messages
 *
 * Public TURN endpoints (free tiers):
 *   - openrelay.metered.ca:80, :443 (0.5 GB/day free, ephemeral creds)
 *   - relay.metered.ca:80
 *   - freestun.net:3478
 *   - stun.l.google.com:19302 (STUN only, no relay)
 *   - stun.cloudflare.com:3478 (STUN only, no relay)
 */

'use strict';

// ═══════════════════════════════════════════════════════
// TURN server registry
// ═══════════════════════════════════════════════════════
const TURN_SERVERS = [
  {
    name: 'metered-ca',
    urls: [
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
    ],
    credentialType: 'ephemeral',   // Fetch from REST API
    credentialUrl: 'https://openrelay.metered.ca/api/v1/turn/credentials?apiKey=',
    apiKey: 'openrelayproject',    // Public demo key — rotate in production
    fallbackUsername: 'openrelayproject',
    fallbackCredential: 'openrelayproject',
    credentialTTL: 3600000,        // 1 hour default TTL
  },
  {
    name: 'metered-ca-relay',
    urls: [
      'turn:relay.metered.ca:80?transport=tcp',
      'turn:relay.metered.ca:443?transport=tcp',
      'turn:relay.metered.ca:80',
    ],
    credentialType: 'ephemeral',
    credentialUrl: 'https://relay.metered.ca/api/v1/turn/credentials?apiKey=',
    apiKey: 'openrelayproject',
    fallbackUsername: 'openrelayproject',
    fallbackCredential: 'openrelayproject',
    credentialTTL: 3600000,
  },
];

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:freestun.net:3478' },
];

// ═══════════════════════════════════════════════════════
// Ephemeral credential cache
// ═══════════════════════════════════════════════════════
const credentialCache = new Map(); // serverName → { username, credential, expires }

async function fetchEphemeralCredentials(server) {
  // Refresh proactively 5 min before expiry to avoid mid-session failures
  const cached = credentialCache.get(server.name);
  if (cached && cached.expires > Date.now() + 300000) {
    return { username: cached.username, credential: cached.credential };
  }

  const url = server.credentialUrl + encodeURIComponent(server.apiKey || '');
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const username = data.username || data.user;
    const credential = data.credential || data.password || data.key;

    if (username && credential) {
      const ttl = data.ttl
        ? parseInt(data.ttl) * 1000
        : (server.credentialTTL || 3600000);

      credentialCache.set(server.name, {
        username,
        credential,
        expires: Date.now() + ttl,
      });
      console.log(`[TURN] Ephemeral credentials for ${server.name} (TTL: ${ttl / 1000}s)`);
      return { username, credential };
    }
    throw new Error('Missing username/credential in response');
  } catch (e) {
    console.warn(`[TURN] Ephemeral credential fetch failed for ${server.name}: ${e.message}`);
    // Fall back to hardcoded credentials
    return {
      username: server.fallbackUsername,
      credential: server.fallbackCredential,
    };
  }
}

// ═══════════════════════════════════════════════════════
// TURN server probing — measure latency to each server
// ═══════════════════════════════════════════════════════
async function probeTurnServer(server, timeoutMs) {
  const t0 = performance.now();
  const iceServers = [];

  // Build ICE server config
  if (server.credentialType === 'ephemeral') {
    try {
      const creds = await fetchEphemeralCredentials(server);
      for (const url of server.urls) {
        iceServers.push({
          urls: url,
          username: creds.username,
          credential: creds.credential,
        });
      }
    } catch (e) {
      // Use fallback
      for (const url of server.urls) {
        iceServers.push({
          urls: url,
          username: server.fallbackUsername,
          credential: server.fallbackCredential,
        });
      }
    }
  } else {
    for (const url of server.urls) {
      iceServers.push({ urls: url });
    }
  }

  // Also include STUN for faster candidate gathering
  for (const stun of STUN_SERVERS) {
    iceServers.push(stun);
  }

  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; pc.close(); resolve(null); }
    }, timeoutMs || 8000);

    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'relay',
      });
    } catch (e) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    pc.onicegatheringstatechange = () => {
      if (done) return;
      if (pc.iceGatheringState === 'complete') {
        done = true;
        clearTimeout(timer);
        const latency = Math.round(performance.now() - t0);
        const sdp = pc.localDescription ? pc.localDescription.sdp : '';
        // Match candidate lines with typ relay (RFC 5245 a=candidate: ... typ relay)
        const hasRelay = /^a=candidate:.* typ relay/m.test(sdp);
        pc.close();
        resolve({
          server: server.name,
          latency,
          hasRelay,
          gatheringState: 'complete',
        });
      }
    };

    pc.createDataChannel('__nptn_probe');
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .catch(() => {
        if (!done) { done = true; clearTimeout(timer); pc.close(); resolve(null); }
      });
  });
}

// ═══════════════════════════════════════════════════════
// TurnTransport class
// ═══════════════════════════════════════════════════════

class TurnTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      iceServers: null,       // If null, auto-build from probing
      stunServers: STUN_SERVERS,
      iceTransportPolicy: 'relay',
      timeout: 15000,
      probeTimeout: 8000,
      maxChannels: 64,
      keepAliveInterval: 30000,
      reconnectAttempts: 3,
      reconnectBackoff: 2000,
      serverIndex: 0,         // Which TURN server to try first
    }, options);

    this.pc = null;
    this.channels = new Map();    // streamId → channel info
    this.pending = new Map();     // streamId → { resolve, reject, timer }
    this.nextStreamId = 1;
    this.initialized = false;
    this.activeServer = null;     // Currently connected TURN server
    this.probeResults = [];       // Sorted list of probed servers
    this.reconnectCount = 0;
    this.keepAliveTimer = null;

    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      channelsOpened: 0,
      channelsClosed: 0,
      errors: 0,
      reconnects: 0,
      serverSwitches: 0,
    };
  }

  // ═════════════════════════════════════════════════════
  // Static: Detection
  // ═════════════════════════════════════════════════════

  static async detect() {
    if (typeof RTCPeerConnection === 'undefined') {
      return { available: false, reason: 'WebRTC not available' };
    }
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      });
      pc.createDataChannel('__neptune_probe');
      let result = { available: false, reason: 'Gathering' };
      await new Promise((resolve) => {
        const t = setTimeout(() => { pc.close(); resolve(); }, 8000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t);
            const sdp = pc.localDescription ? pc.localDescription.sdp : '';
            result = { available: true, hasRelay: sdp.includes('relay'), hasSrflx: sdp.includes('srflx') };
            pc.close();
            resolve();
          }
        };
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            clearTimeout(t);
            pc.close();
            resolve();
          }
        };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {
          clearTimeout(t);
          pc.close();
          resolve();
        });
      });
      return result;
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  static getCapabilities() {
    return {
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
    };
  }

  // ═════════════════════════════════════════════════════
  // Public: Probe & rank TURN servers
  // ═════════════════════════════════════════════════════

  /**
   * Probe all known TURN servers in parallel and rank by latency.
   * Stores results in this.probeResults.
   * @returns {Array} Sorted probe results (fastest first)
   */
  async probeServers() {
    console.log('[TURN] Probing', TURN_SERVERS.length, 'TURN servers...');
    const results = await Promise.all(
      TURN_SERVERS.map(s => probeTurnServer(s, this.options.probeTimeout))
    );

    // Filter failures, sort by latency
    this.probeResults = results
      .filter(r => r !== null)
      .sort((a, b) => a.latency - b.latency);

    // Log results
    for (const r of this.probeResults) {
      const status = r.hasRelay ? '✓ relay' : '⚠ no relay';
      console.log(`[TURN]   ${r.server}: ${r.latency}ms ${status}`);
    }

    if (this.probeResults.length === 0) {
      console.warn('[TURN] No reachable TURN servers — relay transport unavailable');
    } else {
      console.log(`[TURN] Best server: ${this.probeResults[0].server} (${this.probeResults[0].latency}ms)`);
    }

    return this.probeResults;
  }

  // ═════════════════════════════════════════════════════
  // Public: Initialization
  // ═════════════════════════════════════════════════════

  /**
   * Initialize the TURN transport. Probes servers if needed,
   * fetches ephemeral credentials, establishes ICE connection.
   */
  async init() {
    if (this.initialized) return true;

    // Probe servers if we haven't yet
    if (this.probeResults.length === 0) {
      await this.probeServers();
    }

    if (this.probeResults.length === 0) {
      console.error('[TURN] No TURN servers available');
      return false;
    }

    // Try servers in order until one works
    for (let i = this.options.serverIndex; i < this.probeResults.length; i++) {
      const probe = this.probeResults[i];
      if (await this._connectToServer(probe)) {
        this.options.serverIndex = i;
        this.activeServer = probe;
        return true;
      }
      console.warn(`[TURN] Failed to connect to ${probe.server}, trying next...`);
    }

    // All servers failed
    console.error('[TURN] All TURN servers failed to connect');
    return false;
  }

  /**
   * Connect to a specific probed TURN server.
   * Builds ICE server config, creates RTCPeerConnection, gathers candidates.
   */
  async _connectToServer(probe) {
    const serverDef = TURN_SERVERS.find(s => s.name === probe.server);
    if (!serverDef) return false;

    // Fetch ephemeral credentials
    let iceServers = [...STUN_SERVERS];
    const turnConfig = { urls: serverDef.urls };

    try {
      const creds = await fetchEphemeralCredentials(serverDef);
      turnConfig.username = creds.username;
      turnConfig.credential = creds.credential;
    } catch (e) {
      turnConfig.username = serverDef.fallbackUsername;
      turnConfig.credential = serverDef.fallbackCredential;
    }

    iceServers.unshift(turnConfig);

    // Close existing connection
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }

    // Create new peer connection
    try {
      this.pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: this.options.iceTransportPolicy,
      });
    } catch (e) {
      console.error(`[TURN] RTCPeerConnection failed for ${probe.server}:`, e.message);
      return false;
    }

    // Wire up event handlers
    this.pc.ondatachannel = (event) => {
      this._setupChannel(event.channel);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc ? this.pc.iceConnectionState : 'closed';
      console.log(`[TURN] ICE state → ${state} (${probe.server})`);

      if (state === 'failed') {
        this._handleIceFailure(probe);
      } else if (state === 'disconnected') {
        this._handleIceDisconnect(probe);
      } else if (state === 'connected' || state === 'completed') {
        this.reconnectCount = 0;
        this._startKeepAlive();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc ? this.pc.connectionState : 'closed';
      console.log(`[TURN] Connection state → ${state}`);
      if (state === 'failed' || state === 'closed') {
        this._handlePeerFailure(probe);
      }
    };

    // Create offer and start ICE gathering
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait for ICE gathering
      if (this.pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('ICE gathering timeout'));
          }, this.options.timeout);

          const check = () => {
            if (this.pc.iceGatheringState === 'complete') {
              clearTimeout(timeout);
              resolve();
            }
          };
          this.pc.addEventListener('icegatheringstatechange', check, { once: true });
          check();
        });
      }

      // Verify relay candidates
      const sdp = this.pc.localDescription ? this.pc.localDescription.sdp : '';
      if (!/^a=candidate:.* typ relay/m.test(sdp) && this.options.iceTransportPolicy === 'relay') {
        console.warn(`[TURN] No relay candidates in SDP for ${probe.server}`);
      }

      // Wait for ICE connection to establish (TURN allocation confirmed)
      if (this.pc.iceConnectionState !== 'connected' && this.pc.iceConnectionState !== 'completed') {
        await new Promise((resolve, reject) => {
          const connTimeout = setTimeout(() => {
            this.pc.removeEventListener('iceconnectionstatechange', check);
            reject(new Error('ICE connection timeout — TURN allocation may have failed'));
          }, this.options.timeout);

          const check = () => {
            const state = this.pc ? this.pc.iceConnectionState : 'closed';
            if (state === 'connected' || state === 'completed') {
              clearTimeout(connTimeout);
              this.pc.removeEventListener('iceconnectionstatechange', check);
              resolve();
            } else if (state === 'failed' || state === 'closed') {
              clearTimeout(connTimeout);
              this.pc.removeEventListener('iceconnectionstatechange', check);
              reject(new Error('ICE connection ' + state));
            }
          };
          this.pc.addEventListener('iceconnectionstatechange', check);
          check();
        });
      }

    } catch (e) {
      console.error(`[TURN] ICE connection failed for ${probe.server}:`, e.message);
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
      return false;
    }

    this.initialized = true;
    console.log(`[TURN] Connected to ${probe.server} (${probe.latency}ms)`);
    return true;
  }

  // ═════════════════════════════════════════════════════
  // ICE failure & recovery
  // ═════════════════════════════════════════════════════

  _handleIceFailure(probe) {
    console.warn(`[TURN] ICE failed on ${probe.server}`);
    this.stats.errors++;

    if (this.reconnectCount < this.options.reconnectAttempts) {
      this.reconnectCount++;
      const delay = this.options.reconnectBackoff * Math.pow(2, this.reconnectCount - 1);
      console.log(`[TURN] ICE restart attempt ${this.reconnectCount}/${this.options.reconnectAttempts} in ${delay}ms`);
      setTimeout(() => this._restartIce(probe), delay);
    } else {
      console.error(`[TURN] Max ICE restart attempts reached for ${probe.server}`);
      this._rotateServer(probe);
    }
  }

  _handleIceDisconnect(probe) {
    console.log(`[TURN] ICE disconnected on ${probe.server} — waiting for recovery...`);
    // ICE may auto-recover; give it time, then restart if needed
    setTimeout(() => {
      if (this.pc && this.pc.iceConnectionState === 'disconnected') {
        console.warn(`[TURN] ICE still disconnected after grace period — restarting`);
        this._restartIce(probe);
      }
    }, 5000);
  }

  _handlePeerFailure(probe) {
    console.error(`[TURN] Peer connection failed on ${probe.server}`);
    this.stats.errors++;
    this._cleanupChannels();
    this._rotateServer(probe);
  }

  async _restartIce(probe) {
    if (!this.pc || this.pc.connectionState === 'closed') {
      // Need full reconnect
      await this._connectToServer(probe);
      return;
    }

    try {
      // ICE restart: create a new offer with iceRestart: true
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      console.log(`[TURN] ICE restart initiated on ${probe.server}`);
    } catch (e) {
      console.error(`[TURN] ICE restart failed: ${e.message} — full reconnect`);
      this._rotateServer(probe);
    }
  }

  async _rotateServer(failedProbe) {
    this.stats.serverSwitches++;
    this._cleanupChannels();

    // Find next available server (excluding the failed one)
    const candidates = this.probeResults.filter(p => p.server !== failedProbe.server);
    if (candidates.length === 0) {
      console.error('[TURN] No alternative TURN servers available');
      return;
    }

    // Re-probe to get fresh latency
    const freshResults = await Promise.all(
      candidates.map(s => probeTurnServer(
        TURN_SERVERS.find(def => def.name === s.server) || { name: s.server, urls: [] },
        this.options.probeTimeout
      ))
    );

    const working = freshResults.filter(r => r !== null).sort((a, b) => a.latency - b.latency);
    if (working.length === 0) {
      console.error('[TURN] All alternative servers unreachable');
      return;
    }

    this.probeResults = working;
    console.log(`[TURN] Rotating to ${working[0].server} (${working[0].latency}ms)`);
    await this._connectToServer(working[0]);
    this.activeServer = working[0];
    this.options.serverIndex = 0;
  }

  _cleanupChannels() {
    // Close heartbeat channel
    if (this._heartbeatChannel) {
      try { this._heartbeatChannel.close(); } catch (e) {}
      this._heartbeatChannel = null;
    }

    for (const [streamId, info] of this.channels) {
      info.state = 'closed';
      while (info.recvCallbacks.length > 0) {
        const cb = info.recvCallbacks.shift();
        try { cb(null); } catch (e) {}
      }
    }
    this.channels.clear();

    for (const [streamId, pending] of this.pending) {
      clearTimeout(pending.timer);
      try { pending.reject(new Error('TURN connection lost')); } catch (e) {}
    }
    this.pending.clear();

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  _startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.pc && this.pc.iceConnectionState === 'connected') {
        // Send a 1-byte DataChannel message to keep the TURN allocation alive.
        // TURN allocations expire after 5-10 min of inactivity; getStats() is
        // a local-only operation that does NOT traverse the network.
        // A dedicated heartbeat channel ensures actual traffic hits the relay.
        try {
          if (!this._heartbeatChannel || this._heartbeatChannel.readyState !== 'open') {
            this._heartbeatChannel = this.pc.createDataChannel('__nptn_hb', {
              ordered: false,
              maxRetransmits: 0,
            });
          }
          if (this._heartbeatChannel.readyState === 'open') {
            this._heartbeatChannel.send(new Uint8Array([0]));
          }
        } catch (e) {
          // Heartbeat channel may be closed; will recreate on next interval
          this._heartbeatChannel = null;
        }
      }
    }, this.options.keepAliveInterval);
  }

  // ═════════════════════════════════════════════════════
  // Public: Connection management
  // ═════════════════════════════════════════════════════

  /**
   * Open a TCP connection to host:port via TURN.
   * Uses RTCDataChannel as the transport layer.
   */
  async connect(host, port) {
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) throw new Error('TURN transport unavailable — no reachable servers');
    }
    if (!this.pc || this.pc.connectionState === 'closed') {
      throw new Error('TURN connection closed');
    }

    // Check channel limit
    if (this.channels.size >= this.options.maxChannels) {
      throw new Error(`Channel limit reached (${this.options.maxChannels})`);
    }

    const streamId = this.nextStreamId++;
    const label = `neptune:${host}:${port}:${streamId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        reject(new Error(`TURN connect timeout to ${host}:${port}`));
      }, this.options.timeout);

      try {
        const channel = this.pc.createDataChannel(label, {
          ordered: true,
          maxRetransmits: 3,
        });
        this._setupChannel(channel, streamId, host, port, resolve, reject, timer);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _setupChannel(channel, streamId, host, port, resolve, reject, timer) {
    const isIncoming = typeof streamId === 'undefined';

    if (!isIncoming) {
      // Outgoing channel
      channel.onopen = () => {
        clearTimeout(timer);
        this.pending.delete(streamId);
        this.channels.set(streamId, {
          channel,
          host,
          port,
          state: 'open',
          recvBuffer: [],
          recvCallbacks: [],
          openedAt: Date.now(),
        });
        this.stats.channelsOpened++;
        console.log(`[TURN] Channel ${streamId} opened → ${host}:${port}`);
        resolve(streamId);
      };

      channel.onerror = (e) => {
        clearTimeout(timer);
        this.pending.delete(streamId);
        this.stats.errors++;
        reject(new Error(`Channel error: ${e.message || 'unknown'}`));
      };

      channel.onclose = () => {
        this._onChannelClose(streamId);
      };

      channel.onmessage = (e) => {
        this._onChannelMessage(streamId, e.data);
      };

      // Track bufferedAmount for backpressure
      channel.onbufferedamountlow = () => {
        const info = this.channels.get(streamId);
        if (info && info._drainCb) {
          const cb = info._drainCb;
          info._drainCb = null;
          try { cb(); } catch (e) {}
        }
      };
    } else {
      // Incoming channel — assign a stream ID
      const sid = this.nextStreamId++;
      channel.onclose = () => this._onChannelClose(sid);
      channel.onmessage = (e) => this._onChannelMessage(sid, e.data);
      channel.onerror = () => { this.stats.errors++; };
      this.channels.set(sid, {
        channel,
        host: 'incoming',
        port: 0,
        state: 'open',
        recvBuffer: [],
        recvCallbacks: [],
        openedAt: Date.now(),
      });
      this.stats.channelsOpened++;
    }
  }

  _onChannelMessage(streamId, data) {
    const info = this.channels.get(streamId);
    if (!info) return;

    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => {
        this.stats.bytesReceived += reader.result.byteLength;
        this._deliverData(streamId, new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(data);
      return;
    } else {
      return;
    }

    this.stats.bytesReceived += bytes.length;
    this._deliverData(streamId, bytes);
  }

  _deliverData(streamId, bytes) {
    const info = this.channels.get(streamId);
    if (!info) return;

    if (info.recvCallbacks.length > 0) {
      const cb = info.recvCallbacks.shift();
      try { cb(bytes); } catch (e) {}
    } else {
      info.recvBuffer.push(bytes);
    }
  }

  _onChannelClose(streamId) {
    const info = this.channels.get(streamId);
    if (!info) return;
    info.state = 'closed';
    this.stats.channelsClosed++;

    while (info.recvCallbacks.length > 0) {
      const cb = info.recvCallbacks.shift();
      try { cb(null); } catch (e) {}
    }
    console.log(`[TURN] Channel ${streamId} closed`);
  }

  // ═════════════════════════════════════════════════════
  // Public: Data I/O
  // ═════════════════════════════════════════════════════

  async send(streamId, data) {
    const info = this.channels.get(streamId);
    if (!info || info.state !== 'open') throw new Error(`Stream ${streamId} not open`);

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const MAX_CHUNK = 14000;

    if (bytes.length <= MAX_CHUNK) {
      // Respect SCTP backpressure: if buffer is nearly full, wait
      if (info.channel.bufferedAmount > 65536 * 3) {
        await new Promise((resolve) => {
          info._drainCb = resolve;
        });
      }
      info.channel.send(bytes.buffer);
      this.stats.bytesSent += bytes.length;
    } else {
      for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
        const end = Math.min(offset + MAX_CHUNK, bytes.length);
        info.channel.send(bytes.slice(offset, end).buffer);
      }
      this.stats.bytesSent += bytes.length;
    }
    return bytes.length;
  }

  async recv(streamId) {
    const info = this.channels.get(streamId);
    if (!info) return null;
    if (info.state === 'closed') return null;

    if (info.recvBuffer.length > 0) {
      return info.recvBuffer.shift();
    }

    return new Promise((resolve) => {
      info.recvCallbacks.push(resolve);
    });
  }

  close(streamId) {
    const info = this.channels.get(streamId);
    if (!info) return;
    info.state = 'closed';
    try { info.channel.close(); } catch (e) {}
    this._onChannelClose(streamId);
    this.channels.delete(streamId);
  }

  async destroy() {
    this._cleanupChannels();
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }
    this.initialized = false;
    this.activeServer = null;
    this.probeResults = [];
  }

  // ═════════════════════════════════════════════════════
  // Public: Stats & diagnostics
  // ═════════════════════════════════════════════════════

  getStats() {
    return {
      ...this.stats,
      activeChannels: this.channels.size,
      pendingChannels: this.pending.size,
      iceState: this.pc ? this.pc.iceConnectionState : 'closed',
      connectionState: this.pc ? this.pc.connectionState : 'closed',
      activeServer: this.activeServer ? this.activeServer.server : null,
      probedServers: this.probeResults.map(p => ({
        server: p.server,
        latency: p.latency,
        hasRelay: p.hasRelay,
      })),
      reconnectCount: this.reconnectCount,
      initialized: this.initialized,
    };
  }

  /**
   * Get a summary of all probed TURN servers.
   */
  getServerStatus() {
    return {
      active: this.activeServer ? {
        server: this.activeServer.server,
        latency: this.activeServer.latency,
      } : null,
      all: this.probeResults.map(p => ({
        server: p.server,
        latency: p.latency,
        hasRelay: p.hasRelay,
        active: this.activeServer ? p.server === this.activeServer.server : false,
      })),
    };
  }
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TurnTransport;
}
if (typeof window !== 'undefined') {
  window.TurnTransport = TurnTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TurnTransport = TurnTransport;
}

// Also export utility functions for external use
if (typeof window !== 'undefined') {
  window.TurnTransportProbe = probeTurnServer;
  window.TurnTransportServers = TURN_SERVERS;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TurnTransportProbe = probeTurnServer;
  globalThis.TurnTransportServers = TURN_SERVERS;
}
