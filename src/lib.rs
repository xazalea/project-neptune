/**
 * Neptune WASM Unikernel
 * Core logic kernel for request transformation, routing, and state management.
 * Compiled to WASM and executed in the browser via the Service Worker bridge.
 */

use wasm_bindgen::prelude::*;
#[allow(unused_imports)]
use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use once_cell::sync::Lazy;
use std::sync::Mutex;

// Initialize panic hook for debugging
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    console_log("project: neptune v0.1.0 initialized");
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn log_u32(a: u32);
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

fn console_log(msg: &str) {
    log(msg);
}

// ==========================
// Global Kernel State
// ==========================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KernelState {
    pub target_url: Option<String>,
    pub request_count: u64,
    pub active_sessions: Vec<String>,
    pub vfs_cache: HashMap<String, VfsEntry>,
    pub proxy_rules: Vec<ProxyRule>,
    pub cors_strategy: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VfsEntry {
    pub path: String,
    pub data: Vec<u8>,
    pub modified: u64,
    pub permissions: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyRule {
    pub pattern: String,
    pub rewrite_to: String,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub transformed: bool,
}

// Thread-safe global state using Mutex
static KERNEL_STATE: Lazy<Mutex<KernelState>> = Lazy::new(|| {
    Mutex::new(KernelState {
        target_url: None,
        request_count: 0,
        active_sessions: Vec::new(),
        vfs_cache: HashMap::new(),
        proxy_rules: Vec::new(),
        cors_strategy: String::from("proxy"),
    })
});

// ==========================
// WASM Exports (JS Bridge)
// ==========================

#[wasm_bindgen]
pub struct NeptuneKernel {
    heap_size: usize,
}

#[wasm_bindgen]
impl NeptuneKernel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_log("[KERNEL] NeptuneKernel instance created");
        Self { heap_size: 0 }
    }

    /// Set the active proxy target URL
    pub fn set_target(&mut self, url: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.target_url = Some(url.to_string());
        console_log(&format!("[KERNEL] Target set: {}", url));
    }

    /// Get current target URL
    pub fn get_target(&self) -> Option<String> {
        let state = KERNEL_STATE.lock().unwrap();
        state.target_url.clone()
    }

    /// Process a proxy request through the kernel
    pub fn process_request(&mut self, request_json: &str) -> Result<String, JsValue> {
        let request: ProxyRequest = serde_json::from_str(request_json)
            .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

        let mut state = KERNEL_STATE.lock().unwrap();
        state.request_count += 1;
        let count = state.request_count;
        drop(state);

        console_log(&format!("[KERNEL] Request #{}: {} {}", count, request.method, request.url));

        // Transform the request
        let transformed = transform_request(&request)?;

        // Return as JSON
        serde_json::to_string(&transformed)
            .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
    }

    /// Transform HTML content for proxy routing
    pub fn transform_html(&mut self, html: &str, target_url: &str, origin: &str) -> String {
        console_log("[KERNEL] Transforming HTML response");
        let transformed = html_transform_engine(html, target_url, origin);
        self.heap_size += transformed.len();
        transformed
    }

    /// Apply proxy rules to a URL
    pub fn apply_rules(&self, url: &str) -> String {
        let state = KERNEL_STATE.lock().unwrap();
        let mut result = url.to_string();

        for rule in &state.proxy_rules {
            if result.contains(&rule.pattern) {
                result = result.replace(&rule.pattern, &rule.rewrite_to);
                console_log(&format!("[KERNEL] Rule applied: {} -> {}", rule.pattern, result));
            }
        }

        result
    }

    /// VFS: Write file to virtual filesystem
    pub fn vfs_write(&mut self, path: &str, data: &[u8], permissions: u32) {
        let mut state = KERNEL_STATE.lock().unwrap();
        let entry = VfsEntry {
            path: path.to_string(),
            data: data.to_vec(),
            modified: js_sys::Date::now() as u64,
            permissions,
        };
        state.vfs_cache.insert(path.to_string(), entry);
        self.heap_size += data.len();
        console_log(&format!("[KERNEL] VFS write: {} ({} bytes)", path, data.len()));
    }

    /// VFS: Read file from virtual filesystem
    pub fn vfs_read(&self, path: &str) -> Option<Vec<u8>> {
        let state = KERNEL_STATE.lock().unwrap();
        state.vfs_cache.get(path).map(|e| e.data.clone())
    }

    /// VFS: List files in directory
    pub fn vfs_list(&self, prefix: &str) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let files: Vec<&str> = state.vfs_cache
            .keys()
            .filter(|k| k.starts_with(prefix))
            .map(|k| k.as_str())
            .collect();

        serde_json::to_string(&files)
            .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
    }

    /// Add a proxy routing rule
    pub fn add_rule(&mut self, pattern: &str, rewrite_to: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.proxy_rules.push(ProxyRule {
            pattern: pattern.to_string(),
            rewrite_to: rewrite_to.to_string(),
            headers: HashMap::new(),
        });
        console_log(&format!("[KERNEL] Rule added: {} -> {}", pattern, rewrite_to));
    }

    /// Set CORS strategy
    pub fn set_cors_strategy(&mut self, strategy: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.cors_strategy = strategy.to_string();
        console_log(&format!("[KERNEL] CORS strategy: {}", strategy));
    }

    /// Serialize entire kernel state for snapshot export
    pub fn serialize_state(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        serde_json::to_string(&*state)
            .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
    }

    /// Deserialize and restore kernel state from snapshot
    pub fn deserialize_state(&mut self, json: &str) -> Result<(), JsValue> {
        let restored: KernelState = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Deserialize error: {}", e)))?;

        let mut state = KERNEL_STATE.lock().unwrap();
        *state = restored;
        self.heap_size = state.vfs_cache.values().map(|e| e.data.len()).sum();
        console_log(&format!("[KERNEL] State restored. Heap: {} bytes", self.heap_size));
        Ok(())
    }

    /// Get memory heap statistics
    pub fn heap_stats(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let stats = HeapStats {
            heap_size: self.heap_size,
            vfs_entries: state.vfs_cache.len(),
            request_count: state.request_count,
            active_sessions: state.active_sessions.len(),
        };

        serde_json::to_string(&stats)
            .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
    }

    /// Create state snapshot as base64-encoded bytes
    pub fn create_snapshot(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let json = serde_json::to_string(&*state)
            .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))?;

        // Encode to base64
        let bytes = json.as_bytes();
        let encoded = base64_encode(bytes);
        console_log(&format!("[KERNEL] Snapshot created: {} bytes -> {} base64", bytes.len(), encoded.len()));
        Ok(encoded)
    }
}

