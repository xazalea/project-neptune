/**
 * project: neptune — SVG GPU Filter Pipeline Transport v1.0.0
 * Track D: SVG GPU Filter Pipeline — Shader-Based HTTP
 *
 * EXPERIMENTAL: Encodes HTTP requests as pixel data processed
 * through SVG filter chains (feColorMatrix, feComponentTransfer,
 * feConvolveMatrix) leveraging GPU fragment shaders.
 *
 * The concept:
 *   1. Encode HTTP request as structured pixel grid in SVG <image>
 *   2. Apply SVG filter chain as computation (GPU shader pipeline)
 *   3. SVG filter output IS the HTTP response encoded as pixel data
 *   4. Read pixels back via Canvas → getImageData()
 *
 * CRITICAL ISSUE: Canvas tainting rules likely block getImageData()
 * on cross-origin SVG filter output. This transport exists as a
 * research artifact and may become viable if browser security models
 * change or if the entire pipeline is same-origin.
 *
 * Included for completeness and as a reference implementation of
 * the concept described in the research document.
 */

'use strict';

class SvgGpuTransport {
  constructor(options = {}) {
    this.options = Object.assign({
      gridWidth: 256,
      gridHeight: 256,
      bytesPerPixel: 4,         // RGBA
    }, options);

    this.initialized = false;
    this.canvas = null;
    this.ctx = null;
    this.stats = {
      pixelsRead: 0,
      pixelsWritten: 0,
      requestsEncoded: 0,
      responsesDecoded: 0,
      errors: 0,
    };
  }

