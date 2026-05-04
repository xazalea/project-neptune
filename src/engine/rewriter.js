/**
 * project: neptune — HTML/CSS/JS Rewriter v1.0.0
 * Phase 4.1: Streaming HTML Rewriting Engine
 *
 * Provides URL rewriting for all resource references in HTML, CSS, and JS.
 * Designed to run both inline (in the SVG UI thread) and in the ServiceWorker.
 */

'use strict';

const NeptuneRewriter = (function() {

  /**
   * Convert a URL to the proxy path.
   * @param {string} u - Original URL
   * @param {string} targetOrigin - Origin of the target page
   * @param {string} proxyRoot - Proxy root URL (e.g., "http://localhost:8080/proxy?url=")
   * @returns {string} Rewritten URL
   */
  function toProxy(u, targetOrigin, proxyRoot) {
    if (!u) return u;
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') ||
        u.startsWith('mailto:') || u.startsWith('tel:') || u.startsWith('#')) return u;
    if (u.startsWith(proxyRoot)) return u;
    if (u.startsWith('http://') || u.startsWith('https://')) return proxyRoot + encodeURIComponent(u);
    if (u.startsWith('//')) return proxyRoot + encodeURIComponent('https:' + u);
    if (u.startsWith('/')) return proxyRoot + encodeURIComponent(targetOrigin + u);
    // Relative URL — resolve against target
    try {
      const resolved = new URL(u, targetOrigin + '/').toString();
      return proxyRoot + encodeURIComponent(resolved);
    } catch (e) {
      return u;
    }
  }

  /**
   * Rewrite HTML content — all href, src, action, srcset, and CSS url() references.
   * @param {string} html - Raw HTML content
   * @param {string} targetOrigin - Origin of the target page
   * @param {string} proxyRoot - Proxy root URL
   * @returns {string} Rewritten HTML
   */
  function rewriteHTML(html, targetOrigin, proxyRoot) {
    let out = html;

    // href attributes
    out = out.replace(/href="([^"]*)"/gi, function(m, u) { return 'href="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });
    out = out.replace(/href='([^']*)'/gi, function(m, u) { return 'href="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });

    // src attributes
    out = out.replace(/src="([^"]*)"/gi, function(m, u) { return 'src="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });
    out = out.replace(/src='([^']*)'/gi, function(m, u) { return 'src="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });

    // action attributes (forms)
    out = out.replace(/action="([^"]*)"/gi, function(m, u) { return 'action="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });
    out = out.replace(/action='([^']*)'/gi, function(m, u) { return 'action="' + toProxy(u, targetOrigin, proxyRoot) + '"'; });

    // srcset (responsive images)
    out = out.replace(/srcset="([^"]*)"/gi, function(m, srcset) {
      const rewritten = srcset.split(',').map(function(part) {
        const trimmed = part.trim();
        const words = trimmed.split(/\s+/);
        if (words.length === 0) return part;
        return toProxy(words[0], targetOrigin, proxyRoot) + ' ' + words.slice(1).join(' ');
      }).join(', ');
      return 'srcset="' + rewritten + '"';
    });

    // CSS url() references in inline styles and <style> blocks
    out = out.replace(/url\((['"]?)([^'")\s]+)\1\)/gi, function(m, quote, u) {
      return 'url("' + toProxy(u, targetOrigin, proxyRoot) + '")';
    });

    // Meta refresh
    out = out.replace(/content="\s*\d+\s*;\s*url=([^"]*)"/gi, function(m, u) {
      return 'content="0; url=' + toProxy(u, targetOrigin, proxyRoot) + '"';
    });

    // Remove restrictive headers that break proxying
    out = out.replace(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '<!-- CSP removed by Neptune -->');
    out = out.replace(/<meta[^>]*http-equiv="X-Frame-Options"[^>]*>/gi, '<!-- XFO removed by Neptune -->');

    // Add lazy loading to images
    out = out.replace(/<img([^>]*)>/gi, function(m, attrs) {
      if (attrs.indexOf('loading=') >= 0) return m;
      return '<img' + attrs + ' loading="lazy">';
    });

    return out;
  }

  /**
   * Rewrite CSS content — url() references and @import rules.
   * @param {string} css - Raw CSS content
   * @param {string} targetOrigin - Origin of the target page
   * @param {string} proxyRoot - Proxy root URL
   * @returns {string} Rewritten CSS
   */
  function rewriteCSS(css, targetOrigin, proxyRoot) {
    let out = css;

    // url() references
    out = out.replace(/url\((['"]?)([^'")\s]+)\1\)/gi, function(m, quote, u) {
      return 'url("' + toProxy(u, targetOrigin, proxyRoot) + '")';
    });

    // @import rules
    out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, function(m, quote, u) {
      return '@import "' + toProxy(u, targetOrigin, proxyRoot) + '"';
    });

    // src: url() in @font-face
    out = out.replace(/src:\s*url\((['"]?)([^'")\s]+)\1\)/gi, function(m, quote, u) {
      return 'src: url("' + toProxy(u, targetOrigin, proxyRoot) + '")';
    });

    return out;
  }

  /**
   * Generate the JavaScript runtime injection for intercepting fetch/XHR/clicks/forms.
   * @param {string} targetOrigin - Origin of the target page
   * @param {string} proxyRoot - Proxy root URL
   * @returns {string} JavaScript runtime code
   */
  function getRuntimeScript(targetOrigin, proxyRoot) {
    return '<script id="__nptn_runtime">(function(){' +
      'if(window.__nptn_injected)return;window.__nptn_injected=true;' +
      'var o="' + targetOrigin + '",p="' + proxyRoot + '";' +
      'function r(u){if(!u||u.indexOf("data:")===0||u.indexOf("blob:")===0||u.indexOf("javascript:")===0||u.indexOf("mailto:")===0||u.indexOf("tel:")===0||u.indexOf("#")===0)return u;if(u.indexOf(p)===0)return u;if(u.indexOf("http://")===0||u.indexOf("https://")===0)return p+encodeURIComponent(u);if(u.indexOf("//")===0)return p+encodeURIComponent("https:"+u);if(u.indexOf("/")===0)return p+encodeURIComponent(o+u);try{return p+encodeURIComponent(new URL(u,o+"/").toString())}catch(e){return u}}' +
      'var of=fetch;fetch=function(i,n){if(typeof i==="string")return of(r(i),n);if(i&&i.url)return of(new Request(r(i.url),i),n);return of(i,n)};' +
      'var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return ox.call(this,m,r(u),arguments[3],arguments[4],arguments[5])};' +
      'document.addEventListener("click",function(e){var a=e.target.closest("a");if(a){var h=a.getAttribute("href");if(h&&h.indexOf("javascript:")!==0&&h.indexOf("#")!==0&&h.indexOf("mailto:")!==0&&h.indexOf("tel:")!==0)a.setAttribute("href",r(h))}},true);' +
      'document.addEventListener("submit",function(e){var f=e.target;if(f.tagName==="FORM"){var a=f.getAttribute("action");if(a)f.setAttribute("action",r(a))}},true);' +
      'var hp=history.pushState,hr=history.replaceState;' +
      'history.pushState=function(){var a=arguments;if(a.length>=3&&typeof a[2]==="string")a[2]=r(a[2]);return hp.apply(this,a)};' +
      'history.replaceState=function(){var a=arguments;if(a.length>=3&&typeof a[2]==="string")a[2]=r(a[2]);return hr.apply(this,a)};' +
      '})();</script>';
  }

  /**
   * Generate the bridge script for parent ↔ iframe communication.
   * @param {string} origin - Parent origin for postMessage security
   * @returns {string} Bridge script code
   */
  function getBridgeScript(origin) {
    return '<script id="__nptn_bridge">(function(){' +
      'if(window.__nptn_bridge)return;window.__nptn_bridge=true;' +
      'var p="' + origin + '";' +
      'window.addEventListener("message",function(e){' +
        'if(!e.data||!e.data.__nptn||e.source!==window.parent)return;' +
        'var d=e.data;' +
        'if(d.type==="eval"){try{var r=eval(d.code);e.source.postMessage({__nptn:true,type:"eval_result",id:d.id,result:String(r),error:null},"*")}catch(ex){e.source.postMessage({__nptn:true,type:"eval_result",id:d.id,result:null,error:ex.message},"*")}}' +
        'if(d.type==="get_title"){e.source.postMessage({__nptn:true,type:"title",title:document.title},"*")}' +
        'if(d.type==="get_html"){e.source.postMessage({__nptn:true,type:"html",html:document.documentElement.outerHTML},"*")}' +
        'if(d.type==="get_text"){e.source.postMessage({__nptn:true,type:"text",text:document.body.innerText},"*")}' +
        'if(d.type==="scroll_to"){window.scrollTo(d.x||0,d.y||0)}' +
        'if(d.type==="click"){var el=document.elementFromPoint(d.x,d.y);if(el)el.click()}' +
        'if(d.type==="css"){var s=document.getElementById("__nptn_user_css");if(!s){s=document.createElement("style");s.id="__nptn_user_css";document.head.appendChild(s)}s.textContent=d.css}' +
      '});' +
      'var op=history.pushState,or=history.replaceState;' +
      'history.pushState=function(){op.apply(this,arguments);window.parent.postMessage({__nptn:true,type:"nav",url:location.href},"*")};' +
      'history.replaceState=function(){or.apply(this,arguments);window.parent.postMessage({__nptn:true,type:"nav",url:location.href},"*")};' +
      'window.addEventListener("popstate",function(){window.parent.postMessage({__nptn:true,type:"nav",url:location.href},"*")});' +
      'window.addEventListener("DOMContentLoaded",function(){window.parent.postMessage({__nptn:true,type:"ready",title:document.title,url:location.href},"*")});' +
      '})();</script>';
  }

  /**
   * Lightweight local URL rewriter for drag/drop/paste HTML.
   * @param {string} html - Raw HTML
   * @param {string} baseUrl - Base URL for resolving relatives
   * @param {string} proxyRoot - Proxy root URL
   * @returns {string} Rewritten HTML
   */
  function rewriteLocalHTML(html, baseUrl, proxyRoot) {
    let base = baseUrl;
    const baseMatch = html.match(/<base[^>]+href=["']([^"']+)["']/i);
    if (baseMatch) base = baseMatch[1];

    return rewriteHTML(html, base, proxyRoot);
  }

  return {
    toProxy: toProxy,
    rewriteHTML: rewriteHTML,
    rewriteCSS: rewriteCSS,
    rewriteLocalHTML: rewriteLocalHTML,
    getRuntimeScript: getRuntimeScript,
    getBridgeScript: getBridgeScript,
  };

})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneRewriter;
}
if (typeof window !== 'undefined') {
  window.NeptuneRewriter = NeptuneRewriter;
}
if (typeof self !== 'undefined') {
  self.NeptuneRewriter = NeptuneRewriter;
}