#[derive(Serialize)]
struct HeapStats {
    heap_size: usize,
    vfs_entries: usize,
    request_count: u64,
    active_sessions: usize,
}

// ==========================
// Request Transformation
// ==========================

fn transform_request(_req: &ProxyRequest) -> Result<ProxyResponse, JsValue> {
    // Default response - in a real scenario, this would route through the network layer
    let mut headers = HashMap::new();
    headers.insert("X-Neptune-Proxy".to_string(), "v0.1.0".to_string());
    headers.insert("X-Processed-By".to_string(), "wasm-kernel".to_string());

    Ok(ProxyResponse {
        status: 200,
        status_text: "OK".to_string(),
        headers,
        body: Vec::new(),
        transformed: true,
    })
}

// ==========================
// HTML Transformation Engine
// ==========================

fn html_transform_engine(html: &str, target_url: &str, origin: &str) -> String {
    let target = match url_parse(target_url) {
        Some(t) => t,
        None => return html.to_string(),
    };

    let base = format!("{}/virtual-root/", origin);
    let mut result = html.to_string();

    // Insert base tag
    let base_tag = format!("<base href=\"{}\">", target.origin);

    // Rewrite relative hrefs
    result = rewrite_attribute(&result, "href", &base, &target.origin);

    // Rewrite relative srcs
    result = rewrite_attribute(&result, "src", &base, &target.origin);

    // Rewrite action attributes (forms)
    result = rewrite_attribute(&result, "action", &base, &target.origin);

    // Rewrite CSS url() references
    result = rewrite_css_urls(&result, &base, &target.origin);

    // Inject proxy runtime script
    let proxy_script = format!(
        r#"<script>
(function() {{
    const base = '{}';
    const targetOrigin = '{}';

    // Override fetch
    const origFetch = window.fetch;
    window.fetch = function(input, init) {{
        let url = typeof input === 'string' ? input : (input.url || input.toString());
        if (url.startsWith('http') && !url.includes(location.origin)) {{
            url = base + encodeURIComponent(url);
        }} else if (url.startsWith('/') && !url.startsWith('/virtual-root/')) {{
            url = base + url.substring(1);
        }}
        return origFetch(url, init);
    }};

    // Override XHR
    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {{
        if (url.startsWith('http') && !url.includes(location.origin)) {{
            url = base + encodeURIComponent(url);
        }} else if (url.startsWith('/') && !url.startsWith('/virtual-root/')) {{
            url = base + url.substring(1);
        }}
        return origXhrOpen.call(this, method, url, async, user, password);
    }};

    // Rewrite anchor clicks
    document.addEventListener('click', function(e) {{
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href');
        if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {{
            if (href.startsWith('http') && !href.includes(location.origin)) {{
                a.href = base + encodeURIComponent(href);
            }} else if (href.startsWith('/') && !href.startsWith('/virtual-root/')) {{
                a.href = base + href.substring(1);
            }}
        }}
    }});
}})();
</script>"#,
        base, target.origin
    );

    // Inject base tag and script
    if result.contains("</head>") {
        result = result.replacen("</head>", &format!("{}\n{}\n</head>", base_tag, proxy_script), 1);
    } else if result.contains("<body") {
        result = result.replacen("<body", &format!("{}\n<body", proxy_script), 1);
    } else {
        result = format!("{}\n{}", proxy_script, result);
    }

    result
}

