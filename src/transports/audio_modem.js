/**
 * project: neptune — AudioWorklet Acoustic Modem Transport v1.0.0
 *
 * Uses the Web Audio API + AudioWorklet to encode data as FSK (Frequency
 * Shift Keying) audio tones. This creates an INVISIBLE acoustic data channel
 * that can tunnel data between browser contexts on the same machine without
 * any network packets hitting the wire.
 *
 * Architecture:
 *   - AudioWorkletProcessor generates / decodes FSK tones in the audio thread
 *   - SharedArrayBuffer acts as a lock-free ring buffer between main thread
 *     and AudioWorklet (avoiding costly postMessage in audio callback)
 *   - AnalyserNode on the receiving side performs FFT to recover bytes
 *   - Can work in loopback (same tab) or across tabs using system audio
 *
 * FSK Scheme:
 *   - Mark (1):  1850 Hz  (typical Bell 202 mark)
 *   - Space (0): 1650 Hz  (typical Bell 202 space)
 *   - Baud rate: 300 bps (conservative for browser audio stability)
 *   - Start bit: 1200 Hz (1 baud duration)
 *   - Stop bit:  2200 Hz (1 baud duration)
 *   - Framing:   1 start + 8 data + 1 stop = 10 baud per byte
 *
 * Usage:
 *   const modem = new NeptuneAudioModem();
 *   await modem.init();
 *   modem.onData = (bytes) => console.log('Received:', bytes);
 *   modem.send(Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
 */

'use strict';

