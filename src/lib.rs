use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
/**
 * project: neptune — WASM Unikernel Kernel
 * DOM AST parser, resource graph, tracker stripping, HTML transformation.
 */
use wasm_bindgen::prelude::*;

pub mod network;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    console_log("project: neptune v0.1.0 kernel initialized");
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

pub(crate) fn console_log(msg: &str) {
    log(msg);
}

// ==========================
// Kernel State
// ==========================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KernelState {
    pub target_url: Option<String>,
    pub request_count: u64,
    pub active_sessions: Vec<String>,
    pub vfs_cache: HashMap<String, VfsEntry>,
    pub proxy_rules: Vec<ProxyRule>,
    pub cors_strategy: String,
    pub resource_graph: ResourceGraph,
    pub tracker_blocklist: Vec<String>,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ResourceGraph {
    pub nodes: Vec<ResourceNode>,
    pub edges: Vec<ResourceEdge>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceNode {
    pub id: String,
    pub url: String,
    pub kind: String, // "html", "css", "js", "img", "xhr", "ws", "tracker"
    pub size: usize,
    pub transformed: bool,
    pub blocked: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceEdge {
    pub from: String,
    pub to: String,
    pub rel: String, // "script", "link", "xhr", "iframe"
}

static KERNEL_STATE: Lazy<Mutex<KernelState>> = Lazy::new(|| {
    Mutex::new(KernelState {
        target_url: None,
        request_count: 0,
        active_sessions: Vec::new(),
        vfs_cache: HashMap::new(),
        proxy_rules: Vec::new(),
        cors_strategy: String::from("auto"),
        resource_graph: ResourceGraph::default(),
        tracker_blocklist: default_tracker_list(),
    })
});

fn default_tracker_list() -> Vec<String> {
    vec![
        "google-analytics",
        "googletagmanager",
        "doubleclick",
        "facebook",
        "fbcdn",
        "twitter",
        "analytics",
        "tracker",
        "pixel",
        "beacon",
        "segment",
        "mixpanel",
        "amplitude",
        "hotjar",
        "gtag",
    ]
    .into_iter()
    .map(|s| s.to_string())
    .collect()
}

// ==========================
// WASM Exports
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

    pub fn set_target(&mut self, url: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.target_url = Some(url.to_string());
        console_log(&format!("[KERNEL] Target: {}", url));
    }

    pub fn get_target(&self) -> Option<String> {
        let state = KERNEL_STATE.lock().unwrap();
        state.target_url.clone()
    }

    // ==========================
    // DOM AST Processing
    // ==========================

    /// Parse HTML into structured nodes, build resource graph
    pub fn parse_dom(&mut self, html: &str, _base_url: &str) -> Result<String, JsValue> {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.request_count += 1;
        let count = state.request_count;
        drop(state);

        console_log(&format!(
            "[KERNEL] DOM parse #{}: {} bytes",
            count,
            html.len()
        ));

        let mut graph = ResourceGraph::default();
        let _transformed = html.to_string();

        // Parse with tl
        match tl::parse(html, tl::ParserOptions::default()) {
            Ok(dom) => {
                // Walk nodes and extract resources
                for node in dom.nodes() {
                    if let Some(tag) = node.as_tag() {
                        let name = tag.name().as_utf8_str();
                        match name.as_ref() {
                            "script" => {
                                if let Some(Some(src)) = tag.attributes().get("src") {
                                    let url = src.as_utf8_str().to_string();
                                    let id = format!("script-{}", graph.nodes.len());
                                    graph.nodes.push(ResourceNode {
                                        id,
                                        url,
                                        kind: "js".to_string(),
                                        size: 0,
                                        transformed: false,
                                        blocked: false,
                                    });
                                }
                            }
                            "link" => {
                                if let Some(Some(rel)) = tag.attributes().get("rel") {
                                    if rel.as_utf8_str().contains("stylesheet") {
                                        if let Some(Some(href)) = tag.attributes().get("href") {
                                            let url = href.as_utf8_str().to_string();
                                            let id = format!("css-{}", graph.nodes.len());
                                            graph.nodes.push(ResourceNode {
                                                id,
                                                url,
                                                kind: "css".to_string(),
                                                size: 0,
                                                transformed: false,
                                                blocked: false,
                                            });
                                        }
                                    }
                                }
                            }
                            "img" => {
                                if let Some(Some(src)) = tag.attributes().get("src") {
                                    let url = src.as_utf8_str().to_string();
                                    let id = format!("img-{}", graph.nodes.len());
                                    graph.nodes.push(ResourceNode {
                                        id,
                                        url,
                                        kind: "img".to_string(),
                                        size: 0,
                                        transformed: false,
                                        blocked: false,
                                    });
                                }
                            }
                            "iframe" => {
                                if let Some(Some(src)) = tag.attributes().get("src") {
                                    let url = src.as_utf8_str().to_string();
                                    let id = format!("iframe-{}", graph.nodes.len());
                                    graph.nodes.push(ResourceNode {
                                        id,
                                        url,
                                        kind: "iframe".to_string(),
                                        size: 0,
                                        transformed: false,
                                        blocked: false,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }

                console_log(&format!("[KERNEL] Found {} resources", graph.nodes.len()));

                // Check for trackers
                for node in graph.nodes.iter_mut() {
                    let lower = node.url.to_lowercase();
                    let trackers = default_tracker_list();
                    for tracker in &trackers {
                        if lower.contains(tracker) {
                            node.blocked = true;
                            node.kind = "tracker".to_string();
                            console_log(&format!("[KERNEL] Blocked tracker: {}", node.url));
                            break;
                        }
                    }
                }

                // Store graph
                let mut state = KERNEL_STATE.lock().unwrap();
                state.resource_graph = graph.clone();
                drop(state);

                serde_json::to_string(&graph)
                    .map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))
            }
            Err(e) => {
                console_log(&format!("[KERNEL] Parse error: {}", e));
                serde_json::to_string(&graph)
                    .map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))
            }
        }
    }

    /// Check if URL is a known tracker
    pub fn is_tracker(&self, url: &str) -> bool {
        let state = KERNEL_STATE.lock().unwrap();
        let lower = url.to_lowercase();
        for tracker in &state.tracker_blocklist {
            if lower.contains(tracker) {
                return true;
            }
        }
        false
    }

    /// Transform HTML with resource graph awareness
    pub fn transform_html_advanced(
        &mut self,
        html: &str,
        target_url: &str,
        _origin: &str,
        proxy_prefix: &str,
    ) -> String {
        console_log("[KERNEL] Advanced HTML transformation");

        let mut graph = ResourceGraph::default();

        // Parse and build graph
        if let Ok(dom) = tl::parse(html, tl::ParserOptions::default()) {
            for node in dom.nodes() {
                if let Some(tag) = node.as_tag() {
                    let name = tag.name().as_utf8_str();
                    let name_str = name.as_ref();
                    match name_str {
                        "script" | "link" | "img" | "iframe" | "video" | "audio" | "source" => {
                            let attr = if name_str == "link" { "href" } else { "src" };
                            if let Some(Some(val)) = tag.attributes().get(attr) {
                                let url = val.as_utf8_str().to_string();
                                let id = format!("{}-{}", name_str, graph.nodes.len());
                                let kind = if name_str == "link" { "css" } else { name_str };
                                let blocked = self.is_tracker(&url);
                                graph.nodes.push(ResourceNode {
                                    id,
                                    url,
                                    kind: kind.to_string(),
                                    size: 0,
                                    transformed: true,
                                    blocked,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        let blocked_count = graph.nodes.iter().filter(|n| n.blocked).count();
        console_log(&format!(
            "[KERNEL] {} resources, {} blocked",
            graph.nodes.len(),
            blocked_count
        ));

        // Transform with knowledge of blocked resources
        let mut out = html.to_string();

        // Rewrite URLs to proxy prefix
        let target_origin = match url_parse(target_url) {
            Some(t) => t.origin,
            None => return html.to_string(),
        };

        let to_proxy = |u: &str| -> String {
            if u.starts_with("http") {
                format!("{}?url={}", proxy_prefix, b64_url_encode(u))
            } else if u.starts_with("//") {
                format!(
                    "{}?url={}",
                    proxy_prefix,
                    b64_url_encode(&format!("https:{}", u))
                )
            } else if u.starts_with("/") {
                format!(
                    "{}?url={}",
                    proxy_prefix,
                    b64_url_encode(&format!("{}{}", target_origin, u))
                )
            } else if u.starts_with('#') || u.starts_with("javascript:") || u.starts_with("mailto:")
            {
                u.to_string()
            } else {
                format!(
                    "{}?url={}",
                    proxy_prefix,
                    b64_url_encode(&resolve_url(u, target_url))
                )
            }
        };

        // Block trackers by replacing with empty/noop
        for node in &graph.nodes {
            if node.blocked {
                match node.kind.as_str() {
                    "script" => {
                        // Replace script tags pointing to trackers with comment
                        let pattern = format!(
                            "<script[^>]*src=[\"']{}[\"'][^>]*></script>",
                            regex::escape(&node.url)
                        );
                        out =
                            regex_replace_all(&pattern, &out, "<!-- neptune: blocked tracker -->");
                    }
                    "img" => {
                        // Replace tracker pixels with 1x1 transparent
                        let pattern = format!(
                            "<img[^>]*src=[\"']{}[\"'][^>]*/?>",
                            regex::escape(&node.url)
                        );
                        out = regex_replace_all(&pattern, &out, "<img src=\"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\" alt=\"\" />");
                    }
                    _ => {}
                }
            }
        }

        // Rewrite URLs in attributes to proxy prefix
        out = rewrite_attr(&out, "href", &to_proxy, &target_origin);
        out = rewrite_attr(&out, "src", &to_proxy, &target_origin);
        out = rewrite_attr(&out, "action", &to_proxy, &target_origin);

        // CSS url() rewriting
        out = rewrite_css_urls(&out, proxy_prefix, &target_origin);

        self.heap_size += out.len();
        out
    }

    /// Apply proxy rules
    pub fn apply_rules(&self, url: &str) -> String {
        let state = KERNEL_STATE.lock().unwrap();
        let mut result = url.to_string();
        for rule in &state.proxy_rules {
            if result.contains(&rule.pattern) {
                result = result.replace(&rule.pattern, &rule.rewrite_to);
            }
        }
        result
    }

    pub fn add_rule(&mut self, pattern: &str, rewrite_to: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.proxy_rules.push(ProxyRule {
            pattern: pattern.to_string(),
            rewrite_to: rewrite_to.to_string(),
            headers: HashMap::new(),
        });
    }

    // ==========================
    // VFS
    // ==========================

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
    }

    pub fn vfs_read(&self, path: &str) -> Option<Vec<u8>> {
        let state = KERNEL_STATE.lock().unwrap();
        state.vfs_cache.get(path).map(|e| e.data.clone())
    }

    pub fn vfs_list(&self, prefix: &str) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let files: Vec<&str> = state
            .vfs_cache
            .keys()
            .filter(|k| k.starts_with(prefix))
            .map(|k| k.as_str())
            .collect();
        serde_json::to_string(&files).map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))
    }

    // ==========================
    // Strategy
    // ==========================

    pub fn set_strategy(&mut self, strategy: &str) {
        let mut state = KERNEL_STATE.lock().unwrap();
        state.cors_strategy = strategy.to_string();
        console_log(&format!("[KERNEL] Strategy: {}", strategy));
    }

    pub fn get_strategy(&self) -> String {
        let state = KERNEL_STATE.lock().unwrap();
        state.cors_strategy.clone()
    }

    // ==========================
    // State Snapshots
    // ==========================

    pub fn serialize_state(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        serde_json::to_string(&*state).map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))
    }

    pub fn deserialize_state(&mut self, json: &str) -> Result<(), JsValue> {
        let restored: KernelState = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Deserialize: {}", e)))?;
        let mut state = KERNEL_STATE.lock().unwrap();
        *state = restored;
        self.heap_size = state.vfs_cache.values().map(|e| e.data.len()).sum();
        console_log(&format!(
            "[KERNEL] State restored. Heap: {} bytes",
            self.heap_size
        ));
        Ok(())
    }

    pub fn create_snapshot(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let json = serde_json::to_string(&*state)
            .map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))?;
        let encoded = b64_encode(json.as_bytes());
        console_log(&format!(
            "[KERNEL] Snapshot: {} bytes -> {} b64",
            json.len(),
            encoded.len()
        ));
        Ok(encoded)
    }

    pub fn heap_stats(&self) -> Result<String, JsValue> {
        let state = KERNEL_STATE.lock().unwrap();
        let stats = HeapStats {
            heap_size: self.heap_size,
            vfs_entries: state.vfs_cache.len(),
            request_count: state.request_count,
            active_sessions: state.active_sessions.len(),
            resource_nodes: state.resource_graph.nodes.len(),
            blocked_trackers: state
                .resource_graph
                .nodes
                .iter()
                .filter(|n| n.blocked)
                .count(),
        };
        serde_json::to_string(&stats).map_err(|e| JsValue::from_str(&format!("Serialize: {}", e)))
    }
}

#[derive(Serialize)]
struct HeapStats {
    heap_size: usize,
    vfs_entries: usize,
    request_count: u64,
    active_sessions: usize,
    resource_nodes: usize,
    blocked_trackers: usize,
}

// ==========================
// HTML Transformation Helpers
// ==========================

fn rewrite_attr(
    html: &str,
    attr: &str,
    mapper: &dyn Fn(&str) -> String,
    _target_origin: &str,
) -> String {
    let mut result = html.to_string();

    // Double-quoted
    let pattern_dq = format!(r#"{}="([^"]*)""#, attr);
    result = regex_replace_all_fn(&pattern_dq, &result, |caps: &regex::Captures| {
        let val = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        format!(r#"{}="{}""#, attr, mapper(val))
    });

    // Single-quoted
    let pattern_sq = format!(r#"{}='([^']*)'"#, attr);
    result = regex_replace_all_fn(&pattern_sq, &result, |caps: &regex::Captures| {
        let val = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        format!(r#"{}="{}""#, attr, mapper(val))
    });

    result
}

fn rewrite_css_urls(css: &str, proxy_prefix: &str, target_origin: &str) -> String {
    let re = regex::Regex::new(r#"url\((['"]?)([^'"\)]+)\1\)"#).unwrap();
    re.replace_all(css, |caps: &regex::Captures| {
        let val = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let mapped = if val.starts_with("http") {
            format!("{}?url={}", proxy_prefix, b64_url_encode(val))
        } else if val.starts_with("/") {
            format!(
                "{}?url={}",
                proxy_prefix,
                b64_url_encode(&format!("{}{}", target_origin, val))
            )
        } else {
            val.to_string()
        };
        format!("url({})", mapped)
    })
    .to_string()
}

fn regex_replace_all(pattern: &str, text: &str, replacement: &str) -> String {
    match regex::Regex::new(pattern) {
        Ok(re) => re.replace_all(text, replacement).to_string(),
        Err(_) => text.to_string(),
    }
}

fn regex_replace_all_fn(
    pattern: &str,
    text: &str,
    f: impl Fn(&regex::Captures) -> String,
) -> String {
    match regex::Regex::new(pattern) {
        Ok(re) => re.replace_all(text, f).to_string(),
        Err(_) => text.to_string(),
    }
}

// ==========================
// URL Helpers
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
        let pq = &rest[path_start..];
        if let Some(qs) = pq.find('?') {
            (pq[..qs].to_string(), pq[qs..].to_string())
        } else {
            (pq.to_string(), String::new())
        }
    } else {
        ("/".to_string(), String::new())
    };
    Some(ParsedUrl {
        origin,
        protocol,
        host,
        pathname,
        search,
    })
}

fn resolve_url(rel: &str, base: &str) -> String {
    match url::Url::parse(base) {
        Ok(base_url) => match base_url.join(rel) {
            Ok(u) => u.to_string(),
            Err(_) => format!("{}{}", base.trim_end_matches('/'), rel),
        },
        Err(_) => format!("{}{}", base.trim_end_matches('/'), rel),
    }
}

fn b64_url_encode(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s)
}

fn b64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