fn rewrite_attribute(html: &str, attr: &str, base: &str, target_origin: &str) -> String {
    let mut result = html.to_string();

    // Rewrite absolute URLs to target origin
    let abs_pattern = format!(r#"{}="{}""#, attr, target_origin);
    let abs_replacement = format!(r#"{}="{}""#, attr, base);
    result = result.replace(&abs_pattern, &abs_replacement);

    // Rewrite absolute paths
    let path_pattern = format!(r#"{}="/""#, attr);
    let path_replacement = format!(r#"{}="{}""#, attr, base);
    result = result.replace(&path_pattern, &path_replacement);

    result
}

fn rewrite_css_urls(css: &str, base: &str, target_origin: &str) -> String {
    let mut result = css.to_string();

    // Simple string replacement for url() patterns
    let abs_pattern = format!("url({})", target_origin);
    let abs_replacement = format!("url({})", base);
    result = result.replace(&abs_pattern, &abs_replacement);

    let path_pattern = "url(/";
    let path_replacement = format!("url({}", base);
    result = result.replace(path_pattern, &path_replacement);

    result
}

// ==========================
// URL Parsing Helper
// ==========================

#[derive(Debug)]
#[allow(dead_code)]
struct ParsedUrl {
    origin: String,
    protocol: String,
    host: String,
    pathname: String,
    search: String,
}

fn url_parse(url: &str) -> Option<ParsedUrl> {
    // Simple URL parser without regex dependency
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }

    let protocol_end = url.find("://")?;
    let protocol = url[..protocol_end].to_string();

    let rest = &url[protocol_end + 3..];
    let path_start = rest.find('/').unwrap_or(rest.len());
    let host = rest[..path_start].to_string();
    let origin = format!("{}://{}", protocol, host);

    let (pathname, search) = if path_start < rest.len() {
        let path_and_query = &rest[path_start..];
        if let Some(query_start) = path_and_query.find('?') {
            (path_and_query[..query_start].to_string(), path_and_query[query_start..].to_string())
        } else {
            (path_and_query.to_string(), String::new())
        }
    } else {
        ("/".to_string(), String::new())
    };

    Some(ParsedUrl { origin, protocol, host, pathname, search })
}

// ==========================
// Base64 Encoding
// ==========================

const BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut result = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;

    while i + 2 < input.len() {
        let b0 = input[i] as usize;
        let b1 = input[i + 1] as usize;
        let b2 = input[i + 2] as usize;

        result.push(BASE64_CHARS[(b0 >> 2) & 0x3F] as char);
        result.push(BASE64_CHARS[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);
        result.push(BASE64_CHARS[((b1 << 2) | (b2 >> 6)) & 0x3F] as char);
        result.push(BASE64_CHARS[b2 & 0x3F] as char);

        i += 3;
    }

    if i + 1 == input.len() {
        let b0 = input[i] as usize;
        result.push(BASE64_CHARS[(b0 >> 2) & 0x3F] as char);
        result.push(BASE64_CHARS[(b0 << 4) & 0x3F] as char);
        result.push('=');
        result.push('=');
    } else if i + 2 == input.len() {
        let b0 = input[i] as usize;
        let b1 = input[i + 1] as usize;
        result.push(BASE64_CHARS[(b0 >> 2) & 0x3F] as char);
        result.push(BASE64_CHARS[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);
        result.push(BASE64_CHARS[(b1 << 2) & 0x3F] as char);
        result.push('=');
    }

    result
}
