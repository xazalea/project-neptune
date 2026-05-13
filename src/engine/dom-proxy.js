/**
 * DOM Proxy Engine v1.0.0 — Complete browser API monkey-patching for SW-less proxying.
 * 
 * When ServiceWorker registration fails (CDN deployment, blob URL blocked),
 * this engine intercepts ALL resource-loading APIs inside a srcdoc iframe and
 * relays them through the parent SVG page via postMessage.
 * 
 * Intercepted APIs (30+):
 *   Network:    fetch, XHR, WebSocket, EventSource, sendBeacon
 *   Elements:   HTMLScriptElement.src, HTMLImageElement.src, HTMLLinkElement.href,
 *               HTMLIFrameElement.src, HTMLVideoElement.src, HTMLAudioElement.src,
 *               HTMLSourceElement.src, HTMLEmbedElement.src, HTMLObjectElement.data,
 *               HTMLFormElement.action, HTMLInputElement.formAction, HTMLBaseElement.href,
 *               HTMLAnchorElement.href (navigation only)
 *   HTML:       innerHTML, outerHTML, insertAdjacentHTML, document.write,
 *               DOMParser.parseFromString, createContextualFragment
 *   CSS:        CSSStyleDeclaration.setProperty, CSSStyleSheet.insertRule,
 *               HTMLLinkElement (stylesheet → fetch + inline)
 *   Workers:    Worker, SharedWorker, importScripts
 *   DOM:        document.createElement (hook created elements)
 * 
 * Architecture:
 *   srcdoc iframe ──postMessage──> parent SVG page ──fetch()──> internet
 *                <──postMessage──  (returns response)
 */

