/**
 * project: neptune — Base Transport Interface
 * 
 * All transport implementations must implement this interface.
 * The TransportDetector auto-selects the best available transport
 * at boot time based on browser capabilities and network conditions.
 */

'use strict';

/**
 * @typedef {Object} TransportCapabilities
 * @property {string} name - Transport name (e.g., "turn-relay", "smoltcp-wasm")
 * @property {string} tier - "gold" | "silver" | "bronze" | "copper" | "experimental" | "fallback"
 * @property {number} priority - Numeric priority (lower = better, 1-100)
 * @property {boolean} requiresServiceWorker - Whether SW must be active
 * @property {boolean} requiresWASM - Whether WASM must be loaded
 * @property {boolean} requiresExternalRelay - Whether the transport needs an external relay server
 * @property {boolean} requiresLocalHelper - Whether a local binary helper is needed
 * @property {boolean} supportsEncrypted - Can transport HTTPS traffic
 * @property {number} maxThroughput - Estimated max throughput in KB/s
 * @property {number} latency - Estimated base latency in ms
 * @property {string[]} browserSupport - Array of browser names that support this transport
 */

/**
 * Base Transport class. All transports extend this.
 * 
 * Lifecycle:
 *   1. detect() — static, checks if transport is available
 *   2. new Transport() — construct with any options
 *   3. transport.init() — async initialization
 *   4. transport.connect(host, port) → streamId
 *   5. transport.send(streamId, data) → Promise
 *   6. transport.recv(streamId) → Promise<Uint8Array>
 *   7. transport.close(streamId)
 *   8. transport.destroy() — teardown
 */
class Transport {
  constructor(options = {}) {
    this.options = options;
    this.initialized = false;
    this.streams = new Map(); // streamId → { host, port, state, buffer, callbacks }
    this.nextStreamId = 1;
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      streamsOpened: 0,
      streamsClosed: 0,
      errors: 0,
    };
  }

  /**
   * Static method: check if this transport is available in the current browser.
   * @returns {Promise<{available: boolean, reason?: string}>}
   */
  static async detect() {
    return { available: false, reason: 'Not implemented' };
  }

  /**
   * Static method: get transport capabilities metadata.
   * @returns {TransportCapabilities}
   */
  static getCapabilities() {
    return {
      name: 'base',
      tier: 'fallback',
      priority: 100,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 0,
      latency: Infinity,
      browserSupport: [],
    };
  }

  /**
   * Initialize the transport. Called once at startup.
   * @returns {Promise<boolean>}
   */
  async init() {
    this.initialized = true;
    return true;
  }

  /**
   * Open a connection to a remote host:port.
   * @param {string} host - Target hostname or IP
   * @param {number} port - Target port
   * @returns {Promise<number>} streamId for the connection
   */
  async connect(host, port) {
    const streamId = this.nextStreamId++;
    this.streams.set(streamId, {
      host,
      port,
      state: 'connecting',
      buffer: [],
      callbacks: { onData: null, onClose: null, onError: null },
    });
    this.stats.streamsOpened++;
    return streamId;
  }

  /**
   * Send data on an open stream.
   * @param {number} streamId
   * @param {Uint8Array|ArrayBuffer} data
   * @returns {Promise<number>} bytes sent
   */
  async send(streamId, data) {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream ${streamId} not found`);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.stats.bytesSent += bytes.length;
    return bytes.length;
  }

  /**
   * Receive data from a stream (pull-based).
   * @param {number} streamId
   * @returns {Promise<Uint8Array|null>} data or null if stream closed
   */
  async recv(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    if (stream.buffer.length > 0) {
      this.stats.bytesReceived += stream.buffer[0].length;
      return stream.buffer.shift();
    }
    return new Uint8Array(0);
  }

  /**
   * Set a callback for incoming data on a stream (push-based).
   * @param {number} streamId
   * @param {Function} callback - Called with Uint8Array when data arrives
   */
  onData(streamId, callback) {
    const stream = this.streams.get(streamId);
    if (stream) stream.callbacks.onData = callback;
  }

  /**
   * Set a callback for stream close.
   * @param {number} streamId
   * @param {Function} callback
   */
  onClose(streamId, callback) {
    const stream = this.streams.get(streamId);
    if (stream) stream.callbacks.onClose = callback;
  }

  /**
   * Set a callback for stream errors.
   * @param {number} streamId
   * @param {Function} callback
   */
  onError(streamId, callback) {
    const stream = this.streams.get(streamId);
    if (stream) stream.callbacks.onError = callback;
  }

  /**
   * Close a stream.
   * @param {number} streamId
   */
  close(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.state = 'closed';
      this.stats.streamsClosed++;
      if (stream.callbacks.onClose) {
        try { stream.callbacks.onClose(); } catch (e) {}
      }
      this.streams.delete(streamId);
    }
  }

  /**
   * Destroy the transport, closing all streams and releasing resources.
   */
  destroy() {
    for (const [id] of this.streams) {
      this.close(id);
    }
    this.initialized = false;
  }

  /**
   * Get transport statistics.
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      activeStreams: this.streams.size,
      initialized: this.initialized,
    };
  }

  /**
   * Feed received data into a stream's buffer and fire callback.
   * @protected
   */
  _feedData(streamId, data) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.state === 'closed') return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.stats.bytesReceived += bytes.length;
    if (stream.callbacks.onData) {
      try { stream.callbacks.onData(bytes); } catch (e) {}
    } else {
      stream.buffer.push(bytes);
    }
  }

  /**
   * Report a stream error.
   * @protected
   */
  _reportError(streamId, error) {
    this.stats.errors++;
    const stream = this.streams.get(streamId);
    if (stream && stream.callbacks.onError) {
      try { stream.callbacks.onError(error); } catch (e) {}
    }
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Transport;
}
if (typeof window !== 'undefined') {
  window.NeptuneTransport = Transport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.NeptuneTransport = Transport;
}
