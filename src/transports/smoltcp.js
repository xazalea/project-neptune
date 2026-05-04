/**
 * project: neptune — smoltcp WASM Transport v1.0.0
 * Track A: smoltcp WASM TCP/IP Stack + SW Ethernet Bridge
 *
 * Wraps the smoltcp WASM TCP/IP stack as a transport.
 * Uses the NetworkAdapter bridge to route TCP streams
 * through the ServiceWorker's fetch() API.
 *
 * This is the most portable transport — works in any browser
 * with ServiceWorker + WASM support. No relay servers needed.
 */

'use strict';

class SmoltcpTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      hostIp: [10, 0, 0, 2],
      gatewayIp: [10, 0, 0, 1],
      hostMac: [0x02, 0x00, 0x00, 0x00, 0x00, 0x02],
      gatewayMac: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
      pollInterval: 50,
      maxConnections: 128,
    }, options);

    this.netStack = null;       // NeptuneNetStack WASM instance
    this.netAdapter = null;     // NetworkAdapter bridge
    this.streams = new Map();   // streamId → { host, port, localPort, state }
    this.portMap = new Map();   // localPort → streamId
    this.nextStreamId = 1;
    this.nextLocalPort = 49152; // Ephemeral port range start
    this.initialized = false;
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      streamsOpened: 0,
      streamsClosed: 0,
      errors: 0,
    };
  }

  static async detect() {
    if (typeof WebAssembly === 'undefined') {
      return { available: false, reason: 'WebAssembly not available' };
    }
    if (!('serviceWorker' in navigator)) {
      return { available: false, reason: 'ServiceWorker not available' };
    }
    try {
      const hasSab = typeof SharedArrayBuffer !== 'undefined';
      return { available: true, hasSharedArrayBuffer: hasSab };
    } catch (e) {
      return { available: false, reason: 'WASM check failed: ' + e.message };
    }
  }

  static getCapabilities() {
    return {
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
    };
  }

  /**
   * Initialize with an existing NeptuneNetStack and NetworkAdapter.
   * Called by the bootloader after WASM is loaded.
   */
  async init(netStack, netAdapter) {
    if (netStack) this.netStack = netStack;
    if (netAdapter) this.netAdapter = netAdapter;

    if (!this.netStack) {
      throw new Error('smoltcp transport requires NeptuneNetStack');
    }

    // If no adapter provided, try to create one
    if (!this.netAdapter && typeof NetworkAdapter !== 'undefined') {
      this.netAdapter = new NetworkAdapter(this.netStack);
      this.netAdapter.start();
    }

    this.initialized = true;
    console.log('[SMOLTCP] Transport initialized');
    return true;
  }

  async connect(host, port) {
    if (!this.initialized) throw new Error('Transport not initialized');

    const streamId = this.nextStreamId++;
    const localPort = this._allocLocalPort();

    this.streams.set(streamId, {
      host,
      port,
      localPort,
      state: 'connecting',
      recvBuffer: [],
      recvCallbacks: [],
      httpBuffer: '',
    });
    this.portMap.set(localPort, streamId);
    this.stats.streamsOpened++;

    // Notify NetworkAdapter to route data from this local port
    if (this.netAdapter) {
      this.netAdapter._registerStream(streamId, host, port, localPort);
    }

    console.log(`[SMOLTCP] Connect ${host}:${port} → stream ${streamId} (local port ${localPort})`);
    return streamId;
  }

  async send(streamId, data) {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream ${streamId} not found`);

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    // Build HTTP request from the raw TCP data
    const httpRequest = this._buildHttpRequest(stream, bytes);

    // Send via NetworkAdapter to SW
    if (this.netAdapter && this.netAdapter._sendToSW) {
      this.netAdapter._sendToSW({
        type: 'NET_ADAPT_DATA',
        localPort: stream.localPort,
        data: Array.from(new TextEncoder().encode(httpRequest)),
      });
    }

    this.stats.bytesSent += bytes.length;
    return bytes.length;
  }

  async recv(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    if (stream.recvBuffer.length > 0) {
      return stream.recvBuffer.shift();
    }

    return new Promise((resolve) => {
      stream.recvCallbacks.push(resolve);
    });
  }

  onData(streamId, callback) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.recvCallbacks.push(callback);
    }
  }

  /**
   * Feed response data from the NetworkAdapter into this transport.
   * Called by the adapter when HTTP responses arrive.
   */
  feedResponse(localPort, data) {
    const streamId = this.portMap.get(localPort);
    if (!streamId) return;

    const stream = this.streams.get(streamId);
    if (!stream) return;

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.stats.bytesReceived += bytes.length;

    if (stream.recvCallbacks.length > 0) {
      const cb = stream.recvCallbacks.shift();
      try { cb(bytes); } catch (e) {}
    } else {
      stream.recvBuffer.push(bytes);
    }
  }

  close(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    stream.state = 'closed';
    this.portMap.delete(stream.localPort);
    this.stats.streamsClosed++;

    // Notify adapter
    if (this.netAdapter) {
      this.netAdapter._sendToSW({
        type: 'NET_ADAPT_CLOSE',
        localPort: stream.localPort,
      });
    }

    // Notify waiting recv callbacks
    while (stream.recvCallbacks.length > 0) {
      const cb = stream.recvCallbacks.shift();
      try { cb(null); } catch (e) {}
    }

    this.streams.delete(streamId);
  }

  async destroy() {
    for (const [streamId] of this.streams) {
      this.close(streamId);
    }
    if (this.netAdapter) {
      this.netAdapter.stop();
      this.netAdapter = null;
    }
    this.netStack = null;
    this.initialized = false;
  }

  getStats() {
    return {
      ...this.stats,
      activeStreams: this.streams.size,
      initialized: this.initialized,
    };
  }

  // ═══════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════

  _allocLocalPort() {
    const port = this.nextLocalPort++;
    if (this.nextLocalPort > 65535) this.nextLocalPort = 49152;
    return port;
  }

  _buildHttpRequest(stream, data) {
    // Build a minimal HTTP/1.1 request
    const method = 'GET';
    const path = '/';
    const host = stream.host;

    const request = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}:${stream.port}`,
      'User-Agent: Neptune/3.0 (smoltcp WASM)',
      'Accept: */*',
      'Connection: close',
      '',
      '',
    ].join('\r\n');

    return request;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmoltcpTransport;
}
if (typeof window !== 'undefined') {
  window.SmoltcpTransport = SmoltcpTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.SmoltcpTransport = SmoltcpTransport;
}