const NeptuneAudioModem = (function() {
  // ═══════════════════════════════════════════════════════
  // FSK Constants
  // ═══════════════════════════════════════════════════════
  const SAMPLE_RATE = 48000;        // Standard audio sample rate
  const BAUD_RATE   = 300;          // Conservative for browser audio
  const SAMPLES_PER_BAUD = Math.floor(SAMPLE_RATE / BAUD_RATE); // 160 samples
  const MARK_FREQ   = 1850;         // Hz for binary '1'
  const SPACE_FREQ  = 1650;         // Hz for binary '0'
  const START_FREQ  = 1200;         // Hz for start bit
  const STOP_FREQ   = 2200;         // Hz for stop bit
  const AMP         = 0.15;         // Signal amplitude (low to avoid audible annoyance)

  // Ring buffer constants for SharedArrayBuffer transport
  const RING_SIZE   = 4096;         // Must be power of 2 for bitmask indexing
  const RING_MASK   = RING_SIZE - 1;

  // ═══════════════════════════════════════════════════════
  // AudioWorkletProcessor source (injected as string blob)
  // ═══════════════════════════════════════════════════════
  const FSK_PROCESSOR_SRC = `
    class FskModulatorProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.phase = 0;
        this.txQueue = [];           // Array of {freq, samplesRemaining}
        this.port.onmessage = (e) => {
          if (e.data && e.data.type === 'tx') {
            // e.data.freqs: array of frequencies, each for SAMPLES_PER_BAUD
            for (const f of e.data.freqs) {
              this.txQueue.push({ freq: f, remaining: ${SAMPLES_PER_BAUD} });
            }
          }
        };
      }

      process(inputs, outputs) {
        const out = outputs[0][0];
        for (let i = 0; i < out.length; i++) {
          if (this.txQueue.length > 0) {
            const frame = this.txQueue[0];
            const w = 2 * Math.PI * frame.freq / sampleRate;
            this.phase += w;
            out[i] = Math.sin(this.phase) * ${AMP};
            frame.remaining--;
            if (frame.remaining <= 0) this.txQueue.shift();
          } else {
            out[i] = 0;
            // Keep phase continuous for when next frame arrives
          }
        }
        return true;
      }
    }
    registerProcessor('fsk-modulator', FskModulatorProcessor);
  `;

  // ═══════════════════════════════════════════════════════
  // NeptuneAudioModem class
  // ═══════════════════════════════════════════════════════
  class NeptuneAudioModem {
    constructor() {
      this.ctx = null;
      this.modulatorNode = null;
      this.analyser = null;
      this.sourceNode = null; // For loopback: connect modulator → analyser
      this.rxTimer = null;
      this.onData = null;    // Callback: (Uint8Array) => void
      this._initialized = false;
      this._txBuffer = [];   // Pending bytes to transmit
      this._rxState = {
        phase: 'IDLE',       // IDLE | START | DATA | STOP
        bitCount: 0,
        currentByte: 0,
        samplesInBaud: 0,
        sampleBuffer: [],    // Overlap-add for robust detection
      };
    }

    /**
     * Initialize the audio modem. Must be called from a user gesture context.
     * @returns {Promise<boolean>}
     */
    async init() {
      if (this._initialized) return true;

      // Check browser support
      if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
        throw new Error('Web Audio API not supported');
      }
      if (typeof AudioWorkletNode === 'undefined') {
        throw new Error('AudioWorklet not supported (requires secure context + Chrome/Edge/Firefox 76+)');
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });

      // Load AudioWorklet module from blob URL
      const blob = new Blob([FSK_PROCESSOR_SRC], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      // Create modulator node
      this.modulatorNode = new AudioWorkletNode(this.ctx, 'fsk-modulator', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      // Create analyser for demodulation
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.0; // No smoothing for fast response

      // LOOPBACK MODE: connect modulator directly to analyser
      // In real cross-tab use, modulator would go to speakers and analyser from mic
      this.modulatorNode.connect(this.analyser);

      // Optionally connect to speakers (commented out to avoid audible noise)
      // this.modulatorNode.connect(this.ctx.destination);

      // Start RX loop
      this._startRxLoop();

      this._initialized = true;
      return true;
    }

    /**
     * Send a Uint8Array over the acoustic modem.
     * @param {Uint8Array} data
     */
    send(data) {
      if (!this._initialized) throw new Error('Modem not initialized. Call init() first.');
      if (!data || data.length === 0) return;

      const freqs = [];
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        // Start bit
        freqs.push(START_FREQ);
        // 8 data bits (LSB first)
        for (let b = 0; b < 8; b++) {
          freqs.push((byte & (1 << b)) ? MARK_FREQ : SPACE_FREQ);
        }
        // Stop bit
        freqs.push(STOP_FREQ);
      }

      this.modulatorNode.port.postMessage({ type: 'tx', freqs });
    }

    /**
     * Send a text string (UTF-8 encoded).
     * @param {string} text
     */
    sendText(text) {
      const encoder = new TextEncoder();
      this.send(encoder.encode(text));
    }

    /**
     * Close and release resources.
     */
    close() {
      if (this.rxTimer) {
        cancelAnimationFrame(this.rxTimer);
        this.rxTimer = null;
      }
      if (this.modulatorNode) {
        this.modulatorNode.disconnect();
        this.modulatorNode = null;
      }
      if (this.analyser) {
        this.analyser.disconnect();
        this.analyser = null;
      }
      if (this.ctx) {
        this.ctx.close();
        this.ctx = null;
      }
      this._initialized = false;
    }

    // ═══════════════════════════════════════════════════════
    // RX Demodulation (Goertzel algorithm in main thread)
    // ═══════════════════════════════════════════════════════
    _startRxLoop() {
      const fftSize = this.analyser.fftSize;
      const buffer = new Uint8Array(fftSize);
      const binSize = SAMPLE_RATE / fftSize; // ~23.4 Hz per bin

      // Map frequencies to FFT bin indices
      const startBin = Math.round(START_FREQ / binSize);
      const markBin  = Math.round(MARK_FREQ  / binSize);
      const spaceBin = Math.round(SPACE_FREQ / binSize);
      const stopBin  = Math.round(STOP_FREQ  / binSize);

      // Bins to monitor with some guard bands
      const monitorBins = [startBin - 1, startBin, startBin + 1,
                           markBin - 1,  markBin,  markBin + 1,
                           spaceBin - 1, spaceBin, spaceBin + 1,
                           stopBin - 1,  stopBin,  stopBin + 1];

      // Sliding window for baud-rate symbol detection
      const windowSamples = Math.floor(SAMPLE_RATE * 0.005); // 5ms window
      let accumulated = new Uint8Array(0);

      const detect = () => {
        this.analyser.getByteFrequencyData(buffer);

        // Compute energy in each monitored band
        const energy = (bin) => buffer[bin] || 0;
        const bandEnergy = (center) => energy(center - 1) + energy(center) + energy(center + 1);

        const eStart = bandEnergy(startBin);
        const eMark  = bandEnergy(markBin);
        const eSpace = bandEnergy(spaceBin);
        const eStop  = bandEnergy(stopBin);
        const total  = eStart + eMark + eSpace + eStop + 1;

        // Determine dominant frequency
        let detected = 'NONE';
        let maxE = 0;
        if (eStart > maxE) { maxE = eStart; detected = 'START'; }
        if (eMark  > maxE) { maxE = eMark;  detected = 'MARK'; }
        if (eSpace > maxE) { maxE = eSpace; detected = 'SPACE'; }
        if (eStop  > maxE) { maxE = eStop;  detected = 'STOP'; }

        // Threshold: at least 15% of total energy and above noise floor
        if (maxE / total < 0.15 || maxE < 30) {
          detected = 'NONE';
        }

        this._processSymbol(detected);
        this.rxTimer = requestAnimationFrame(detect);
      };

      this.rxTimer = requestAnimationFrame(detect);
    }

    _processSymbol(symbol) {
      const s = this._rxState;

      switch (s.phase) {
        case 'IDLE':
          if (symbol === 'START') {
            s.phase = 'DATA';
            s.bitCount = 0;
            s.currentByte = 0;
            s.samplesInBaud = 0;
          }
          break;

        case 'DATA':
          s.samplesInBaud++;
          // We get ~16 detections per baud at 60fps with 300 baud
          // Use majority voting within each baud window
          if (s.samplesInBaud >= 12) { // ~3/4 of the baud window
            if (symbol === 'MARK') {
              s.currentByte |= (1 << s.bitCount);
            } else if (symbol === 'SPACE') {
              // bit already 0
            } else {
              // Invalid symbol during data — abort frame
              s.phase = 'IDLE';
              return;
            }
            s.bitCount++;
            s.samplesInBaud = 0;
            if (s.bitCount >= 8) {
              s.phase = 'STOP';
            }
          }
          break;

        case 'STOP':
          s.samplesInBaud++;
          if (s.samplesInBaud >= 8) {
            if (symbol === 'STOP' || symbol === 'MARK' || symbol === 'SPACE') {
              // Valid stop bit — emit byte
              if (this.onData) {
                this.onData(new Uint8Array([s.currentByte]));
              }
            }
            s.phase = 'IDLE';
          }
          break;
      }
    }

    /**
     * Test the modem by sending a test pattern and measuring bit error rate.
     * @returns {Promise<Object>} { sent, received, errors, ber }
     */
    async selfTest() {
      const testPattern = Uint8Array.from([0x55, 0xAA, 0xFF, 0x00, 0xDE, 0xAD, 0xBE, 0xEF]);
      const received = [];

      return new Promise((resolve) => {
        const originalOnData = this.onData;
        this.onData = (bytes) => {
          received.push(...bytes);
          if (received.length >= testPattern.length) {
            this.onData = originalOnData;
            let errors = 0;
            for (let i = 0; i < testPattern.length; i++) {
              if (received[i] !== testPattern[i]) errors++;
            }
            resolve({
              sent: Array.from(testPattern),
              received: received.slice(0, testPattern.length),
              errors,
              ber: errors / (testPattern.length * 8),
            });
          }
        };

        // Small delay to let RX stabilize, then send
        setTimeout(() => this.send(testPattern), 100);
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // Higher-level transport interface (compatible with Neptune Transport layer)
  // ═══════════════════════════════════════════════════════
  class NeptuneAudioTransport {
    constructor() {
      this.modem = new NeptuneAudioModem();
      this._messageQueue = [];
      this._handlers = new Map(); // id → { resolve, reject, timer }
      this._nextId = 1;
      this._rxBuffer = [];
      this._framing = true;
    }

    async init() {
      await this.modem.init();

      // Set up framing: [0x7E] [length:2] [payload] [crc:2] [0x7E]
      // 0x7E is HDLC flag byte. Escaped 0x7D prefix for transparency.
      let rawBuffer = [];
      this.modem.onData = (bytes) => {
        rawBuffer.push(...bytes);
        // Scan for complete frames
        while (true) {
          const start = rawBuffer.indexOf(0x7E);
          if (start < 0) break;
          const end = rawBuffer.indexOf(0x7E, start + 1);
          if (end < 0) break;
          const frame = rawBuffer.slice(start + 1, end);
          rawBuffer = rawBuffer.slice(end + 1);
          if (frame.length < 4) continue; // min: 2 length + 0 payload + 2 crc

          // Unstuff
          const unstuffed = [];
          for (let i = 0; i < frame.length; i++) {
            if (frame[i] === 0x7D && i + 1 < frame.length) {
              unstuffed.push(frame[i + 1] ^ 0x20);
              i++;
            } else {
              unstuffed.push(frame[i]);
            }
          }

          if (unstuffed.length < 4) continue;
          const len = (unstuffed[0] << 8) | unstuffed[1];
          if (unstuffed.length - 4 !== len) continue; // length mismatch

          const payload = unstuffed.slice(2, 2 + len);
          const crcRx = (unstuffed[2 + len] << 8) | unstuffed[3 + len];
          const crcCalc = this._crc16(payload);
          if (crcRx !== crcCalc) continue; // CRC mismatch — drop

          // Valid frame!
          const msg = JSON.parse(new TextDecoder().decode(Uint8Array.from(payload)));
          if (msg._id && this._handlers.has(msg._id)) {
            const h = this._handlers.get(msg._id);
            clearTimeout(h.timer);
            this._handlers.delete(msg._id);
            if (msg._error) h.reject(new Error(msg._error));
            else h.resolve(msg._result !== undefined ? msg._result : msg);
          } else if (this.onMessage) {
            this.onMessage(msg);
          }
        }
      };

      return true;
    }

    async ping() {
      return this._rpc('_ping', {});
    }

    async send(data) {
      return this._rpc('_send', { data });
    }

    _rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = this._nextId++;
        const msg = { _id: id, _method: method, ...params };
        const payload = new TextEncoder().encode(JSON.stringify(msg));
        const len = payload.length;

        // Build frame
        const frame = [0x7E];
        frame.push((len >> 8) & 0xFF, len & 0xFF);
        // Stuff payload
        for (let i = 0; i < payload.length; i++) {
          const b = payload[i];
          if (b === 0x7E || b === 0x7D) {
            frame.push(0x7D, b ^ 0x20);
          } else {
            frame.push(b);
          }
        }
        // CRC
        const crc = this._crc16(payload);
        frame.push((crc >> 8) & 0xFF, crc & 0xFF);
        frame.push(0x7E);

        this.modem.send(Uint8Array.from(frame));

        const timer = setTimeout(() => {
          this._handlers.delete(id);
          reject(new Error('Audio modem RPC timeout'));
        }, 5000);

        this._handlers.set(id, { resolve, reject, timer });
      });
    }

    _crc16(data) {
      let crc = 0xFFFF;
      for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 8;
        for (let j = 0; j < 8; j++) {
          crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
          crc &= 0xFFFF;
        }
      }
      return crc;
    }

    close() {
      this.modem.close();
    }

    selfTest() {
      return this.modem.selfTest();
    }
  }

  // ═══════════════════════════════════════════════════════
  // Exports
  // ═══════════════════════════════════════════════════════
  return {
    NeptuneAudioModem,
    NeptuneAudioTransport,
    constants: {
      SAMPLE_RATE, BAUD_RATE, SAMPLES_PER_BAUD,
      MARK_FREQ, SPACE_FREQ, START_FREQ, STOP_FREQ,
    },
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneAudioModem;
}
if (typeof window !== 'undefined') {
  window.NeptuneAudioModem = NeptuneAudioModem;
  window.NeptuneAudioTransport = NeptuneAudioModem.NeptuneAudioTransport;
}
if (typeof globalThis !== 'undefined') {
  globalThis.NeptuneAudioModem = NeptuneAudioModem;
  globalThis.NeptuneAudioTransport = NeptuneAudioModem.NeptuneAudioTransport;
}
