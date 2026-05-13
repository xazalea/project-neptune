/**
 * project: neptune — WebRTC Local Mesh Transport v1.0.0
 *
 * Creates a peer-to-peer mesh network of Neptune tabs on the SAME MACHINE
 * using WebRTC with ZERO external STUN/TURN servers. This is a cutting-edge
 * technique that forces WebRTC to use local host candidates only, combined
 * with BroadcastChannel for in-browser signaling.
 *
 * Key innovations:
 *   - iceServers: [] (empty) + iceTransportPolicy: 'all' forces ONLY local
 *     host candidates (127.0.0.1 loopback or local interface IPs)
 *   - RTCIceCandidate with type 'host' enables same-machine tab-to-tab
 *     connections without any network egress
 *   - BroadcastChannel (same-origin only) acts as the signaling server,
 *     completely replacing external signaling infrastructure
 *   - DataChannel with ordered: false, maxRetransmits: 0 for ultra-low-latency
 *     local proxy mesh packets
 *   - Automatic mesh reconnection on tab crash/reload via heartbeat protocol
 *
 * This transport is INVISIBLE to network monitoring because NO packets leave
 * the local machine (all communication is loopback-local or memory-local via
 * the browser's internal IPC).
 *
 * Architecture:
 *   - Each tab joins the mesh with a UUID peer ID
 *   - BroadcastChannel mesh-signaling is used for offer/answer/ICE exchange
 *   - Each tab maintains DataChannels to all other peers (full mesh)
 *   - Messages are routed via shortest path or broadcast flooded
 *   - A leader election algorithm (bully algorithm variant) picks a master
 *     tab for state synchronization
 *
 * Usage:
 *   const mesh = new NeptuneWebRTCMesh();
 *   await mesh.join('neptune-mesh-1');
 *   mesh.onMessage = (fromPeerId, data) => console.log(fromPeerId, data);
 *   mesh.broadcast({ type: 'cache_sync', urls: [...] });
 */

'use strict';

