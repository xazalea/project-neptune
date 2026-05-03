/**
 * project: neptune — smoltcp WASM TCP/IP Stack
 * Full TCP/IP implementation compiled to WebAssembly.
 * Provides a custom Device implementation that bridges Ethernet frames
 * to JavaScript via callback, enabling in-browser networking without
 * any external relay servers.
 *
 * Architecture:
 *   Rust TCP Stack (smoltcp) → custom JsDevice → JS callback → SW fetch() → Internet
 */

use smoltcp::iface::{Config, Interface, SocketSet, Routes};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp::{Socket as TcpSocket, SocketBuffer as TcpBuffer};
use smoltcp::socket::Socket;
use smoltcp::time::Instant;
use smoltcp::wire::{EthernetAddress, IpAddress, IpCidr, Ipv4Address};
use wasm_bindgen::prelude::*;
use std::collections::HashMap;
use std::sync::Mutex;

// ═══════════════════════════════════════════════════════
// Timestamp helper — bridges to JS performance.now()
// ═══════════════════════════════════════════════════════

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date)]
    fn now() -> f64;
}

fn timestamp_millis() -> u64 {
    (now()) as u64
}

fn timestamp_instant() -> Instant {
    Instant::from_millis(timestamp_millis() as i64)
}

// ═══════════════════════════════════════════════════════
// Custom Device: bridges smoltcp to JavaScript callbacks
// ═══════════════════════════════════════════════════════

/// JsDevice implements smoltcp's `Device` trait, bridging
/// Ethernet frames between the Rust TCP/IP stack and JavaScript.
///
/// - rx: incoming bytes from JS are buffered here
/// - tx: outgoing Ethernet frames are sent to JS via callback
pub struct JsDevice {
    pub rx_buffer: Vec<u8>,
    pub tx_callback: Option<js_sys::Function>,
    pub mtu: usize,
}

impl JsDevice {
    pub fn new(mtu: usize) -> Self {
        Self {
            rx_buffer: Vec::new(),
            tx_callback: None,
            mtu,
        }
    }

    /// Feed incoming bytes from JavaScript into the device's receive buffer.
    /// Called from JS when the ServiceWorker returns raw response bytes.
    pub fn feed_rx(&mut self, data: &[u8]) {
        self.rx_buffer.extend_from_slice(data);
    }

    /// Clear the RX buffer after consuming
    pub fn clear_rx(&mut self) {
        self.rx_buffer.clear();
    }
}

impl Device for JsDevice {
    type RxToken<'a> = JsRxToken
    where
        Self: 'a;
    type TxToken<'a> = JsTxToken<'a>
    where
        Self: 'a;

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = self.mtu;
        caps.max_burst_size = Some(8);
        caps
    }

    fn receive(&mut self, _timestamp: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.rx_buffer.is_empty() {
            None
        } else {
            let rx = JsRxToken {
                buffer: std::mem::take(&mut self.rx_buffer),
            };
            let tx = JsTxToken {
                callback: self.tx_callback.clone(),
                buffer: Vec::with_capacity(self.mtu),
                _phantom: std::marker::PhantomData,
            };
            self.rx_buffer.clear();
            Some((rx, tx))
        }
    }

    fn transmit(&mut self, _timestamp: Instant) -> Option<Self::TxToken<'_>> {
        Some(JsTxToken {
            callback: self.tx_callback.clone(),
            buffer: Vec::with_capacity(self.mtu),
            _phantom: std::marker::PhantomData,
        })
    }
}

/// Receive token — holds raw bytes from JS
pub struct JsRxToken {
    buffer: Vec<u8>,
}

impl RxToken for JsRxToken {
    fn consume<R, F>(mut self, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let result = f(&mut self.buffer);
        result
    }
}

/// Transmit token — collects Ethernet frames and sends to JS
pub struct JsTxToken<'a> {
    callback: Option<js_sys::Function>,
    buffer: Vec<u8>,
    _phantom: std::marker::PhantomData<&'a ()>,
}