  // ── Detection ──────────────────────────────────────
  static async detect() {
    try {
      // Test SVG filter support
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      if (typeof svg.createSVGMatrix === 'undefined') {
        // Some browsers may have partial SVG support
      }

      // Test canvas 2D context
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.getImageData !== 'function') {
        return { available: false, reason: 'Canvas 2D not available' };
      }

      // Test SVG filter string creation
      const filterString = SvgGpuTransport._buildRequestFilter(
        'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'
      );
      if (!filterString || filterString.length === 0) {
        return { available: false, reason: 'SVG filter construction failed' };
      }

      return { available: true, maxGridSize: 512 };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  static getCapabilities() {
    return {
      name: 'svg-gpu-pipeline',
      tier: 'experimental',
      priority: 5,
      requiresServiceWorker: false,
      requiresWASM: false,
      requiresExternalRelay: false,
      requiresLocalHelper: false,
      supportsEncrypted: false,
      maxThroughput: 50,
      latency: 50,
      browserSupport: ['chrome', 'firefox', 'safari', 'edge'],
    };
  }

  // ── Initialization ────────────────────────────────
  async init() {
    if (this.initialized) return true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.options.gridWidth;
    this.canvas.height = this.options.gridHeight;
    this.ctx = this.canvas.getContext('2d');

    this.initialized = true;
    console.log('[SVG_GPU] Initialized — SVG GPU pipeline ready');
    return true;
  }

  // ── Request Encoding ───────────────────────────────
  /**
   * Encode an HTTP request as an SVG filter chain.
   * The filter output represents the HTTP response.
   *
   * NOTE: This is a SIMULATION. Actual HTTP responses do not
   * come from SVG filters. This demonstrates the concept of
   * encoding computation in SVG filter pipelines.
   */
  async encodeRequest(method, host, path, headers, body) {
    if (!this.initialized) await this.init();

    // Build HTTP request string
    let requestStr = `${method} ${path} HTTP/1.1\r\n`;
    requestStr += `Host: ${host}\r\n`;
    for (const [k, v] of Object.entries(headers || {})) {
      requestStr += `${k}: ${v}\r\n`;
    }
    requestStr += '\r\n';

    // Encode into pixel grid
    const pixels = this._textToPixels(requestStr);
    this.stats.pixelsWritten += pixels.length / 4;
    this.stats.requestsEncoded++;

    // Build SVG with filter chain
    const svg = this._buildSvgWithFilter(pixels, requestStr.length);

    return {
      svg,
      pixelCount: pixels.length / 4,
      requestLength: requestStr.length,
    };
  }

  /**
   * "Execute" the SVG filter pipeline by rendering it to canvas
   * and reading back the result pixels. WARNING: Canvas tainting
   * may cause this to throw SecurityError for external resources.
   */
  async decodeResponse(svg) {
    if (!this.initialized) await this.init();

    return new Promise((resolve, reject) => {
      const img = new Image();
      const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);

      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(img, 0, 0);

          // THIS IS THE CRITICAL LINE — likely throws SecurityError
          const imageData = this.ctx.getImageData(
            0, 0,
            this.options.gridWidth,
            this.options.gridHeight
          );

          this.stats.pixelsRead += imageData.data.length / 4;
          this.stats.responsesDecoded++;

          const responseText = this._pixelsToText(imageData.data);
          resolve(responseText);
        } catch (e) {
          this.stats.errors++;
          reject(new Error(
            'SVG GPU pipeline blocked by canvas tainting. ' +
            'This is expected — the browser security model prevents ' +
            'reading cross-origin SVG filter output via getImageData(). ' +
            'Original error: ' + e.message
          ));
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        this.stats.errors++;
        reject(new Error('SVG image failed to load'));
      };

      img.src = url;
    });
  }

  // ── Transport Interface ────────────────────────────
  async connect(host, port) {
    throw new Error(
      'SVG GPU transport is experimental. It cannot establish ' +
      'real TCP connections. The SVG filter pipeline concept is ' +
      'a research artifact — canvas tainting blocks pixel reading.'
    );
  }

  async send(streamId, data) {
    throw new Error('SVG GPU transport does not support send');
  }

  async recv(streamId) {
    throw new Error('SVG GPU transport does not support recv');
  }

  close(streamId) {}

  async destroy() {
    this.canvas = null;
    this.ctx = null;
    this.initialized = false;
  }

  getStats() {
    return {
      ...this.stats,
      initialized: this.initialized,
    };
  }

  // ── Private: SVG Filter Construction ───────────────
  static _buildRequestFilter(requestStr) {
    // Build a complex SVG filter chain that transforms input
    // pixels based on the request bytes. Each byte of the request
    // becomes a filter parameter.
    const bytes = new TextEncoder().encode(requestStr);
    const filters = [];

    filters.push('<filter id="neptune-request" x="0" y="0" width="100%" height="100%">');

    // feColorMatrix encodes request byte values as color transformations
    for (let i = 0; i < Math.min(bytes.length, 20); i++) {
      const b = bytes[i];
      const r = ((b >> 5) & 0x7) / 7.0;       // 3 bits → red multiplier
      const g = ((b >> 2) & 0x7) / 7.0;       // 3 bits → green multiplier
      const bl = (b & 0x3) / 3.0;             // 2 bits → blue offset

      filters.push(`<feColorMatrix type="matrix" in="SourceGraphic"
        values="${r} 0 0 0 ${g}
                0 ${bl} 0 0 ${r}
                0 0 ${g} 0 ${bl}
                0 0 0 1 0"/>`);
    }

    // feComponentTransfer applies nonlinear byte-to-color mappings
    filters.push('<feComponentTransfer in="SourceGraphic">');
    for (const channel of ['R', 'G', 'B']) {
      filters.push(`<feFunc${channel} type="table"
        tableValues="0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0"/>`);
    }
    filters.push('</feComponentTransfer>');

    // feConvolveMatrix applies computational convolution
    filters.push(`<feConvolveMatrix order="3" kernelMatrix="
      0 -1 0
      -1 5 -1
      0 -1 0" edgeMode="none"/>`);

    filters.push('</filter>');

    return filters.join('\n');
  }

  _buildSvgWithFilter(pixels, requestLength) {
    const filterStr = SvgGpuTransport._buildRequestFilter(
      `HTTP/1.1 REQUEST (${requestLength} bytes)`
    );

    // Build pixel data as base64 PNG data URL via canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.options.gridWidth;
    tempCanvas.height = this.options.gridHeight;
    const tempCtx = tempCanvas.getContext('2d');
    const imageData = tempCtx.createImageData(this.options.gridWidth, this.options.gridHeight);
    imageData.data.set(pixels);
    tempCtx.putImageData(imageData, 0, 0);
    const pixelDataUrl = tempCanvas.toDataURL('image/png');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${this.options.gridWidth}" height="${this.options.gridHeight}">
  <defs>
    ${filterStr}
  </defs>
  <image x="0" y="0"
         width="${this.options.gridWidth}" height="${this.options.gridHeight}"
         xlink:href="${pixelDataUrl}"
         filter="url(#neptune-request)"/>
</svg>`;
  }

  // ── Private: Pixel Encoding ────────────────────────
  _textToPixels(text) {
    const bytes = new TextEncoder().encode(text);
    const pixelCount = this.options.gridWidth * this.options.gridHeight;
    const buffer = new Uint8ClampedArray(pixelCount * 4);

    // Pack bytes into RGBA pixels
    for (let i = 0; i < bytes.length && i < pixelCount * 4; i++) {
      buffer[i] = bytes[i];
    }

    // Fill remaining with structured noise (allows filter to transform)
    for (let i = bytes.length; i < buffer.length; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }

    return buffer;
  }

  _pixelsToText(pixels) {
    // Extract text bytes from RGBA pixel data
    // Only extract non-zero, non-noise bytes
    const bytes = [];
    for (let i = 0; i < pixels.length; i += 4) {
      // Check if this pixel looks like "structured" data vs noise
      if (pixels[i] > 20 && pixels[i] < 127) {
        bytes.push(pixels[i]);     // R → byte 0
        bytes.push(pixels[i + 1]); // G → byte 1
        bytes.push(pixels[i + 2]); // B → byte 2
        bytes.push(pixels[i + 3]); // A → byte 3
      }
    }

    // Try to decode as text, filtering printable ASCII
    const raw = new TextDecoder().decode(new Uint8Array(bytes));
    const filtered = raw.replace(/[^\x20-\x7E\r\n\t]/g, '');
    return filtered || '(SVG GPU pipeline produced no decodable output)';
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SvgGpuTransport;
}
if (typeof window !== 'undefined') {
  window.SvgGpuTransport = SvgGpuTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.SvgGpuTransport = SvgGpuTransport;
}