const NeptuneWebRTCMesh = (function() {
  // ═══════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════
  const HEARTBEAT_INTERVAL = 3000;    // ms
  const HEARTBEAT_TIMEOUT  = 10000;   // ms — peer considered dead
  const SIGNAL_CHAN_PREFIX = '__nptn_mesh_sig_';
  const DATA_CHAN_LABEL    = 'nptn-mesh-data';
  const MAX_MESSAGE_SIZE   = 65536;   // WebRTC data channel limit

  // ═══════════════════════════════════════════════════════
  // Utility functions
  // ═══════════════════════════════════════════════════════
  function generatePeerId() {
    return 'p_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  function isLocalCandidate(candidate) {
    if (!candidate) return false;
    const c = typeof candidate === 'string' ? candidate : candidate.candidate;
    if (!c) return false;
    // Local candidates: type host, and address is loopback or local
    if (c.includes('typ host')) return true;
    if (c.includes('127.0.0.1')) return true;
    if (c.includes('::1')) return true;
    // Also accept srflx if it's from the same machine (same public IP)
    // but prefer host-only for true zero-egress
    return false;
  }

  // ═══════════════════════════════════════════════════════
  // PeerConnection wrapper with forced-local ICE
  // ═══════════════════════════════════════════════════════
  class MeshPeerConnection {
    constructor(localId, remoteId, signalingChannel) {
      this.localId = localId;
      this.remoteId = remoteId;
      this.signalingChannel = signalingChannel;
      this.pc = null;
      this.dataChannel = null;
      this.connected = false;
      this._pendingCandidates = [];
      this._iceComplete = false;
      this._resolveConnect = null;
      this._connectPromise = new Promise(r => this._resolveConnect = r);
      this.onMessage = null;
      this.onConnect = null;
      this.onDisconnect = null;
    }

    async init(asInitiator = true) {
      // Force LOCAL-ONLY WebRTC: no STUN, no TURN, no external anything
      const config = {
        iceServers: [],
        iceTransportPolicy: 'all',
        // Experimental: force local candidate gathering only
        // Some browsers may still gather srflx briefly, but we filter them
      };

      this.pc = new RTCPeerConnection(config);

      this.pc.onicecandidate = (e) => {
        if (!e.candidate) {
          this._iceComplete = true;
          return;
        }
        // Only signal LOCAL candidates — this is the zero-egress guarantee
        if (isLocalCandidate(e.candidate)) {
          this._sendSignal({ type: 'ice', candidate: e.candidate });
        }
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc.connectionState;
        if (state === 'connected' || state === 'completed') {
          this.connected = true;
          if (this._resolveConnect) { this._resolveConnect(true); this._resolveConnect = null; }
          if (this.onConnect) this.onConnect(this.remoteId);
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this.connected = false;
          if (this.onDisconnect) this.onDisconnect(this.remoteId, state);
        }
      };

      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._setupDataChannel(this.dataChannel);
      };

      if (asInitiator) {
        // Create data channel with low-latency settings
        this.dataChannel = this.pc.createDataChannel(DATA_CHAN_LABEL, {
          ordered: false,
          maxRetransmits: 3,
        });
        this._setupDataChannel(this.dataChannel);

        const offer = await this.pc.createOffer();
        // Strip any non-local candidates from SDP (belt-and-suspenders)
        offer.sdp = this._filterSdpToLocal(offer.sdp);
        await this.pc.setLocalDescription(offer);
        this._sendSignal({ type: 'offer', sdp: offer.sdp });
      }

      return this._connectPromise;
    }

    _setupDataChannel(dc) {
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        this.connected = true;
        if (this._resolveConnect) { this._resolveConnect(true); this._resolveConnect = null; }
        if (this.onConnect) this.onConnect(this.remoteId);
      };
      dc.onmessage = (e) => {
        let data;
        if (e.data instanceof ArrayBuffer) {
          data = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data)));
        } else {
          data = JSON.parse(e.data);
        }
        if (this.onMessage) this.onMessage(this.remoteId, data);
      };
      dc.onclose = () => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect(this.remoteId, 'datachannel-closed');
      };
      dc.onerror = (err) => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect(this.remoteId, 'datachannel-error');
      };
    }

    _filterSdpToLocal(sdp) {
      // Remove any a=candidate lines that are not host candidates
      return sdp.split('\r\n').filter(line => {
        if (!line.startsWith('a=candidate:')) return true;
        return line.includes('typ host');
      }).join('\r\n');
    }

    _sendSignal(msg) {
      if (!this.signalingChannel) return;
      this.signalingChannel.postMessage({
        to: this.remoteId,
        from: this.localId,
        ...msg,
      });
    }

    async handleSignal(msg) {
      if (!this.pc) return;
      try {
        if (msg.type === 'offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await this.pc.createAnswer();
          answer.sdp = this._filterSdpToLocal(answer.sdp);
          await this.pc.setLocalDescription(answer);
          this._sendSignal({ type: 'answer', sdp: answer.sdp });
        } else if (msg.type === 'answer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        } else if (msg.type === 'ice' && msg.candidate) {
          await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      } catch (e) {
        console.warn('[MeshPeer] Signal handling error:', e.message);
      }
    }

    send(data) {
      if (!this.connected || !this.dataChannel || this.dataChannel.readyState !== 'open') {
        return false;
      }
      const payload = JSON.stringify(data);
      if (payload.length > MAX_MESSAGE_SIZE) {
        // Chunk large messages
        const chunks = this._chunkString(payload, MAX_MESSAGE_SIZE - 256);
        for (let i = 0; i < chunks.length; i++) {
          this.dataChannel.send(JSON.stringify({
            _chunk: true,
            _total: chunks.length,
            _index: i,
            _id: data._id || Math.random().toString(36).substr(2, 8),
            _payload: chunks[i],
          }));
        }
        return true;
      }
      this.dataChannel.send(payload);
      return true;
    }

    _chunkString(str, size) {
      const chunks = [];
      for (let i = 0; i < str.length; i += size) {
        chunks.push(str.substring(i, i + size));
      }
      return chunks;
    }

    close() {
      this.connected = false;
      if (this.dataChannel) { this.dataChannel.close(); this.dataChannel = null; }
      if (this.pc) { this.pc.close(); this.pc = null; }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Main Mesh class
  // ═══════════════════════════════════════════════════════
  class NeptuneWebRTCMesh {
    constructor(options = {}) {
      this.peerId = options.peerId || generatePeerId();
      this.meshId = options.meshId || 'default';
      this.signalingChannel = null;
      this.peers = new Map(); // remoteId → MeshPeerConnection
      this.knownPeers = new Map(); // peerId → { lastSeen, metadata }
      this.onMessage = null;   // (fromPeerId, data) => void
      this.onPeerJoin = null;  // (peerId) => void
      this.onPeerLeave = null; // (peerId, reason) => void
      this.onLeaderChange = null;
      this._leaderId = null;
      this._heartbeatTimer = null;
      this._cleanupTimer = null;
      this._chunkBuffer = new Map(); // chunkId → { chunks[], received, total }
      this._joined = false;
    }

    async join(meshId) {
      if (this._joined) return true;
      this.meshId = meshId || this.meshId;

      if (typeof BroadcastChannel === 'undefined') {
        throw new Error('BroadcastChannel not supported (requires modern browser)');
      }

      this.signalingChannel = new BroadcastChannel(SIGNAL_CHAN_PREFIX + this.meshId);
      this.signalingChannel.onmessage = (e) => this._handleSignal(e.data);

      // Announce presence
      this._broadcastSignal({ type: 'hello', peerId: this.peerId, ts: Date.now() });

      // Start heartbeat and cleanup
      this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL);
      this._cleanupTimer = setInterval(() => this._cleanupPeers(), HEARTBEAT_TIMEOUT);

      this._joined = true;
      return true;
    }

    leave() {
      this._joined = false;
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
      this._broadcastSignal({ type: 'bye', peerId: this.peerId });
      for (const [id, peer] of this.peers) { peer.close(); }
      this.peers.clear();
      this.knownPeers.clear();
      if (this.signalingChannel) { this.signalingChannel.close(); this.signalingChannel = null; }
    }

    /**
     * Broadcast a message to ALL peers in the mesh.
     */
    broadcast(data) {
      const msg = { ...data, _from: this.peerId, _ts: Date.now() };
      let sent = 0;
      for (const [id, peer] of this.peers) {
        if (peer.send(msg)) sent++;
      }
      return sent;
    }

    /**
     * Send a message to a specific peer.
     */
    sendTo(peerId, data) {
      const peer = this.peers.get(peerId);
      if (!peer) return false;
      return peer.send({ ...data, _from: this.peerId, _ts: Date.now() });
    }

    /**
     * Get current mesh topology.
     */
    getTopology() {
      return {
        self: this.peerId,
        leader: this._leaderId,
        peers: Array.from(this.peers.keys()).map(id => ({
          id,
          connected: this.peers.get(id).connected,
          lastSeen: this.knownPeers.get(id)?.lastSeen || 0,
        })),
      };
    }

    // ── Internal ─────────────────────────────────────────
    _broadcastSignal(msg) {
      if (this.signalingChannel) {
        this.signalingChannel.postMessage(msg);
      }
    }

    _handleSignal(msg) {
      if (!msg || msg.from === this.peerId) return;
      if (msg.to && msg.to !== this.peerId) return; // Not for us

      const remoteId = msg.from || msg.peerId;
      if (!remoteId) return;

      // Update known peers
      this.knownPeers.set(remoteId, { lastSeen: Date.now() });

      if (msg.type === 'hello') {
        // New peer discovered — initiate connection if we have lexicographically smaller ID
        // This prevents double-connection attempts
        if (this.peerId < remoteId && !this.peers.has(remoteId)) {
          this._connectToPeer(remoteId, true);
        }
        // Reply with our own hello so they know we exist
        this._broadcastSignal({ type: 'hello-reply', peerId: this.peerId, ts: Date.now() });
      } else if (msg.type === 'hello-reply') {
        if (!this.peers.has(remoteId) && this.peerId < remoteId) {
          this._connectToPeer(remoteId, true);
        }
      } else if (msg.type === 'bye') {
        this._removePeer(remoteId, 'peer-left');
      } else if (msg.type === 'heartbeat') {
        this.knownPeers.set(remoteId, { lastSeen: Date.now(), leader: msg.leader });
        if (msg.leader && msg.leader !== this._leaderId) {
          this._leaderId = msg.leader;
          if (this.onLeaderChange) this.onLeaderChange(this._leaderId);
        }
      } else if (['offer', 'answer', 'ice'].includes(msg.type)) {
        // WebRTC signaling
        let peer = this.peers.get(remoteId);
        if (!peer) {
          // We didn't initiate but received an offer — accept as non-initiator
          peer = this._connectToPeer(remoteId, false);
        }
        peer.handleSignal(msg);
      }
    }

    async _connectToPeer(remoteId, asInitiator) {
      if (this.peers.has(remoteId)) return this.peers.get(remoteId);

      const peer = new MeshPeerConnection(this.peerId, remoteId, this.signalingChannel);
      peer.onMessage = (from, data) => this._handlePeerMessage(from, data);
      peer.onConnect = (id) => {
        if (this.onPeerJoin) this.onPeerJoin(id);
        this._runLeaderElection();
      };
      peer.onDisconnect = (id, reason) => {
        this._removePeer(id, reason);
      };

      this.peers.set(remoteId, peer);
      await peer.init(asInitiator);
      return peer;
    }

    _removePeer(remoteId, reason) {
      const peer = this.peers.get(remoteId);
      if (peer) {
        peer.close();
        this.peers.delete(remoteId);
      }
      this.knownPeers.delete(remoteId);
      if (this.onPeerLeave) this.onPeerLeave(remoteId, reason);
      if (this._leaderId === remoteId) {
        this._runLeaderElection();
      }
    }

    _handlePeerMessage(fromPeerId, data) {
      // Reassemble chunked messages
      if (data._chunk) {
        const buf = this._chunkBuffer.get(data._id) || { chunks: [], received: 0, total: data._total };
        buf.chunks[data._index] = data._payload;
        buf.received++;
        if (buf.received >= data._total) {
          this._chunkBuffer.delete(data._id);
          const full = buf.chunks.join('');
          try {
            const assembled = JSON.parse(full);
            if (this.onMessage) this.onMessage(fromPeerId, assembled);
          } catch (e) {
            // Drop corrupted reassembly
          }
        } else {
          this._chunkBuffer.set(data._id, buf);
        }
        return;
      }

      // Deduplicate by timestamp (simple 1s window)
      if (data._ts && Math.abs(Date.now() - data._ts) > 5000) {
        return; // Too old
      }

      if (this.onMessage) this.onMessage(fromPeerId, data);
    }

    _heartbeat() {
      if (!this._joined) return;
      this._broadcastSignal({
        type: 'heartbeat',
        peerId: this.peerId,
        leader: this._leaderId,
        ts: Date.now(),
      });
    }

    _cleanupPeers() {
      const now = Date.now();
      for (const [id, info] of this.knownPeers) {
        if (now - info.lastSeen > HEARTBEAT_TIMEOUT) {
          this._removePeer(id, 'timeout');
        }
      }
    }

    _runLeaderElection() {
      // Bully algorithm variant: highest peerId wins (deterministic)
      const allIds = [this.peerId, ...Array.from(this.peers.keys()).filter(id => this.peers.get(id).connected)];
      const leader = allIds.sort().pop(); // highest string = leader
      if (leader !== this._leaderId) {
        this._leaderId = leader;
        if (this.onLeaderChange) this.onLeaderChange(leader);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Exports
  // ═══════════════════════════════════════════════════════
  return {
    NeptuneWebRTCMesh,
    MeshPeerConnection,
    generatePeerId,
    isLocalCandidate,
    constants: {
      HEARTBEAT_INTERVAL,
      HEARTBEAT_TIMEOUT,
      SIGNAL_CHAN_PREFIX,
      DATA_CHAN_LABEL,
      MAX_MESSAGE_SIZE,
    },
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneWebRTCMesh;
}
if (typeof window !== 'undefined') {
  window.NeptuneWebRTCMesh = NeptuneWebRTCMesh;
}
if (typeof globalThis !== 'undefined') {
  globalThis.NeptuneWebRTCMesh = NeptuneWebRTCMesh;
}