impl<'a> TxToken for JsTxToken<'a> {
    fn consume<R, F>(mut self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        self.buffer.resize(len, 0);
        let result = f(&mut self.buffer);

        // Send the Ethernet frame to JavaScript
        if let Some(ref cb) = self.callback {
            let uint8 = js_sys::Uint8Array::from(&self.buffer[..len]);
            let _ = cb.call1(&JsValue::NULL, &uint8);
        }

        result
    }
}

// ═══════════════════════════════════════════════════════
// NeptuneNetStack: the main WASM-exported networking API
// ═══════════════════════════════════════════════════════

/// Global network stack state (behind a mutex for thread safety)
static NET_STACK: once_cell::sync::Lazy<Mutex<Option<NeptuneNetStackInner>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

struct NeptuneNetStackInner {
    device: JsDevice,
    iface: Interface,
    sockets: SocketSet<'static>,
    http_callbacks: HashMap<u16, js_sys::Function>, // local_port → callback
    next_local_port: u16,
    mac: EthernetAddress,
    ip: Ipv4Address,
    gateway: Ipv4Address,
    _dns_servers: Vec<Ipv4Address>,
}

#[wasm_bindgen]
pub struct NeptuneNetStack;

#[wasm_bindgen]
impl NeptuneNetStack {
    /// Initialize the TCP/IP stack.
    ///
    /// # Arguments
    /// * `tx_callback` — JS function called with Uint8Array when smoltcp
    ///   has an Ethernet frame to send. The JS side should route this
    ///   through the ServiceWorker to the internet.
    #[wasm_bindgen(constructor)]
    pub fn new(tx_callback: js_sys::Function) -> NeptuneNetStack {
        let mac = EthernetAddress([0x02, 0x00, 0x00, 0x00, 0x00, 0x02]);
        let ip = Ipv4Address::new(10, 0, 0, 2);
        let gateway = Ipv4Address::new(10, 0, 0, 1); // The JS bridge is the gateway
        let mtu = 1500;

        let mut device = JsDevice::new(mtu);
        device.tx_callback = Some(tx_callback);

        // Create the network interface
        let config = Config::new(mac.into());
        let now = timestamp_instant();
        let mut iface = Interface::new(config, &mut device, now);

        // Assign IP
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::v4(ip.0[0], ip.0[1], ip.0[2], ip.0[3]), 24));
        });

        // Set up routes: add default IPv4 gateway
        let mut routes = Routes::new();
        routes.add_default_ipv4_route(gateway).ok();
        *iface.routes_mut() = routes;

        let sockets = SocketSet::new(vec![]);

        let inner = NeptuneNetStackInner {
            device,
            iface,
            sockets,
            http_callbacks: HashMap::new(),
            next_local_port: 42000,
            mac,
            ip,
            gateway,
            _dns_servers: vec![
                Ipv4Address::new(1, 1, 1, 1),
                Ipv4Address::new(8, 8, 8, 8),
            ],
        };

        let mut guard = NET_STACK.lock().unwrap();
        *guard = Some(inner);

        crate::console_log("[NET] TCP/IP stack initialized");
        crate::console_log(&format!(
            "[NET] MAC: {:02x?}, IP: {:?}, GW: {:?}, MTU: {}",
            mac.0, ip, gateway, mtu
        ));

        NeptuneNetStack
    }

    /// Feed raw bytes from JavaScript into the RX buffer.
    /// Called when the JS bridge receives network data.
    pub fn feed_rx(&self, data: &[u8]) {
        let mut guard = NET_STACK.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            inner.device.feed_rx(data);
        }
    }

    /// Set or change the TX callback after construction.
    /// The callback receives Uint8Array (raw Ethernet frames) from smoltcp.
    #[wasm_bindgen(js_name = setTxCallback)]
    pub fn set_tx_callback(&self, callback: js_sys::Function) {
        let mut guard = NET_STACK.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            inner.device.tx_callback = Some(callback);
            crate::console_log("[NET] TX callback set");
        }
    }

    /// Poll the network stack. Should be called frequently (e.g., via
    /// setInterval or requestAnimationFrame) to process incoming packets
    /// and advance TCP state machines.
    ///
    /// Returns the number of milliseconds since last poll, for diagnostics.
    pub fn poll(&self) -> u32 {
        let mut guard = NET_STACK.lock().unwrap();
        let now = timestamp_instant();
        let mut processed = 0u32;

        if let Some(ref mut inner) = *guard {
            let device_ptr = &mut inner.device as *mut JsDevice;
            // SAFETY: The device and sockets are owned by inner and won't be moved
            // while poll is executing. We split borrows manually.
            unsafe {
                if inner.iface.poll(now, &mut *device_ptr, &mut inner.sockets) {
                    processed = 1;
                }
            }
        }

        processed
    }

    /// Open a TCP connection to a remote host:port.
    ///
    /// Returns the local port number used for this connection.
    /// The caller must poll() to advance the TCP handshake.
    ///
    /// # Arguments
    /// * `addr` — The destination IPv4 address in dotted-decimal format (e.g., "93.184.216.34")
    /// * `port` — Destination port
    /// * `callback` — JS function called with {status, data} when data arrives
    #[wasm_bindgen(js_name = tcpConnect)]
    pub fn tcp_connect(&self, addr: &str, port: u16, callback: js_sys::Function) -> u16 {
        let mut guard = NET_STACK.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            // Parse address
            let ip = match parse_ipv4(addr) {
                Some(ip) => ip,
                None => {
                    crate::console_log(&format!("[NET] Invalid address: {}", addr));
                    return 0;
                }
            };

            let local_port = inner.next_local_port;
            inner.next_local_port = inner.next_local_port.wrapping_add(1);
            if inner.next_local_port < 42000 {
                inner.next_local_port = 42000;
            }

            // Create TCP socket
            let tcp_rx = TcpBuffer::new(vec![0u8; 65535]);
            let tcp_tx = TcpBuffer::new(vec![0u8; 65535]);
            let mut tcp_socket = TcpSocket::new(tcp_rx, tcp_tx);
            tcp_socket.set_timeout(Some(smoltcp::time::Duration::from_secs(30)));
            tcp_socket.set_keep_alive(Some(smoltcp::time::Duration::from_secs(15)));

            // Connect
            let endpoint = (ip, port);
            match tcp_socket.connect(inner.iface.context(), endpoint, local_port) {
                Ok(()) => {
                    let handle = inner.sockets.add(tcp_socket);
                    inner.http_callbacks.insert(local_port, callback);
                    crate::console_log(&format!(
                        "[NET] TCP connect {}:{} (local port {}) — socket handle {}",
                        addr, port, local_port, handle
                    ));
                    local_port
                }
                Err(e) => {
                    crate::console_log(&format!("[NET] TCP connect failed: {:?}", e));
                    0
                }
            }
        } else {
            crate::console_log("[NET] Stack not initialized");
            0
        }
    }

    /// Send data on an open TCP connection.
    #[wasm_bindgen(js_name = tcpSend)]
    pub fn tcp_send(&self, port: u16, data: &[u8]) -> bool {
        let mut guard = NET_STACK.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            for (_handle, socket) in inner.sockets.iter_mut() {
                if let Socket::Tcp(tcp) = socket {
                    if tcp.local_endpoint().map(|e| e.port) == Some(port) {
                        match tcp.send_slice(data) {
                            Ok(n) => {
                                crate::console_log(&format!("[NET] TCP sent {} / {} bytes", n, data.len()));
                                return n == data.len();
                            }
                            Err(e) => {
                                crate::console_log(&format!("[NET] TCP send error: {:?}", e));
                                return false;
                            }
                        }
                    }
                }
            }
        }
        false
    }

    /// Check for received data on TCP connections and invoke callbacks.
    /// Should be called after poll().
    pub fn process_received(&self) -> u32 {
        let mut guard = NET_STACK.lock().unwrap();
        let mut callbacks_fired = 0u32;

        if let Some(ref mut inner) = *guard {
            let http_cbs = &mut inner.http_callbacks;

            for (_handle, socket) in inner.sockets.iter_mut() {
                if let Socket::Tcp(tcp) = socket {
                    let local_port = match tcp.local_endpoint() {
                        Some(ep) => ep.port,
                        None => continue,
                    };

                    if tcp.can_recv() {
                        let mut buf = vec![0u8; 65535];
                        match tcp.recv_slice(&mut buf) {
                            Ok(n) if n > 0 => {
                                buf.truncate(n);
                                if let Some(cb) = http_cbs.get(&local_port) {
                                    let data = js_sys::Uint8Array::from(&buf[..]);
                                    let obj = js_sys::Object::new();
                                    js_sys::Reflect::set(
                                        &obj,
                                        &JsValue::from_str("type"),
                                        &JsValue::from_str("data"),
                                    ).ok();
                                    js_sys::Reflect::set(
                                        &obj,
                                        &JsValue::from_str("data"),
                                        &data,
                                    ).ok();
                                    js_sys::Reflect::set(
                                        &obj,
                                        &JsValue::from_str("port"),
                                        &JsValue::from_f64(local_port as f64),
                                    ).ok();
                                    let _ = cb.call1(&JsValue::NULL, &obj);
                                    callbacks_fired += 1;
                                }
                            }
                            Ok(_) => {}
                            Err(e) => {
                                crate::console_log(&format!("[NET] TCP recv error: {:?}", e));
                            }
                        }
                    }

                    // Check if connection closed
                    if !tcp.is_open() {
                        if let Some(cb) = http_cbs.remove(&local_port) {
                            let obj = js_sys::Object::new();
                            js_sys::Reflect::set(
                                &obj,
                                &JsValue::from_str("type"),
                                &JsValue::from_str("close"),
                            ).ok();
                            js_sys::Reflect::set(
                                &obj,
                                &JsValue::from_str("port"),
                                &JsValue::from_f64(local_port as f64),
                            ).ok();
                            let _ = cb.call1(&JsValue::NULL, &obj);
                            callbacks_fired += 1;
                        }
                    }
                }
            }
        }

        callbacks_fired
    }

    /// Close a TCP connection.
    #[wasm_bindgen(js_name = tcpClose)]
    pub fn tcp_close(&self, local_port: u16) {
        let mut guard = NET_STACK.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            for (_handle, socket) in inner.sockets.iter_mut() {
                if let Socket::Tcp(tcp) = socket {
                    if tcp.local_endpoint().map(|e| e.port) == Some(local_port) {
                        tcp.close();
                        crate::console_log(&format!("[NET] TCP close local_port={}", local_port));
                        break;
                    }
                }
            }
            inner.http_callbacks.remove(&local_port);
        }
    }

    /// Make an HTTP GET request and invoke callback with response.
    ///
    /// Handles TCP connection, HTTP request formatting, response parsing,
    /// and connection cleanup automatically.
    ///
    /// # Arguments
    /// * `url` — Full HTTP URL
    /// * `callback` — JS function called with {status, headers, body, error}
    #[wasm_bindgen(js_name = httpGet)]
    pub fn http_get(&self, url: &str, callback: js_sys::Function) {
        let url_owned = url.to_string();
        let cb = callback;

        // Parse URL
        let (host, port, path) = match parse_http_url(&url_owned) {
            Some(p) => p,
            None => {
                let obj = js_sys::Object::new();
                js_sys::Reflect::set(&obj, &JsValue::from_str("error"), &JsValue::from_str("Invalid URL")).ok();
                let _ = cb.call1(&JsValue::NULL, &obj);
                return;
            }
        };

        // Resolve DNS (for now, delegate to JS for actual resolution)
        // In production, we'd use smoltcp DNS; for now use JS's DNS
        crate::console_log(&format!("[NET] HTTP GET {}:{} {}", host, port, path));

        // Resolve hostname via JS (or hardcoded for common hosts)
        let ip_addr = resolve_host_dns(&host);

        // Wrap the HTTP callback as a Closure that lives as long as the connection
        let response_cb = Closure::wrap(Box::new(move |event: JsValue| {
            let obj = js_sys::Object::new();
            if let Ok(Some(type_str)) = js_sys::Reflect::get(&event, &JsValue::from_str("type"))
                .map(|v| v.as_string())
            {
                match type_str.as_str() {
                    "data" => {
                        if let Ok(data_val) = js_sys::Reflect::get(&event, &JsValue::from_str("data")) {
                            let uint8 = js_sys::Uint8Array::new(&data_val);
                            let mut bytes = vec![0u8; uint8.length() as usize];
                            uint8.copy_to(&mut bytes);

                            if let Ok(text) = std::str::from_utf8(&bytes) {
                                if let Some((_status_end, headers_start, body_start)) = parse_http_response(text) {
                                    let status_line = &text[..headers_start];
                                    let status_code: u16 = status_line
                                        .split_whitespace()
                                        .nth(1)
                                        .and_then(|s| s.parse().ok())
                                        .unwrap_or(0);

                                    let headers_text = &text[headers_start..body_start];
                                    let headers_obj = js_sys::Object::new();
                                    for line in headers_text.lines() {
                                        if let Some((k, v)) = line.split_once(':') {
                                            js_sys::Reflect::set(
                                                &headers_obj,
                                                &JsValue::from_str(k.trim()),
                                                &JsValue::from_str(v.trim()),
                                            ).ok();
                                        }
                                    }

                                    let body = &text[body_start..];
                                    js_sys::Reflect::set(&obj, &JsValue::from_str("status"), &JsValue::from_f64(status_code as f64)).ok();
                                    js_sys::Reflect::set(&obj, &JsValue::from_str("headers"), &headers_obj).ok();
                                    js_sys::Reflect::set(&obj, &JsValue::from_str("body"), &JsValue::from_str(body)).ok();
                                }
                            }
                        }
                    }
                    "close" => {}
                    _ => {}
                }
            }
            let _ = cb.call1(&JsValue::NULL, &obj);
        }) as Box<dyn FnMut(JsValue)>);

        // Get a js_sys::Function from the closure and forget it (GC manages lifecycle)
        let cb_fn: js_sys::Function = response_cb.as_ref().unchecked_ref::<js_sys::Function>().clone();
        response_cb.forget();

        let local_port = self.tcp_connect(&ip_addr, port, cb_fn);
        if local_port > 0 {
            let request = format!(
                "GET {} HTTP/1.1\r\n\
                 Host: {}\r\n\
                 User-Agent: Neptune/3.0 (smoltcp WASM)\r\n\
                 Accept: */*\r\n\
                 Connection: close\r\n\
                 \r\n",
                path, host
            );
            self.tcp_send(local_port, request.as_bytes());
        }
    }

    /// Resolve a hostname to IPv4 using the DNS stack (simplified).
    /// In production, this would use smoltcp's DNS socket.
    /// For now, delegates to a hardcoded map of common hosts or
    /// expects the JS side to provide resolved IPs.
    #[wasm_bindgen(js_name = resolveHost)]
    pub fn resolve_host(&self, host: &str) -> String {
        resolve_host_dns(host)
    }

    /// Get network stats for diagnostics
    #[wasm_bindgen(js_name = getStats)]
    pub fn get_stats(&self) -> String {
        let guard = NET_STACK.lock().unwrap();
        if let Some(ref inner) = *guard {
            format!(
                "{{\"mac\":\"{:02x?}\",\"ip\":\"{:?}\",\"gateway\":\"{:?}\",\"sockets\":{},\"mtu\":{}}}",
                inner.mac.0,
                inner.ip,
                inner.gateway,
                inner.sockets.iter().count(),
                inner.device.mtu,
            )
        } else {
            "{\"error\":\"not initialized\"}".to_string()
        }
    }
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