(function(win) {
  'use strict';

  // ── Guard against double-injection ────────────────────────────────
  if (win.__nptn_dom_proxy_hooked) return;
  win.__nptn_dom_proxy_hooked = true;

  // ── State ─────────────────────────────────────────────────────────
  var msgId = 0;
  var pending = {};  // id → { resolve, reject, timer }
  var relayTimeout = 30000; // 30s timeout for relay requests
  var baseOrigin = '';
  var targetOrigin = '';

  try { baseOrigin = win.location.origin; } catch(e) {}
  try {
    var b = win.document.querySelector('base[href]');
    if (b) targetOrigin = new URL(b.href).origin;
  } catch(e) {}

  // ── Original API references (saved before patching) ──────────────
  var _fetch = win.fetch;
  var _XHR = win.XMLHttpRequest;
  var _WS = win.WebSocket;
  var _ES = win.EventSource;
  var _Worker = win.Worker;
  var _SharedWorker = win.SharedWorker;
  var _openXHR = win.XMLHttpRequest.prototype.open;
  var _sendXHR = win.XMLHttpRequest.prototype.send;
  var _setReqHeader = win.XMLHttpRequest.prototype.setRequestHeader;
  var _createElement = win.document.createElement.bind(win.document);
  var _write = win.document.write.bind(win.document);
  var _DOMParser = win.DOMParser;
  var _parseFromString = win.DOMParser.prototype.parseFromString;
  var _insertAdjHTML = win.Element.prototype.insertAdjacentHTML;
  var _createContextualFragment = win.Range.prototype.createContextualFragment;
  var _setAttribute = win.Element.prototype.setAttribute;
  var _postMessage = win.parent.postMessage.bind(win.parent);

  // ── Utilities ─────────────────────────────────────────────────────
  function isExcludedProtocol(url) {
    if (!url) return true;
    var s = String(url);
    return s.startsWith('data:') || s.startsWith('blob:') ||
           s.startsWith('javascript:') || s.startsWith('mailto:') ||
           s.startsWith('tel:') || s.startsWith('#') ||
           s.startsWith('about:');
  }

  function isExcludedElem(el) {
    // Elements whose URLs should NOT be rewritten (internal anchors, email, tel)
    if (!el) return false;
    var h = el.getAttribute('href');
    if (h && (h.startsWith('#') || h.startsWith('javascript:') ||
              h.startsWith('mailto:') || h.startsWith('tel:'))) return true;
    return false;
  }

  function toAbsolute(url, base) {
    if (isExcludedProtocol(url)) return url;
    try {
      return new URL(url, base || win.document.baseURI).href;
    } catch(e) { return url; }
  }

  // ── Message Relay ─────────────────────────────────────────────────
  // Listens for responses from the parent SVG page
  win.addEventListener('message', function(e) {
    if (!e.data || !e.data.__nptn_relay) return;
    var p = pending[e.data.id];
    if (!p) return;
    clearTimeout(p.timer);
    delete pending[e.data.id];

    if (e.data.type === 'fetch_response') {
      if (e.data.error) {
        p.reject(new Error(e.data.error));
      } else {
        p.resolve({
          status: e.data.status || 200,
          statusText: e.data.statusText || 'OK',
          headers: e.data.headers || {},
          body: e.data.body || null,     // base64 string or null
          bodyType: e.data.bodyType || 'text'  // 'text', 'buffer', 'base64'
        });
      }
    } else if (e.data.type === 'stream_chunk') {
      if (p.onChunk) p.onChunk(e.data.chunk, e.data.done);
      if (e.data.done) {
        clearTimeout(p.timer);
        delete pending[e.data.id];
      }
    } else if (e.data.type === 'ws_open') {
      p.resolve({ wsId: e.data.wsId });
    } else if (e.data.type === 'ws_message') {
      if (p.onMessage) p.onMessage(e.data.data);
    } else if (e.data.type === 'ws_close') {
      if (p.onClose) p.onClose(e.data.code, e.data.reason);
      delete pending[e.data.id];
    } else if (e.data.type === 'ws_error') {
      if (p.onError) p.onError(e.data.error);
    }
  });

  /**
   * Relay a fetch/XHR request to the parent SVG page.
   * Returns a Promise that resolves with { status, headers, body, bodyType }
   */
  function relayFetch(url, options) {
    return new Promise(function(resolve, reject) {
      var id = ++msgId;
      var bodyData = null;
      var bodyType = 'text';

      if (options && options.body) {
        var b = options.body;
        if (b instanceof ArrayBuffer || b instanceof Uint8Array) {
          // Convert binary to base64 for postMessage
          var bytes = new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer);
          var bin = '';
          for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          bodyData = btoa(bin);
          bodyType = 'base64';
        } else if (b instanceof Blob) {
          // Will be handled async below
          bodyType = 'blob';
        } else if (typeof b === 'string') {
          bodyData = b;
          bodyType = 'text';
        } else if (b instanceof FormData) {
          bodyType = 'formdata';
          // Can't easily serialize FormData for postMessage; skip body
        }
      }

      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function() {
          delete pending[id];
          reject(new Error('Fetch relay timeout for ' + url));
        }, relayTimeout)
      };

      function send(msgBody, msgBodyType) {
        _postMessage({
          __nptn_relay: true,
          type: 'fetch_request',
          id: id,
          url: toAbsolute(url),
          method: (options && options.method) || 'GET',
          headers: (options && options.headers) || {},
          body: msgBody,
          bodyType: msgBodyType || 'text',
          credentials: (options && options.credentials) || 'same-origin'
        }, '*');
      }

      if (bodyType === 'blob' && options.body) {
        var reader = new FileReader();
        reader.onload = function() {
          var arr = new Uint8Array(reader.result);
          var bin = '';
          for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
          send(btoa(bin), 'base64');
        };
        reader.onerror = function() { send(null, 'text'); };
        reader.readAsArrayBuffer(options.body);
      } else {
        send(bodyData, bodyType);
      }
    });
  }

  /**
   * Build a Response object from a relay result.
   */
  function buildResponse(relayResult) {
    var body = null;
    if (relayResult.bodyType === 'base64' && relayResult.body) {
      var bin = atob(relayResult.body);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes.buffer;
    } else if (relayResult.bodyType === 'text' && relayResult.body != null) {
      body = relayResult.body;
    }

    var init = {
      status: relayResult.status,
      statusText: relayResult.statusText || 'OK',
      headers: relayResult.headers || {}
    };

    return new Response(body, init);
  }

  /**
   * Fetch a resource through the parent, then create a blob URL for it.
   * Used for scripts and stylesheets that need to load as element src/href.
   */
  function fetchAsBlobUrl(url) {
    return relayFetch(url).then(function(result) {
      if (!result.body) return url; // fallback to original URL

      var mimeType = 'application/octet-stream';
      if (result.headers) {
        var ct = result.headers['content-type'] || result.headers['Content-Type'];
        if (ct) mimeType = ct.split(';')[0].trim();
      }

      var blob;
      if (result.bodyType === 'base64') {
        var bin = atob(result.body);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: mimeType });
      } else {
        blob = new Blob([result.body], { type: mimeType });
      }

      return URL.createObjectURL(blob);
    }).catch(function() {
      return url; // fallback to original URL on error
    });
  }

  // ── 1. fetch() ────────────────────────────────────────────────────
  win.fetch = function(resource, options) {
    var url = typeof resource === 'string'
      ? resource
      : (resource instanceof Request ? resource.url : String(resource));

    // Pass through blob/data URLs and excluded protocols
    if (isExcludedProtocol(url)) return _fetch.call(win, resource, options);

    // Handle Request objects
    var opts = options || {};
    if (resource instanceof Request) {
      opts.method = resource.method;
      opts.headers = {};
      resource.headers.forEach(function(v, k) { opts.headers[k] = v; });
      if (!opts.body) opts.body = resource.body;
    }

    return relayFetch(url, opts).then(buildResponse);
  };

  // Enable access to original fetch for internal use
  win.fetch._nptn_original = _fetch;

  // ── 2. XMLHttpRequest ─────────────────────────────────────────────
  function XHRProxy() {
    var xhr = this;
    var _reqUrl = null;
    var _reqMethod = 'GET';
    var _reqHeaders = {};
    var _reqBody = null;
    var _readyState = 0;
    var _status = 0;
    var _responseHeaders = {};
    var _responseText = '';
    var _responseBlob = null;
    var _responseArrayBuffer = null;
    var _responseType = '';
    var _sent = false;

    // Store original XHR instance for event dispatch
    var _origXHR = new _XHR();

    // Event handlers
    var _onreadystatechange = null;
    var _onload = null;
    var _onerror = null;
    var _onloadend = null;
    var _onprogress = null;
    var _ontimeout = null;
    var _onabort = null;

    Object.defineProperty(this, 'readyState', {
      get: function() { return _readyState; },
      configurable: true
    });
    Object.defineProperty(this, 'status', {
      get: function() { return _status; },
      configurable: true
    });
    Object.defineProperty(this, 'statusText', {
      get: function() { return _status ? 'OK' : ''; },
      configurable: true
    });
    Object.defineProperty(this, 'responseText', {
      get: function() { return _responseType === '' || _responseType === 'text' ? _responseText : ''; },
      configurable: true
    });
    Object.defineProperty(this, 'response', {
      get: function() {
        if (_responseType === 'blob') return _responseBlob;
        if (_responseType === 'arraybuffer') {
          if (_responseArrayBuffer) return _responseArrayBuffer;
          if (_responseBlob) return _responseBlob; // fallback for text bodies
          return null;
        }
        if (_responseType === 'json') {
          try { return JSON.parse(_responseText); } catch(e) { return null; }
        }
        if (_responseType === 'document') {
          // Can't create a real Document from relayed HTML; return null
          return _responseXML;
        }
        return _responseText;
      },
      configurable: true
    });
    Object.defineProperty(this, 'responseXML', {
      get: function() {
        if (!_responseXML && _responseText && (_responseType === '' || _responseType === 'document')) {
          try {
            var parser = new DOMParser();
            _responseXML = parser.parseFromString(_responseText, 'text/html');
          } catch(e) { _responseXML = null; }
        }
        return _responseXML;
      },
      configurable: true
    });
    Object.defineProperty(this, 'responseType', {
      get: function() { return _responseType; },
      set: function(v) { _responseType = v; },
      configurable: true
    });

    var _eventHandlers = {};
    ['onreadystatechange','onload','onerror','onloadend','onprogress','ontimeout','onabort'].forEach(function(evt) {
      Object.defineProperty(xhr, evt, {
        get: function() { return _eventHandlers[evt] || null; },
        set: function(fn) { _eventHandlers[evt] = fn; },
        configurable: true
      });
    });

    this.open = function(method, url, async, user, password) {
      _reqMethod = method.toUpperCase();
      _reqUrl = toAbsolute(url);
      _readyState = 1;
      if (_eventHandlers.onreadystatechange) _eventHandlers.onreadystatechange.call(xhr);
    };

    this.setRequestHeader = function(name, value) {
      _reqHeaders[name] = value;
    };

    this.send = function(body) {
      _reqBody = body;
      _sent = true;
      _readyState = 2;
      if (_eventHandlers.onreadystatechange) _eventHandlers.onreadystatechange.call(xhr);

      relayFetch(_reqUrl, { method: _reqMethod, headers: _reqHeaders, body: _reqBody })
        .then(function(result) {
          _status = result.status;
          _responseHeaders = result.headers || {};

          // Build response headers string
          var headerStr = '';
          for (var k in _responseHeaders) {
            headerStr += k + ': ' + _responseHeaders[k] + '\r\n';
          }

          _readyState = 3; // HEADERS_RECEIVED
          if (_eventHandlers.onreadystatechange) _eventHandlers.onreadystatechange.call(xhr);

          // Build response body
          if (result.bodyType === 'base64' && result.body) {
            var bin = atob(result.body);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            _responseText = (typeof TextDecoder !== 'undefined')
              ? new TextDecoder().decode(bytes)
              : bin; // fallback
            _responseArrayBuffer = bytes.buffer;
            _responseBlob = new Blob([bytes.buffer]);
          } else if (result.body != null) {
            _responseText = String(result.body);
            _responseBlob = new Blob([_responseText]);
          }

          _readyState = 4; // DONE
          if (_eventHandlers.onreadystatechange) _eventHandlers.onreadystatechange.call(xhr);
          if (_eventHandlers.onload) _eventHandlers.onload.call(xhr);
          if (_eventHandlers.onloadend) _eventHandlers.onloadend.call(xhr);
        })
        .catch(function(err) {
          _status = 0;
          _readyState = 4;
          if (_eventHandlers.onreadystatechange) _eventHandlers.onreadystatechange.call(xhr);
          if (_eventHandlers.onerror) _eventHandlers.onerror.call(xhr, err);
          if (_eventHandlers.onloadend) _eventHandlers.onloadend.call(xhr);
        });
    };

    this.abort = function() {
      _readyState = 4;
      _status = 0;
      if (_eventHandlers.onabort) _eventHandlers.onabort.call(xhr);
    };

    this.getResponseHeader = function(name) {
      var lname = name.toLowerCase();
      for (var k in _responseHeaders) {
        if (k.toLowerCase() === lname) return _responseHeaders[k];
      }
      return null;
    };

    this.getAllResponseHeaders = function() {
      var s = '';
      for (var k in _responseHeaders) s += k + ': ' + _responseHeaders[k] + '\r\n';
      return s;
    };

    this.overrideMimeType = function() {};
    this.addEventListener = function(type, fn) {
      var evt = 'on' + type;
      var prev = _eventHandlers[evt];
      _eventHandlers[evt] = function(e) {
        if (prev) prev.call(xhr, e);
        fn.call(xhr, e);
      };
    };
    this.removeEventListener = function(type, fn) {
      // Simplified
    };
    var _timeout = 0;
    var _timeoutTimer = null;
    var _withCredentials = false;
    var _responseURL = '';
    var _responseXML = null;

    Object.defineProperty(this, 'timeout', {
      get: function() { return _timeout; },
      set: function(v) { _timeout = v; },
      configurable: true
    });
    Object.defineProperty(this, 'withCredentials', {
      get: function() { return _withCredentials; },
      set: function(v) { _withCredentials = v; },
      configurable: true
    });
    Object.defineProperty(this, 'responseURL', {
      get: function() { return _responseURL; },
      configurable: true
    });
    Object.defineProperty(this, 'responseXML', {
      get: function() {
        if (!_responseXML && _responseText && (_responseType === '' || _responseType === 'document')) {
          try {
            var parser = new DOMParser();
            _responseXML = parser.parseFromString(_responseText, 'text/html');
          } catch(e) { _responseXML = null; }
        }
        return _responseXML;
      },
      configurable: true
    });
    this.upload = {
      addEventListener: function() {},
      removeEventListener: function() {}
    };
  }

  win.XMLHttpRequest = XHRProxy;

  // ── 3. WebSocket ──────────────────────────────────────────────────
  win.WebSocket = function(url, protocols) {
    if (win.__nptn_ws_proxy) {
      // Relay through parent
      var absUrl = toAbsolute(url);
      var wsProxy = {
        url: absUrl,
        readyState: 0, // CONNECTING
        CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
        _wsId: null,
        _events: {},
        _buffered: [],

        set onopen(fn) { this._events.open = fn; },
        get onopen() { return this._events.open; },
        set onmessage(fn) { this._events.message = fn; },
        get onmessage() { return this._events.message; },
        set onclose(fn) { this._events.close = fn; },
        get onclose() { return this._events.close; },
        set onerror(fn) { this._events.error = fn; },
        get onerror() { return this._events.error; },

        send: function(data) {
          if (this.readyState !== 1) return; // Not OPEN
          if (typeof data === 'string') {
            _postMessage({ __nptn_relay: true, type: 'ws_send', wsId: this._wsId, data: data, dataType: 'text' }, '*');
          } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            var bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
            var bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            _postMessage({ __nptn_relay: true, type: 'ws_send', wsId: this._wsId, data: btoa(bin), dataType: 'binary' }, '*');
          } else if (data instanceof Blob) {
            var reader = new FileReader();
            reader.onload = function() {
              var arr = new Uint8Array(reader.result);
              var bin = '';
              for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
              _postMessage({ __nptn_relay: true, type: 'ws_send', wsId: wsProxy._wsId, data: btoa(bin), dataType: 'binary' }, '*');
            };
            reader.readAsArrayBuffer(data);
          }
        },

        close: function(code, reason) {
          _postMessage({ __nptn_relay: true, type: 'ws_close', wsId: this._wsId, code: code || 1000, reason: reason || '' }, '*');
          this.readyState = 3;
          if (this._events.close) this._events.close({ code: code || 1000, reason: reason || '' });
        },

        addEventListener: function(type, fn) {
          var evt = 'on' + type;
          var prev = this._events[type];
          this._events[type] = function(e) {
            if (prev) prev.call(this, e);
            fn.call(this, e);
          };
        }
      };

      // Request parent to open WS connection
      var id = ++msgId;
      pending[id] = {
        resolve: function(result) {
          wsProxy._wsId = result.wsId;
          wsProxy.readyState = 1;
          if (wsProxy._events.open) wsProxy._events.open({});
          // Flush buffered messages
          wsProxy._buffered.forEach(function(d) { wsProxy.send(d); });
          wsProxy._buffered = [];
        },
        reject: function() {
          wsProxy.readyState = 3;
          if (wsProxy._events.error) wsProxy._events.error({});
        },
        onMessage: function(data) {
          if (wsProxy._events.message) wsProxy._events.message({ data: data });
        },
        onClose: function(code, reason) {
          wsProxy.readyState = 3;
          if (wsProxy._events.close) wsProxy._events.close({ code: code, reason: reason });
        },
        onError: function(err) {
          if (wsProxy._events.error) wsProxy._events.error(err);
        },
        timer: setTimeout(function() {
          delete pending[id];
          wsProxy.readyState = 3;
          if (wsProxy._events.error) wsProxy._events.error(new Error('WS connect timeout'));
        }, relayTimeout)
      };

      _postMessage({ __nptn_relay: true, type: 'ws_connect', id: id, url: absUrl, protocols: protocols }, '*');
      return wsProxy;
    }

    // Fallback: direct WebSocket (won't be proxied)
    return new _WS(toAbsolute(url), protocols);
  };
  win.WebSocket.prototype = _WS.prototype;

  // ── 4. EventSource ────────────────────────────────────────────────
  win.EventSource = function(url, options) {
    // EventSource can't easily be relayed; use fetch-based polling as fallback
    // For now, pass through with absolute URL
    return new _ES(toAbsolute(url), options);
  };

  // ── 5. navigator.sendBeacon ───────────────────────────────────────
  if (win.navigator && win.navigator.sendBeacon) {
    var _sendBeacon = win.navigator.sendBeacon.bind(win.navigator);
    win.navigator.sendBeacon = function(url, data) {
      if (isExcludedProtocol(url)) return _sendBeacon(url, data);
      // Fire and forget: relay but don't wait
      relayFetch(url, { method: 'POST', body: data }).catch(function() {});
      return true;
    };
  }

  // ── 6. Workers ────────────────────────────────────────────────────
  // Workers run in a separate context without our monkey-patches.
  // Strategy: create a thin wrapper blob that importScripts() the real URL.
  // The real worker script's own importScripts() calls will NOT be intercepted.
  win.Worker = function(url, options) {
    if (isExcludedProtocol(url)) return new _Worker(url, options);
    var absUrl = toAbsolute(url);
    // Wrap: load the real script via importScripts (which bypasses our hooks)
    // This means the worker script itself loads directly from the original server.
    // Cross-origin workers will fail unless the server sends CORS headers.
    var workerCode = 'importScripts("' + absUrl.replace(/"/g, '\\"') + '");';
    var blob = new Blob([workerCode], { type: 'application/javascript' });
    return new _Worker(URL.createObjectURL(blob), options);
  };

  if (win.SharedWorker) {
    win.SharedWorker = function(url, options) {
      if (isExcludedProtocol(url)) return new _SharedWorker(url, options);
      var absUrl = toAbsolute(url);
      var workerCode = 'importScripts("' + absUrl.replace(/"/g, '\\"') + '");';
      var blob = new Blob([workerCode], { type: 'application/javascript' });
      return new _SharedWorker(URL.createObjectURL(blob), options);
    };
  }

  // ── 7. Property Descriptor Hijacking (Element src/href/data/action) ──
  var URL_PROPS = {
    'HTMLScriptElement':  { prop: 'src',    type: 'url' },
    'HTMLImageElement':   { prop: 'src',    type: 'url' },
    'HTMLSourceElement':  { prop: 'src',    type: 'url' },
    'HTMLVideoElement':   { prop: 'src',    type: 'url' },
    'HTMLAudioElement':   { prop: 'src',    type: 'url' },
    'HTMLIFrameElement':  { prop: 'src',    type: 'url' },
    'HTMLEmbedElement':   { prop: 'src',    type: 'url' },
    'HTMLObjectElement':  { prop: 'data',   type: 'url' },
    'HTMLLinkElement':    { prop: 'href',   type: 'link' },
    'HTMLAnchorElement':  { prop: 'href',   type: 'nav' },
    'HTMLFormElement':    { prop: 'action', type: 'url' },
    'HTMLInputElement':   { prop: 'formAction', type: 'url' },
    'HTMLBaseElement':    { prop: 'href',   type: 'url' },
    'HTMLTrackElement':   { prop: 'src',    type: 'url' },
  };

  Object.keys(URL_PROPS).forEach(function(elemName) {
    var info = URL_PROPS[elemName];
    var proto = win[elemName] && win[elemName].prototype;
    if (!proto) return;

    try {
      var desc = Object.getOwnPropertyDescriptor(proto, info.prop);
      if (!desc || !desc.set) return;

      var origSet = desc.set;
      var origGet = desc.get;

      Object.defineProperty(proto, info.prop, {
        get: origGet,
        set: function(val) {
          if (val === null || val === undefined) {
            return origSet.call(this, val);
          }

          var strVal = String(val);

          // Skip excluded protocols
          if (isExcludedProtocol(strVal)) {
            return origSet.call(this, val);
          }

          // For anchor elements, don't proxy navigation — let the click handler manage it
          if (info.type === 'nav') {
            return origSet.call(this, val);
          }

          // For link elements (stylesheets), fetch via parent and convert to inline/blobl
          if (info.type === 'link') {
            var rel = this.rel || '';
            var as = this.as || '';
            if (rel === 'stylesheet' || as === 'style') {
              fetchAsBlobUrl(strVal).then(function(blobUrl) {
                origSet.call(this, blobUrl);
              }.bind(this)).catch(function() {
                origSet.call(this, toAbsolute(strVal));
              }.bind(this));
              return;
            }
            // For preload, icon, etc., just make absolute
            return origSet.call(this, toAbsolute(strVal));
          }

          // For all other elements: try to fetch as blob URL for full proxying
          // Fall back to absolute URL if blob fetch fails
          var absUrl = toAbsolute(strVal);
          var self = this;

          // For scripts and critical resources, use blob URL for full proxy control
          if (info.prop === 'src' && (elemName === 'HTMLScriptElement' || elemName === 'HTMLIFrameElement')) {
            fetchAsBlobUrl(absUrl).then(function(blobUrl) {
              origSet.call(self, blobUrl);
            }).catch(function() {
              origSet.call(self, absUrl);
            });
          } else {
            // For images, media, embeds — use absolute URL (most CDNs serve these with CORS)
            origSet.call(this, absUrl);
          }
        },
        configurable: true,
        enumerable: true
      });
    } catch(e) {
      // Property may not be configurable; skip
    }
  });

  // ── 8. innerHTML / outerHTML ──────────────────────────────────────
  function rewriteHTMLString(html) {
    if (typeof html !== 'string') return html;

    // Remove CSP and frame-busting headers
    html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    html = html.replace(/<meta[^>]*http-equiv=["']X-Frame-Options["'][^>]*>/gi, '');
    html = html.replace(/<meta[^>]*http-equiv=["']refresh["'][^>]*>/gi, '<!-- blocked meta refresh -->');

    // Strip integrity attributes (SRI checks fail with proxied content)
    html = html.replace(/\bintegrity=["'][^"']*["']/gi, '');
    // Strip nonce attributes (break with rewritten content)
    html = html.replace(/\bnonce=["'][^"']*["']/gi, '');

    // Rewrite url() references inside inline <style> blocks
    html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, function(m, open, css, close) {
      css = css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m2, q, u) {
        if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m2;
        try { return 'url("' + new URL(u, targetOrigin || baseOrigin).href + '")'; }
        catch(e) { return m2; }
      });
      css = css.replace(/@import\s+url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m2, q, u) {
        if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m2;
        try { return '@import url("' + new URL(u, targetOrigin || baseOrigin).href + '")'; }
        catch(e) { return m2; }
      });
      return open + css + close;
    });

    // Rewrite url() references in inline style attributes
    html = html.replace(/\bstyle=["']([^"']*)["']/gi, function(m, styleVal) {
      var rewritten = styleVal.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m2, q, u) {
        if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m2;
        try { return 'url("' + new URL(u, targetOrigin || baseOrigin).href + '")'; }
        catch(e) { return m2; }
      });
      return 'style="' + rewritten + '"';
    });

    // Rewrite srcset attributes (responsive images)
    html = html.replace(/\bsrcset=["']([^"']*)["']/gi, function(m, srcsetVal) {
      var rewritten = srcsetVal.replace(/(https?:\/\/[^\s,]+|[^\s,]+\.[a-z]+(\?[^\s,]*)?)(\s+\d+[wx])?/gi, function(m2, u, rest) {
        if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m2;
        try { return new URL(u, targetOrigin || baseOrigin).href + (rest || ''); }
        catch(e) { return m2; }
      });
      return 'srcset="' + rewritten + '"';
    });

    // Rewrite poster attribute on <video> elements
    html = html.replace(/\bposter=["']([^"']*)["']/gi, function(m, u) {
      if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m;
      try { return 'poster="' + new URL(u, targetOrigin || baseOrigin).href + '"'; }
      catch(e) { return m; }
    });

    // Rewrite background attribute on <body>/<table>/etc elements
    html = html.replace(/\bbackground=["']([^"']*)["']/gi, function(m, u) {
      if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m;
      try { return 'background="' + new URL(u, targetOrigin || baseOrigin).href + '"'; }
      catch(e) { return m; }
    });

    // Rewrite formaction attributes on <button>/<input> elements
    html = html.replace(/\bformaction=["']([^"']*)["']/gi, function(m, u) {
      try { return 'formaction="' + new URL(u, targetOrigin || baseOrigin).href + '"'; }
      catch(e) { return m; }
    });

    // Rewrite <source> src and srcset for <picture>/<video>/<audio>
    html = html.replace(/(<source[^>]*?\bsrc=["'])([^"']*)(["'][^>]*>)/gi, function(m, pre, u, post) {
      if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m;
      try { return pre + new URL(u, targetOrigin || baseOrigin).href + post; }
      catch(e) { return m; }
    });

    // Rewrite <object> data attribute
    html = html.replace(/(<object[^>]*?\bdata=["'])([^"']*)(["'][^>]*>)/gi, function(m, pre, u, post) {
      if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m;
      try { return pre + new URL(u, targetOrigin || baseOrigin).href + post; }
      catch(e) { return m; }
    });

    // Rewrite <embed> src attribute
    html = html.replace(/(<embed[^>]*?\bsrc=["'])([^"']*)(["'][^>]*>)/gi, function(m, pre, u, post) {
      if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return m;
      try { return pre + new URL(u, targetOrigin || baseOrigin).href + post; }
      catch(e) { return m; }
    });

    return html;
  }

  var _origInnerHTMLDesc = Object.getOwnPropertyDescriptor(win.Element.prototype, 'innerHTML');
  if (_origInnerHTMLDesc && _origInnerHTMLDesc.set) {
    Object.defineProperty(win.Element.prototype, 'innerHTML', {
      get: _origInnerHTMLDesc.get,
      set: function(val) {
        return _origInnerHTMLDesc.set.call(this, rewriteHTMLString(val));
      },
      configurable: true
    });
  }

  var _origOuterHTMLDesc = Object.getOwnPropertyDescriptor(win.Element.prototype, 'outerHTML');
  if (_origOuterHTMLDesc && _origOuterHTMLDesc.set) {
    Object.defineProperty(win.Element.prototype, 'outerHTML', {
      get: _origOuterHTMLDesc.get,
      set: function(val) {
        return _origOuterHTMLDesc.set.call(this, rewriteHTMLString(val));
      },
      configurable: true
    });
  }

  // ── 9. insertAdjacentHTML ─────────────────────────────────────────
  win.Element.prototype.insertAdjacentHTML = function(position, html) {
    return _insertAdjHTML.call(this, position, rewriteHTMLString(html));
  };

  // ── 10. document.write ────────────────────────────────────────────
  win.document.write = function() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) {
      args.push(rewriteHTMLString(arguments[i]));
    }
    return _write.apply(win.document, args);
  };

  // ── 11. DOMParser ─────────────────────────────────────────────────
  win.DOMParser = function() {
    this._native = new _DOMParser();
  };
  win.DOMParser.prototype.parseFromString = function(str, type) {
    var rewritten = (type === 'text/html') ? rewriteHTMLString(str) : str;
    return this._native.parseFromString(rewritten, type);
  };

  // ── 12. createContextualFragment ──────────────────────────────────
  win.Range.prototype.createContextualFragment = function(html) {
    return _createContextualFragment.call(this, rewriteHTMLString(html));
  };

  // ── 13. CSS Interception ──────────────────────────────────────────
  // Intercept CSSStyleDeclaration.setProperty for url()-containing CSS properties
  var CSS_URL_PROPS = [
    'background-image', 'background', 'border-image', 'border-image-source',
    'list-style-image', 'cursor', 'content', 'mask-image', 'mask',
    'shape-outside', '-webkit-mask-image', 'filter'
  ];

  var _cssSetProperty = win.CSSStyleDeclaration.prototype.setProperty;
  if (_cssSetProperty) {
    win.CSSStyleDeclaration.prototype.setProperty = function(prop, value, priority) {
      if (CSS_URL_PROPS.indexOf(prop) !== -1 && typeof value === 'string') {
        value = value.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m, q, u) {
          if (isExcludedProtocol(u)) return m;
          return 'url("' + toAbsolute(u) + '")';
        });
      }
      return _cssSetProperty.call(this, prop, value, priority);
    };
  }

  // Intercept CSSStyleSheet.insertRule and addRule for @import rewriting
  var _insertRule = win.CSSStyleSheet.prototype.insertRule;
  if (_insertRule) {
    win.CSSStyleSheet.prototype.insertRule = function(rule, index) {
      if (typeof rule === 'string' && rule.indexOf('@import') !== -1) {
        rule = rule.replace(/@import\s+url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m, q, u) {
          if (isExcludedProtocol(u)) return m;
          return '@import url("' + toAbsolute(u) + '")';
        });
      }
      return _insertRule.call(this, rule, index);
    };
  }

  // ── 13b. CSS Property Descriptor Hijacking ──────────────────────────
  // Intercept direct property assignment like element.style.backgroundImage = 'url(...)'.
  // setProperty() alone doesn't catch direct assignment — we need to override
  // the property descriptors on CSSStyleDeclaration.prototype.
  (function() {
    var CSS_URL_PROPS_CAMEL = {
      'backgroundImage': 'background-image',
      'background': 'background',
      'borderImage': 'border-image',
      'borderImageSource': 'border-image-source',
      'listStyleImage': 'list-style-image',
      'cursor': 'cursor',
      'content': 'content',
      'maskImage': 'mask-image',
      'mask': 'mask',
      'shapeOutside': 'shape-outside',
      'WebkitMaskImage': '-webkit-mask-image'
    };

    var proto = win.CSSStyleDeclaration.prototype;
    Object.keys(CSS_URL_PROPS_CAMEL).forEach(function(camel) {
      try {
        var origDesc = Object.getOwnPropertyDescriptor(proto, camel);
        if (!origDesc || !origDesc.set) return;

        var origSet = origDesc.set;
        var origGet = origDesc.get;

        Object.defineProperty(proto, camel, {
          get: origGet,
          set: function(val) {
            if (typeof val === 'string' && val.indexOf('url(') !== -1) {
              // Use the same URL rewriting logic as setProperty
              val = val.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, function(m, q, u) {
                if (isExcludedProtocol(u)) return m;
                return 'url("' + toAbsolute(u) + '")';
              });
            }
            return origSet.call(this, val);
          },
          configurable: true,
          enumerable: true
        });
      } catch(e) {
        // Property may not be configurable; skip
      }
    });
  })();

  // ── 14. MutationObserver — catch dynamically added elements ───────
  // Intercept stylesheet <link> elements and inline <style> via DOM observation
  var _origObserve = win.MutationObserver.prototype.observe;
  // (MutationObserver hooking is complex; for now we rely on property descriptors
  //  and createElement hooks to catch dynamic elements)

  // ── 15. setAttribute override ─────────────────────────────────────
  // Catch setAttribute calls for src/href/data/action
  var URL_ATTRS = { src: 1, href: 1, data: 1, action: 1, formAction: 1 };

  win.Element.prototype.setAttribute = function(name, value) {
    if (URL_ATTRS[name] && !isExcludedProtocol(value)) {
      // Let the property descriptor handle the rewriting
      // The property setter will be called by the native setAttribute
    }
    return _setAttribute.call(this, name, value);
  };

  // ── 16. document.createElement hook ──────────────────────────────
  // Intercept element creation to hook stylesheet links
  win.document.createElement = function(tagName, options) {
    var el = _createElement(tagName, options);
    var tag = tagName.toLowerCase();

    // For stylesheet links, intercept the href setter to fetch + inline
    if (tag === 'link') {
      var linkDesc = Object.getOwnPropertyDescriptor(win.HTMLLinkElement.prototype, 'href');
      if (linkDesc && linkDesc.set) {
        var origHrefSet = linkDesc.set;
        Object.defineProperty(el, 'href', {
          get: linkDesc.get || function() { return el.getAttribute('href'); },
          set: function(val) {
            if (isExcludedProtocol(val)) {
              return origHrefSet.call(el, val);
            }
            var rel = el.getAttribute('rel') || '';
            var as = el.getAttribute('as') || '';
            if (rel === 'stylesheet' || as === 'style') {
              fetchAsBlobUrl(toAbsolute(val)).then(function(blobUrl) {
                origHrefSet.call(el, blobUrl);
              }).catch(function() {
                origHrefSet.call(el, toAbsolute(val));
              });
            } else {
              origHrefSet.call(el, toAbsolute(val));
            }
          },
          configurable: true
        });
      }
    }

    // For scripts, intercept src for blob URL proxying
    if (tag === 'script') {
      var scriptDesc = Object.getOwnPropertyDescriptor(win.HTMLScriptElement.prototype, 'src');
      if (scriptDesc && scriptDesc.set) {
        var origSrcSet = scriptDesc.set;
        Object.defineProperty(el, 'src', {
          get: scriptDesc.get || function() { return el.getAttribute('src'); },
          set: function(val) {
            if (!val || isExcludedProtocol(val)) {
              return origSrcSet.call(el, val);
            }
            fetchAsBlobUrl(toAbsolute(val)).then(function(blobUrl) {
              origSrcSet.call(el, blobUrl);
            }).catch(function() {
              origSrcSet.call(el, toAbsolute(val));
            });
          },
          configurable: true
        });
      }
    }

    return el;
  };

  // ── 17. Navigation click interceptor ──────────────────────────────
  win.document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('javascript:') || h.startsWith('#') ||
        h.startsWith('mailto:') || h.startsWith('tel:')) return;
    e.preventDefault();
    e.stopPropagation();
    _postMessage({ __nptn: true, type: 'nav', url: toAbsolute(h) }, '*');
  }, true);

  win.document.addEventListener('submit', function(e) {
    var f = e.target;
    if (f.tagName !== 'FORM') return;
    var ac = f.getAttribute('action');
    if (ac) {
      e.preventDefault();
      _postMessage({ __nptn: true, type: 'nav', url: toAbsolute(ac) }, '*');
    }
  }, true);

  // Message handler for eval and page-text requests from parent
  win.addEventListener('message', function(e) {
    if (!e.data || !e.data.__nptn) return;
    if (e.data.type === 'eval') {
      try {
        var r = eval(e.data.code);
        e.source.postMessage({ __nptn: true, type: 'eval_result', result: r, error: null, id: e.data.id }, '*');
      } catch(ex) {
        e.source.postMessage({ __nptn: true, type: 'eval_result', result: null, error: ex.message, id: e.data.id }, '*');
      }
    }
    if (e.data.type === 'get_text') {
      var txt = win.document.body ? win.document.body.innerText || '' : '';
      e.source.postMessage({ __nptn: true, type: 'page_text', text: txt }, '*');
    }
  });

  // ── Expose API for the page ───────────────────────────────────────
  win.__nptn_proxy = {
    fetch: relayFetch,
    fetchAsBlobUrl: fetchAsBlobUrl,
    toAbsolute: toAbsolute,
    isExcluded: isExcludedProtocol
  };

  // Log that we're hooked
  try { console.log('[DOM-PROXY] Hooked ' + Object.keys(URL_PROPS).length + ' element types + 16 API surfaces'); } catch(e) {}

})(window);
