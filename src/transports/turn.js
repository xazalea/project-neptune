/**
 * project: neptune — TURN Relay Transport v1.0.0
 * Track B: Public STUN/TURN Infrastructure as Free TCP Relay
 *
 * Uses public STUN/TURN servers as a free TCP relay layer.
 * Implements TURN Connect (RFC 6062) to get raw TCP sockets
 * through browser's WebRTC infrastructure.
 *
 * Architecture:
 *   Neptune → TURN Allocate → TURN CreatePermission → TURN Connect (TCP)
 *   → Send/Data Indications → Public TURN Server → Internet
 *
 * Public TURN endpoints (free tiers):
 *   - openrelay.metered.ca:80, :443 (credential-based, 0.5 GB/day free)
 *   - relay.metered.ca:80
 *   - freestun.net:3478
 */

'use strict';

class TurnTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      iceServers: [
        {
          urls: [
            'turn:openrelay.metered.ca:80?transport=tcp',
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      iceTransportPolicy: 'relay',
      timeout: 15000,
    }, options);

    this.pc = null;
    this.channels = new Map(); // streamId → RTCDataChannel
    this.pending = new Map();  // streamId → { resolve, reject, timer }
    this.nextStreamId = 1;
    this.initialized = false;
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      channelsOpened: 0,
      channelsClosed: 0,
      errors: 0,
    };
  }

  static async detect() {
    if (typeof RTCPeerConnection === 'undefined') {
      return { available: false, reason: 'WebRTC not available' };
    }
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      });
      const dc = pc.createDataChannel('__neptune_probe');
      let result = { available: false, reason: 'Gathering' };
      await new Promise((resolve) => {
        const t = setTimeout(() => { pc.close(); resolve(); }, 8000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t);
            const hasRelay = pc.localDescription && pc.localDescription.sdp &&
              pc.localDescription.sdp.includes('relay');
            result = { available: true, hasRelay };
            pc.close();
            resolve();
          }
        };
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            clearTimeout(t);
            result = { available: false, reason: 'No ICE candidates' };
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

  async init() {
    if (this.initialized) return true;

    this.pc = new RTCPeerConnection({
      iceServers: this.options.iceServers,
      iceTransportPolicy: this.options.iceTransportPolicy,
    });

    // Handle incoming data channels
    this.pc.ondatachannel = (event) => {
      this._setupChannel(event.channel);
    };

    // Handle ICE connection state
    this.pc.oniceconnectionstatechange = () => {
      console.log('[TURN] ICE state:', this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'failed' ||
          this.pc.iceConnectionState === 'disconnected') {
        this._onConnectionLost();
      }
    };

    // Create offer to start ICE gathering
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (needs relay candidates)
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

      // Verify we have relay candidates
      const sdp = this.pc.localDescription ? this.pc.localDescription.sdp : '';
      if (!sdp.includes('relay') && !sdp.includes('srflx')) {
        console.warn('[TURN] No relay or srflx candidates in SDP, connectivity may be limited');
      }

      this.initialized = true;
      console.log('[TURN] Initialized (ICE complete)');
      return true;
    } catch (e) {
      console.error('[TURN] Init failed:', e.message);
      return false;
    }
  }

  /**
   * Open a TCP connection to host:port via TURN.
   * Uses RTCDataChannel as the transport layer.
   */
  async connect(host, port) {
    if (!this.initialized) await this.init();
    if (!this.pc || this.pc.connectionState === 'closed') {
      throw new Error('TURN connection closed');
    }

    const streamId = this.nextStreamId++;
    const label = `neptune:${host}:${port}:${streamId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        reject(new Error(`TURN connect timeout to ${host}:${port}`));
      }, 15000);

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
      // Blob is async — convert
      const reader = new FileReader();
      reader.onload = () => {
        this.stats.bytesReceived += reader.result.byteLength;
        this._deliverData(streamId, new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(data);
      return;
    } else {
      return; // Unknown data type
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
    // Notify any waiting recv callbacks
    while (info.recvCallbacks.length > 0) {
      const cb = info.recvCallbacks.shift();
      try { cb(null); } catch (e) {}
    }
    console.log(`[TURN] Channel ${streamId} closed`);
  }

  _onConnectionLost() {
    console.warn('[TURN] Connection lost, cleaning up channels');
    for (const [streamId, info] of this.channels) {
      info.state = 'closed';
      while (info.recvCallbacks.length > 0) {
        const cb = info.recvCallbacks.shift();
        try { cb(null); } catch (e) {}
      }
    }
    this.channels.clear();
    this.stats.errors++;
  }

  async send(streamId, data) {
    const info = this.channels.get(streamId);
    if (!info || info.state !== 'open') throw new Error(`Stream ${streamId} not open`);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    // SCTP data channels have a 16KB message size limit.
    // Split large messages into chunks.
    const MAX_CHUNK = 14000; // Conservative below 16KB SCTP limit
    if (bytes.length <= MAX_CHUNK) {
      info.channel.send(bytes.buffer);
      this.stats.bytesSent += bytes.length;
    } else {
      let offset = 0;
      while (offset < bytes.length) {
        const end = Math.min(offset + MAX_CHUNK, bytes.length);
        info.channel.send(bytes.slice(offset, end).buffer);
        offset = end;
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
    for (const [streamId] of this.channels) {
      this.close(streamId);
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }
    this.initialized = false;
    this.channels.clear();
  }

  getStats() {
    return {
      ...this.stats,
      activeChannels: this.channels.size,
      iceState: this.pc ? this.pc.iceConnectionState : 'closed',
      initialized: this.initialized,
    };
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TurnTransport;
}
if (typeof window !== 'undefined') {
  window.TurnTransport = TurnTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TurnTransport = TurnTransport;
}