fn parse_ipv4(s: &str) -> Option<Ipv4Address> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 { return None; }
    let a = parts[0].parse().ok()?;
    let b = parts[1].parse().ok()?;
    let c = parts[2].parse().ok()?;
    let d = parts[3].parse().ok()?;
    Some(Ipv4Address::new(a, b, c, d))
}

fn parse_http_url(url: &str) -> Option<(String, u16, String)> {
    let without_proto = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        rest
    } else {
        url
    };

    let (host_port, path) = if let Some(idx) = without_proto.find('/') {
        (&without_proto[..idx], &without_proto[idx..])
    } else {
        (without_proto, "/")
    };

    let (host, port) = if let Some(idx) = host_port.rfind(':') {
        let port_str = &host_port[idx + 1..];
        (&host_port[..idx], port_str.parse().unwrap_or(80))
    } else {
        (host_port, 80u16)
    };

    Some((host.to_string(), port, path.to_string()))
}

fn parse_http_response(data: &str) -> Option<(usize, usize, usize)> {
    // Find end of status line
    let status_end = data.find("\r\n")?;

    // Find end of headers (double CRLF)
    let headers_start = status_end + 2;
    let headers_end = data[headers_start..].find("\r\n\r\n")?;
    let body_start = headers_start + headers_end + 4;

    Some((status_end, headers_start, body_start))
}

