/**
 * project: neptune — Network Adapter (fetch()-based Ethernet bridge)
 * v3.0.0
 *
 * Bridges the smoltcp WASM TCP/IP stack's Ethernet frames to real network I/O
 * via the ServiceWorker's fetch() API. Zero external servers required.
 *
 * Architecture:
 *   smoltcp (WASM) → Ethernet frame → tx_callback → NetworkAdapter
 *   NetworkAdapter → parse ARP/IP/TCP → SW postMessage → SW fetch() → Internet
 *   Internet → SW fetch() response → SW postMessage → NetworkAdapter
 *   NetworkAdapter → build TCP/IP/Ethernet headers → feed_rx() → smoltcp
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════
  // NetworkAdapter class
  // ═══════════════════════════════════════════════════════
  class NetworkAdapter {
    constructor(netStack) {
      this.stack = netStack;          // NeptuneNetStack WASM instance
      this.sw = null;                  // ServiceWorker controller ref
      this.pendingConnections = new Map(); // localPort → {host, port, buffers, timer}
      this.pollInterval = null;
      this.lastPollTime = 0;
      this.rxQueue = [];               // Deferred RX frames (avoids deadlock during poll)
      this.polling = false;            // Flag to detect re-entrant poll()
      this.stats = { framesIn: 0, framesOut: 0, arpHandled: 0, tcpSegments: 0, bytesRx: 0, bytesTx: 0 };

      // Virtual network addresses
      this.hostMac = [0x02, 0x00, 0x00, 0x00, 0x00, 0x02];
      this.gatewayMac = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01];
      this.hostIp = [10, 0, 0, 2];
      this.gatewayIp = [10, 0, 0, 1];
      this.netmask = [255, 255, 255, 0];

      // Listen for SW responses
      if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', this._onSWMessage.bind(this));
      }

      console.log('[NETADAPT] NetworkAdapter initialized');
      console.log('[NETADAPT]   Host:  ' + this.hostIp.join('.') + ' (MAC: ' + this._macStr(this.hostMac) + ')');
      console.log('[NETADAPT]   GW:    ' + this.gatewayIp.join('.') + ' (MAC: ' + this._macStr(this.gatewayMac) + ')');
    }

    /**
     * Start the network adapter. Called after SW is registered.
     */
    start() {
      this.sw = navigator.serviceWorker.controller;
      if (!this.sw) {
        console.warn('[NETADAPT] No SW controller available');
        return false;
      }

      // Poll smoltcp every 50ms for responsiveness
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        this._poll();
      }, 50);

      // Initial poll
      this._poll();

      console.log('[NETADAPT] Started (poll interval: 50ms)');
      return true;
    }

    stop() {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    }

    /**
     * tx_callback for smoltcp — receives raw Ethernet frames
     * @param {Uint8Array} frame - Raw Ethernet frame bytes
     */
    handleTxFrame(frame) {
      this.stats.framesOut++;
      const bytes = new Uint8Array(frame);
      if (bytes.length < 14) return; // Frame too short

      const etherType = (bytes[12] << 8) | bytes[13];

      try {
        if (etherType === 0x0806) {
          this._handleArp(bytes);
        } else if (etherType === 0x0800) {
          this._handleIpv4(bytes);
        }
        // Ignore other EtherTypes (IPv6=0x86DD, etc.)
      } catch (e) {
        console.error('[NETADAPT] Frame processing error:', e.message);
      }
    }

    /**
     * Handle ARP request/response
     */
    _handleArp(frame) {
      if (frame.length < 42) return;

      const htype = (frame[14] << 8) | frame[15];
      const ptype = (frame[16] << 8) | frame[17];
      const hlen = frame[18];
      const plen = frame[19];
      const oper = (frame[20] << 8) | frame[21];

      // Only handle Ethernet/IP ARP requests
      if (htype !== 1 || ptype !== 0x0800 || hlen !== 6 || plen !== 4) return;
      if (oper !== 1) return; // Only ARP Request

      const targetIp = [frame[38], frame[39], frame[40], frame[41]];

      // Respond to ARP for gateway IP
      if (this._ipEq(targetIp, this.gatewayIp)) {
        this.stats.arpHandled++;

        // Build ARP reply
        const reply = new Uint8Array(42);
        // Ethernet header
        reply.set(frame.slice(6, 12), 0);   // dst = sender MAC
        reply.set(this.gatewayMac, 6);       // src = gateway MAC
        reply[12] = 0x08; reply[13] = 0x06;  // EtherType = ARP

        // ARP header
        reply[14] = 0x00; reply[15] = 0x01;  // HTYPE = Ethernet
        reply[16] = 0x08; reply[17] = 0x00;  // PTYPE = IPv4
        reply[18] = 6;                        // HLEN
        reply[19] = 4;                        // PLEN
        reply[20] = 0x00; reply[21] = 0x02;  // OPER = Reply
        reply.set(this.gatewayMac, 22);       // SHA = gateway MAC
        reply.set(this.gatewayIp, 28);        // SPA = gateway IP
        reply.set(frame.slice(22, 28), 32);   // THA = sender MAC
        reply.set(frame.slice(28, 32), 38);   // TPA = sender IP

        this._feedToStack(reply);
      }
    }

    /**
     * Handle IPv4 packet — extract TCP and forward to SW
     */
    _handleIpv4(frame) {
      if (frame.length < 34) return; // Ethernet(14) + IP min(20)

      const ipHeaderLen = (frame[14] & 0x0F) * 4;
      if (ipHeaderLen < 20 || frame.length < 14 + ipHeaderLen) return;

      const protocol = frame[14 + 9];
      if (protocol !== 6) return; // Only TCP for now

      const srcIp = [frame[26], frame[27], frame[28], frame[29]];
      const dstIp = [frame[30], frame[31], frame[32], frame[33]];

      const ipPayload = frame.slice(14 + ipHeaderLen);
      if (ipPayload.length < 20) return; // TCP header min 20 bytes

      // Parse TCP header
      const srcPort = (ipPayload[0] << 8) | ipPayload[1];
      const dstPort = (ipPayload[2] << 8) | ipPayload[3];
      const seqNum = ((ipPayload[4] << 24) | (ipPayload[5] << 16) | (ipPayload[6] << 8) | ipPayload[7]) >>> 0;
      const ackNum = ((ipPayload[8] << 24) | (ipPayload[9] << 16) | (ipPayload[10] << 8) | ipPayload[11]) >>> 0;
      const dataOffset = ((ipPayload[12] >> 4) & 0x0F) * 4;
      const flags = ipPayload[13];
      const windowSize = (ipPayload[14] << 8) | ipPayload[15];

      const tcpPayload = ipPayload.slice(dataOffset);

      this.stats.tcpSegments++;

      const isSyn = (flags & 0x02) !== 0;
      const isAck = (flags & 0x10) !== 0;
      const isFin = (flags & 0x01) !== 0;
      const isRst = (flags & 0x04) !== 0;
      const isPsh = (flags & 0x08) !== 0;

      // For our use case, smoltcp will initiate TCP connections to external hosts
      // The source port is smoltcp's local port, destination is external
      const localPort = srcPort;
      const externalIp = this._ipStr(dstIp);
      const externalPort = dstPort;

      // Handle TCP state
      if (isSyn && !isAck) {
        // New connection from smoltcp to external host
        this._handleOutboundConnect(localPort, externalIp, externalPort, seqNum);
      } else if (isRst) {
        // Connection reset
        this._handleReset(localPort);
      } else if (tcpPayload.length > 0 || (isPsh && isAck)) {
        // Data segment
        this._handleOutboundData(localPort, tcpPayload, seqNum, ackNum, flags);
      } else if (isFin) {
        // Connection close
        this._handleOutboundClose(localPort);
      }
    }

    /**
     * Outbound TCP SYN — open an HTTP connection via SW
     */
    _handleOutboundConnect(localPort, ip, port, clientSeq) {
      // Try to resolve which host this IP corresponds to
      // For now, try to reverse-map from known hosts or use IP directly
      const host = this._resolveHostFromIp(ip) || ip;

      console.log('[NETADAPT] TCP CONNECT:', host + ':' + port, '(local port ' + localPort + ')');

      // Send SYN-ACK back to smoltcp immediately to complete handshake
      // This lets smoltcp proceed; actual connection happens via SW fetch
      const synAck = this._buildTcpSegment(
        localPort, port,
        this._randomSeq(), clientSeq + 1, // Server seq and ack
        0x12, // SYN+ACK flags
        65535, // Window
        null // No payload
      );
      this._feedToStack(synAck);

      // Send connect message to SW
      this._sendToSW({
        type: 'NET_ADAPT_CONNECT',
        localPort: localPort,
        targetHost: host,
        targetPort: port,
      });
    }

    /**
     * Outbound TCP data — forward to SW for HTTP fetch
     */
    _handleOutboundData(localPort, payload, clientSeq, clientAck, flags) {
      this.stats.bytesTx += payload.length;

      // Send data to SW
      this._sendToSW({
        type: 'NET_ADAPT_DATA',
        localPort: localPort,
        data: Array.from(payload),
        seq: clientSeq,
        ack: clientAck,
      });
    }

    /**
     * Outbound TCP FIN — close connection
     */
    _handleOutboundClose(localPort) {
      console.log('[NETADAPT] TCP CLOSE local_port=' + localPort);

      this._sendToSW({
        type: 'NET_ADAPT_CLOSE',
        localPort: localPort,
      });

      this.pendingConnections.delete(localPort);
    }

    /**
     * Outbound TCP RST
     */
    _handleReset(localPort) {
      console.log('[NETADAPT] TCP RST local_port=' + localPort);
      this.pendingConnections.delete(localPort);
    }

    /**
     * Incoming data from SW — wrap in TCP/IP/Ethernet and feed to smoltcp
     */
    _handleIncomingData(localPort, data, isClose) {
      this.stats.bytesRx += data.length;
      // framesIn is incremented by _feedToStack (single source of truth)

      // Build TCP segment
      const tcpFlags = isClose ? 0x11 : 0x18; // FIN+ACK or PSH+ACK
      const serverSeq = this._randomSeq();
      const serverAck = 1; // Simplified

      const segment = this._buildTcpSegment(
        80, // "server" port (HTTP)
        localPort,
        serverSeq,
        serverAck,
        tcpFlags,
        65535,
        data
      );

      this._feedToStack(segment);
    }

    // ═══════════════════════════════════════════════════════
    // SW message handler
    // ═══════════════════════════════════════════════════════
    _onSWMessage(event) {
      const d = event.data;
      if (!d || !d.type) return;

      switch (d.type) {
        case 'NET_ADAPT_RESPONSE':
          // SW fetched HTTP response, pass raw bytes to smoltcp
          if (d.localPort && d.data) {
            const data = new Uint8Array(d.data);
            this._handleIncomingData(d.localPort, data, d.close || false);
          }
          break;

        case 'NET_ADAPT_CLOSED':
          // Connection closed by remote
          if (d.localPort) {
            this._handleIncomingData(d.localPort, new Uint8Array(0), true);
          }
          break;

        case 'NET_ADAPT_ERROR':
          console.error('[NETADAPT] SW error for port', d.localPort, ':', d.error);
          // Send RST to smoltcp
          if (d.localPort) {
            const rst = this._buildTcpSegment(
              80, d.localPort,
              0, 0,
              0x04, // RST
              0,
              null
            );
            this._feedToStack(rst);
          }
          break;
      }
    }

    // ═══════════════════════════════════════════════════════
    // Poll smoltcp
    // ═══════════════════════════════════════════════════════
    _poll() {
      if (!this.stack || !this.stack.poll) return;

      // Prevent re-entrant poll (TX callback might try to poll again)
      if (this.polling) return;
      this.polling = true;

      try {
        // Drain any queued RX frames from previous poll cycle
        while (this.rxQueue.length > 0) {
          const frame = this.rxQueue.shift();
          try {
            this.stats.framesIn++;
            this.stack.feed_rx(frame);
          } catch (e) {
            console.error('[NETADAPT] feed_rx error:', e.message);
          }
        }

        // Poll the stack (may trigger TX callbacks that enqueue RX frames)
        this.stack.poll();

        // Process newly queued RX frames after poll released the mutex.
        // Only re-poll if we actually drained new frames.
        let drained = false;
        while (this.rxQueue.length > 0) {
          drained = true;
          const frame = this.rxQueue.shift();
          try {
            this.stats.framesIn++;
            this.stack.feed_rx(frame);
          } catch (e) {
            console.error('[NETADAPT] feed_rx error:', e.message);
          }
        }

        if (drained) {
          // Poll again to process responses to the queued frames
          this.stack.poll();
        }
      } catch (e) {
        console.error('[NETADAPT] Poll error:', e.message);
      } finally {
        this.polling = false;
      }
    }

    // ═══════════════════════════════════════════════════════
    // Packet construction helpers
    // ═══════════════════════════════════════════════════════

    /**
     * Build a complete Ethernet + IP + TCP segment
     */
    _buildTcpSegment(srcPort, dstPort, seq, ack, flags, window, payload) {
      const payloadLen = payload ? payload.length : 0;
      const tcpHeaderLen = 20;
      const ipHeaderLen = 20;
      const totalLen = 14 + ipHeaderLen + tcpHeaderLen + payloadLen;

      const frame = new Uint8Array(totalLen);

      // Ethernet header
      frame.set(this.hostMac, 0);         // dst = host MAC
      frame.set(this.gatewayMac, 6);      // src = gateway MAC (packet comes FROM gateway)
      frame[12] = 0x08; frame[13] = 0x00; // EtherType = IPv4

      // IP header (offset 14)
      const ipOff = 14;
      frame[ipOff] = 0x45;                  // Version=4, IHL=5
      frame[ipOff + 1] = 0x00;              // DSCP/ECN
      const ipTotalLen = ipHeaderLen + tcpHeaderLen + payloadLen;
      frame[ipOff + 2] = (ipTotalLen >> 8) & 0xFF;
      frame[ipOff + 3] = ipTotalLen & 0xFF;
      frame[ipOff + 4] = 0x00; frame[ipOff + 5] = 0x01; // ID
      frame[ipOff + 6] = 0x40; frame[ipOff + 7] = 0x00; // Flags, Fragment
      frame[ipOff + 8] = 64;                // TTL
      frame[ipOff + 9] = 6;                 // Protocol = TCP
      // Checksum (bytes 10-11) filled below
      frame.set(this.gatewayIp, ipOff + 12); // Src IP = gateway
      frame.set(this.hostIp, ipOff + 16);    // Dst IP = host

      // TCP header (offset 34)
      const tcpOff = 14 + ipHeaderLen;
      frame[tcpOff] = (srcPort >> 8) & 0xFF;
      frame[tcpOff + 1] = srcPort & 0xFF;
      frame[tcpOff + 2] = (dstPort >> 8) & 0xFF;
      frame[tcpOff + 3] = dstPort & 0xFF;
      // Sequence number
      frame[tcpOff + 4] = (seq >> 24) & 0xFF;
      frame[tcpOff + 5] = (seq >> 16) & 0xFF;
      frame[tcpOff + 6] = (seq >> 8) & 0xFF;
      frame[tcpOff + 7] = seq & 0xFF;
      // Ack number
      frame[tcpOff + 8] = (ack >> 24) & 0xFF;
      frame[tcpOff + 9] = (ack >> 16) & 0xFF;
      frame[tcpOff + 10] = (ack >> 8) & 0xFF;
      frame[tcpOff + 11] = ack & 0xFF;
      // Data offset (5 * 4 = 20 bytes) + reserved
      frame[tcpOff + 12] = (5 << 4) & 0xF0;
      // Flags
      frame[tcpOff + 13] = flags;
      // Window
      frame[tcpOff + 14] = (window >> 8) & 0xFF;
      frame[tcpOff + 15] = window & 0xFF;
      // Checksum (bytes 16-17) filled below
      frame[tcpOff + 16] = 0x00;
      frame[tcpOff + 17] = 0x00;
      // Urgent pointer
      frame[tcpOff + 18] = 0x00;
      frame[tcpOff + 19] = 0x00;

      // TCP payload
      if (payload && payloadLen > 0) {
        frame.set(payload, tcpOff + 20);
      }

      // Compute TCP checksum (includes pseudo-header)
      const tcpChecksum = this._tcpChecksum(frame, tcpOff, ipOff);
      frame[tcpOff + 16] = (tcpChecksum >> 8) & 0xFF;
      frame[tcpOff + 17] = tcpChecksum & 0xFF;

      // Compute IP checksum
      const ipChecksum = this._ipChecksum(frame, ipOff, ipHeaderLen);
      frame[ipOff + 10] = (ipChecksum >> 8) & 0xFF;
      frame[ipOff + 11] = ipChecksum & 0xFF;

      return frame;
    }

    /**
     * Build ARP reply frame
     */
    _buildArpReply(requestFrame) {
      const reply = new Uint8Array(42);
      // Copy Ethernet header from request but swap
      reply.set(requestFrame.slice(6, 12), 0);  // dst = sender MAC
      reply.set(this.gatewayMac, 6);             // src = gateway MAC
      reply[12] = 0x08; reply[13] = 0x06;        // EtherType = ARP

      const arpOff = 14;
      reply[arpOff] = 0x00; reply[arpOff + 1] = 0x01;  // HTYPE
      reply[arpOff + 2] = 0x08; reply[arpOff + 3] = 0x00; // PTYPE
      reply[arpOff + 4] = 6;                              // HLEN
      reply[arpOff + 5] = 4;                              // PLEN
      reply[arpOff + 6] = 0x00; reply[arpOff + 7] = 0x02; // OPER = Reply
      reply.set(this.gatewayMac, arpOff + 8);              // SHA
      reply.set(this.gatewayIp, arpOff + 14);              // SPA
      reply.set(requestFrame.slice(22, 28), arpOff + 18);  // THA = sender MAC
      reply.set(requestFrame.slice(28, 32), arpOff + 24);  // TPA = sender IP

      return reply;
    }

    // ═══════════════════════════════════════════════════════
    // Checksum helpers
    // ═══════════════════════════════════════════════════════

    _ipChecksum(frame, offset, headerLen) {
      let sum = 0;
      for (let i = 0; i < headerLen; i += 2) {
        const word = (frame[offset + i] << 8) | (frame[offset + i + 1] || 0);
        sum += word;
      }
      while (sum > 0xFFFF) {
        sum = (sum & 0xFFFF) + (sum >> 16);
      }
      return (~sum) & 0xFFFF;
    }

    _tcpChecksum(frame, tcpOff, ipOff) {
      let sum = 0;

      // Pseudo-header
      sum += (frame[ipOff + 12] << 8) | frame[ipOff + 13]; // src IP
      sum += (frame[ipOff + 14] << 8) | frame[ipOff + 15];
      sum += (frame[ipOff + 16] << 8) | frame[ipOff + 17]; // dst IP
      sum += (frame[ipOff + 18] << 8) | frame[ipOff + 19];
      sum += 6; // Protocol = TCP

      const tcpLen = frame.length - tcpOff;
      sum += tcpLen; // TCP length

      // TCP header + payload
      for (let i = 0; i < tcpLen; i += 2) {
        const word = (frame[tcpOff + i] << 8) | (frame[tcpOff + i + 1] || 0);
        sum += word;
      }

      while (sum > 0xFFFF) {
        sum = (sum & 0xFFFF) + (sum >> 16);
      }
      return (~sum) & 0xFFFF;
    }

    // ═══════════════════════════════════════════════════════
    // Utilities
    // ═══════════════════════════════════════════════════════

    /**
     * Feed data to smoltcp stack.
     * If called during poll() (e.g., from TX callback that builds ARP replies),
     * the frame is queued to avoid re-entrant lock. Otherwise, feeds directly.
     */
    _feedToStack(data) {
      if (this.polling) {
        // Inside TX callback during poll — queue to avoid deadlock
        this.rxQueue.push(data);
      } else {
        try {
          if (this.stack && this.stack.feed_rx) {
            this.stats.framesIn++;
            this.stack.feed_rx(data);
          }
        } catch (e) {
          console.error('[NETADAPT] feed_rx error:', e.message);
        }
      }
    }

    _sendToSW(msg) {
      if (this.sw) {
        this.sw.postMessage(msg);
      }
    }

    _randomSeq() {
      return (Math.random() * 0xFFFFFFFF) >>> 0;
    }

    _ipEq(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    }

    _ipStr(ip) {
      return ip.join('.');
    }

    _macStr(mac) {
      return mac.map(b => b.toString(16).padStart(2, '0')).join(':');
    }

    /**
     * Reverse DNS map for known hosts
     */
    _resolveHostFromIp(ip) {
      const ipStr = this._ipStr(ip);
      const known = {
        '93.184.216.34': 'example.com',
        '54.175.219.8': 'httpbin.org',
        '34.223.124.45': 'neverssl.com',
        '188.184.21.108': 'info.cern.ch',
        '1.1.1.1': 'one.one.one.one',
        '8.8.8.8': 'dns.google',
      };
      return known[ipStr] || null;
    }

    getStats() {
      return {
        ...this.stats,
        connections: this.pendingConnections.size,
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Export to global scope
  // ═══════════════════════════════════════════════════════
  if (typeof window !== 'undefined') {
    window.NetworkAdapter = NetworkAdapter;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.NetworkAdapter = NetworkAdapter;
  }
})();
