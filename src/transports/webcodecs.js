/**
 * project: neptune — WebCodecs Transport v1.0.0
 * Track I: WebCodecs Transport
 *
 * EXPERIMENTAL: Attempts to use WebCodecs API (VideoEncoder/
 * VideoDecoder) to encode HTTP response bytes as video frame
 * pixel data and decode them in real-time.
 *
 * The theory:
 *   1. Encode HTTP response bytes as raw RGBA pixel data
 *   2. Compress with VideoEncoder → EncodedVideoChunk stream
 *   3. Stream through MediaStreamTrackProcessor
 *   4. Decode on receiving end via VideoDecoder
 *   5. Extract original bytes from decoded VideoFrame
 *
 * Current status: SPECULATIVE. Requires WebCodecs API support
 * (Chrome/Edge only). The key question is whether we can get
 * cross-origin video data through WebCodecs without triggering
 * CORS restrictions — likely blocked by browser security.
 *
 * Included for research completeness and future-proofing.
 */

'use strict';

class WebCodecsTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      codec: 'avc1.42001E',       // H.264 baseline
      width: 640,
      height: 480,
      fps: 30,
      bitrate: 1000000,           // 1 Mbps
      frameBytesSize: 640 * 480 * 4, // RGBA
    }, options);

    this.encoder = null;
    this.decoder = null;
    this.initialized = false;
    this.encodesInFlight = 0;
    this.pendingFrames = [];
    this.stats = {
      framesEncoded: 0,
      framesDecoded: 0,
      bytesSent: 0,
      bytesReceived: 0,
      errors: 0,
    };
  }

  // ── Detection ──────────────────────────────────────
  static async detect() {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      return { available: false, reason: 'WebCodecs API not available' };
    }

    // Check codec support
    try {
      const config = {
        codec: 'avc1.42001E',
        width: 640,
        height: 480,
        bitrate: 1000000,
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) {
        return { available: false, reason: 'H.264 codec not supported' };
      }

      return { available: true, codec: 'avc1.42001E' };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  static getCapabilities() {
    return {
      name: 'webcodecs',
      tier: 'experimental',
      priority: 5,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 500,
      latency: 100,
      browserSupport: ['chrome', 'edge'],
    };
  }

  // ── Initialization ────────────────────────────────
  async init() {
    if (this.initialized) return true;

    try {
      // Initialize encoder
      const encoderConfig = {
        codec: this.options.codec,
        width: this.options.width,
        height: this.options.height,
        bitrate: this.options.bitrate,
        framerate: this.options.fps,
      };

      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => this._onEncodedChunk(chunk, metadata),
        error: (e) => {
          console.error('[WEBCODECS] Encoder error:', e.message);
          this.stats.errors++;
        },
      });

      await this.encoder.configure(encoderConfig);

      this.initialized = true;
      console.log('[WEBCODECS] Initialized — WebCodecs transport ready');
      return true;
    } catch (e) {
      console.warn('[WEBCODECS] Init failed:', e.message);
      return false;
    }
  }

  // ── Data Encoding ──────────────────────────────────
  /**
   * Encode raw bytes as a video frame.
   * Returns the encoded chunks as an ArrayBuffer.
   */
  async encodeBytes(bytes) {
    if (!this.initialized) await this.init();
    if (!this.encoder) throw new Error('WebCodecs encoder not initialized');

    return new Promise((resolve, reject) => {
      const chunks = [];
      const frameData = this._bytesToFrameData(bytes);

      const frame = new VideoFrame(frameData, {
        timestamp: 0,
        duration: Math.round(1e6 / this.options.fps),
        format: 'RGBA',
        codedWidth: this.options.width,
        codedHeight: this.options.height,
      });

      this.encoder.encode(frame, { keyFrame: true });
      frame.close();

      // Collect encoded chunks
      const origOutput = this.encoder.output;
      // Wait for encoding to complete
      const checkComplete = setInterval(() => {
        if (this.encodesInFlight === 0 && chunks.length > 0) {
          clearInterval(checkComplete);
          resolve(this._concatChunks(chunks));
        }
      }, 10);

      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(checkComplete);
        if (chunks.length === 0) {
          reject(new Error('WebCodecs encoding timeout'));
        } else {
          resolve(this._concatChunks(chunks));
        }
      }, 5000);
    });
  }

  /**
   * Decode encoded video chunks back to raw bytes.
   */
  async decodeBytes(encodedData) {
    if (!this.initialized) await this.init();

    return new Promise((resolve, reject) => {
      const decoder = new VideoDecoder({
        output: (frame) => {
          try {
            const bytes = this._frameToBytes(frame);
            frame.close();
            resolve(bytes);
          } catch (e) {
            frame.close();
            reject(e);
          }
        },
        error: (e) => {
          console.error('[WEBCODECS] Decoder error:', e.message);
          reject(e);
        },
      });

      decoder.configure({
        codec: this.options.codec,
      });

      // Parse encoded data into chunks
      const chunk = new EncodedVideoChunk({
        type: 'key',
        timestamp: 0,
        data: encodedData,
      });

      decoder.decode(chunk);

      setTimeout(async () => {
        try {
          await decoder.flush();
          decoder.close();
        } catch (e) {}
      }, 100);
    });
  }

  // ── Transport Interface ────────────────────────────
  /**
   * NOTE: This transport DOES NOT actually proxy real TCP connections.
   * It is a proof-of-concept for encoding/decoding bytes through
   * WebCodecs. Real transport would require a server-side WebCodecs
   * peer to relay traffic.
   */
  async connect(host, port) {
    throw new Error(
      'WebCodecs transport is experimental — requires server-side ' +
      'peer to relay traffic. Not usable for direct TCP connections.'
    );
  }

  async send(streamId, data) {
    throw new Error('WebCodecs transport does not support direct send');
  }

  async recv(streamId) {
    throw new Error('WebCodecs transport does not support direct recv');
  }

  close(streamId) {}

  async destroy() {
    if (this.encoder) {
      try { this.encoder.close(); } catch (e) {}
      this.encoder = null;
    }
    this.pendingFrames = [];
    this.initialized = false;
  }

  getStats() {
    return {
      ...this.stats,
      initialized: this.initialized,
      pendingFrames: this.pendingFrames.length,
    };
  }

  // ── Private Methods ────────────────────────────────
  _bytesToFrameData(bytes) {
    // Pack raw bytes into RGBA pixels
    const pixelCount = this.options.width * this.options.height;
    const buffer = new Uint8Array(pixelCount * 4);

    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const maxBytes = Math.min(src.length, pixelCount * 4);

    // Simple byte-to-pixel packing: 4 bytes → 1 RGBA pixel
    for (let i = 0; i < maxBytes; i++) {
      buffer[i] = src[i];
    }

    // Pad remaining pixels with zeros
    for (let i = maxBytes; i < buffer.length; i++) {
      buffer[i] = 0;
    }

    return new Uint8ClampedArray(buffer.buffer);
  }

  _frameToBytes(frame) {
    // Extract raw bytes from decoded RGBA frame
    const canvas = new OffscreenCanvas(this.options.width, this.options.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frame, 0, 0);

    const imageData = ctx.getImageData(0, 0, this.options.width, this.options.height);
    return new Uint8Array(imageData.data.buffer);
  }

  _onEncodedChunk(chunk, metadata) {
    this.pendingFrames.push({
      data: new Uint8Array(chunk.byteLength),
      keyFrame: chunk.type === 'key',
      timestamp: chunk.timestamp,
    });

    // Copy chunk data
    chunk.copyTo(this.pendingFrames[this.pendingFrames.length - 1].data);

    this.stats.framesEncoded++;
    this.stats.bytesSent += chunk.byteLength;
    this.encodesInFlight--;
  }

  _concatChunks(chunks) {
    let totalLength = 0;
    for (const c of chunks) totalLength += c.data.length;

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      result.set(c.data, offset);
      offset += c.data.length;
    }

    return result;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebCodecsTransport;
}
if (typeof window !== 'undefined') {
  window.WebCodecsTransport = WebCodecsTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.WebCodecsTransport = WebCodecsTransport;
}