/// Hardcoded DNS resolution for common hosts.
/// In a full implementation, this would use smoltcp's DNS socket
/// or delegate to JavaScript's fetch API for DNS resolution.
fn resolve_host_dns(host: &str) -> String {
    // Common host mappings for testing/bootstrapping
    match host {
        "example.com" => "93.184.216.34".to_string(),
        "httpbin.org" => "54.175.219.8".to_string(),
        "neverssl.com" => "34.223.124.45".to_string(),
        "info.cern.ch" => "188.184.21.108".to_string(),
        _ => {
            // Try to resolve via the JS side
            // For now, return a placeholder that the JS bridge can handle
            crate::console_log(&format!("[NET] DNS: resolving {} via JS bridge", host));
            // The JS bridge should resolve this and call tcp_connect with the IP
            host.to_string()
        }
    }
}

// ═══════════════════════════════════════════════════════
// Raw Ethernet frame parser (for diagnostic/reference)
// ═══════════════════════════════════════════════════════

/// Parse an Ethernet frame header and return the EtherType and payload offset.
/// Used by the JS network adapter to understand raw frames.
#[wasm_bindgen]
pub fn parse_ethernet_frame_header(data: &[u8]) -> String {
    if data.len() < 14 {
        return "{\"error\":\"frame too short\"}".to_string();
    }

    let dst_mac = &data[0..6];
    let src_mac = &data[6..12];
    let ethertype = ((data[12] as u16) << 8) | (data[13] as u16);

    format!(
        "{{\"dstMac\":\"{:02x?}\",\"srcMac\":\"{:02x?}\",\"etherType\":\"0x{:04x}\",\"payloadOffset\":14}}",
        dst_mac, src_mac, ethertype
    )
}

/// Parse an IPv4 packet header and return structured info.
#[wasm_bindgen]
pub fn parse_ipv4_packet_header(data: &[u8]) -> String {
    if data.len() < 20 {
        return "{\"error\":\"packet too short\"}".to_string();
    }

    let version_ihl = data[0];
    let ihl = (version_ihl & 0x0F) as usize * 4;
    let protocol = data[9];
    let src_ip = format!("{}.{}.{}.{}", data[12], data[13], data[14], data[15]);
    let dst_ip = format!("{}.{}.{}.{}", data[16], data[17], data[18], data[19]);

    format!(
        "{{\"version\":{},\"ihl\":{},\"protocol\":{},\"srcIp\":\"{}\",\"dstIp\":\"{}\",\"headerLen\":{}}}",
        version_ihl >> 4, ihl, protocol, src_ip, dst_ip, ihl
    )
}
