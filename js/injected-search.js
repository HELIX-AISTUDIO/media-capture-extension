/**
 * ============================================================
 * js/injected-search.js —— 深度搜索增强（MAIN world 注入脚本）
 * ------------------------------------------------------------
 * 由 background.js 在「深度搜索模式」下按需注入（chrome.scripting，world:'MAIN'），
 * 用于发现静态扫描（<script> 文本）抓不到的媒体 URL：
 *   - 页面 JS 动态拼接出来的 m3u8 / mp4 地址
 *   - 藏在 fetch / XHR 的 JSON 响应体里的地址
 *
 * 🔴 红线（务必遵守）：
 *   1. 只做「URL 发现」，不做任何解密、DRM、密钥相关处理；
 *   2. 钩子**只观察、绝不改写**响应内容或请求参数——任何页面行为都不受影响；
 *   3. 全程 try/catch，任何异常都不得冒泡到页面（不能影响站点功能）；
 *   4. 体积 / 类型双重护栏，避免扫描大响应体拖慢页面。
 * ============================================================
 */
(function () {
  'use strict';
  // 防重复注入（同一页面上下文只钩一次）
  if (window.__mcInjected) return;
  window.__mcInjected = true;

  // 媒体 URL 正则（与 content.js 的深度搜索保持一致）
  var MEDIA_RE = /https?:\/\/[^\s"'<>()\\]+?\.(?:m3u8|mpd|mp4|webm|mkv|flv|mov|avi|ts|m4s|m4v|mp3|aac|m4a|ogg|wav|flac|opus)(?:\?[^\s"'<>()\\]*)?/gi;
  // 文本预筛：不含这些关键字直接跳过，省 CPU
  var PRESCREEN_RE = /\.(m3u8|mpd|mp4|m4s|webm|mkv|flv|ts|mp3|m4a|aac|ogg)\b/i;
  // 只扫文本类响应；超过该体积不扫（防大响应体拖慢页面）
  var TEXT_CT_RE = /json|text|javascript|xml/i;
  var MAX_SCAN_BYTES = 2 * 1024 * 1024;
  var MAX_SCAN_CHARS = 500000;
  var MAX_URLS_PER_RESPONSE = 50;

  function post(urls) {
    try {
      window.postMessage({ __mcMediaFound: true, urls: urls }, '*');
    } catch (e) { /* ignore */ }
  }

  function scanText(text) {
    try {
      if (!text || typeof text !== 'string') return;
      if (!PRESCREEN_RE.test(text)) return;
      var slice = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
      var out = [];
      var m;
      MEDIA_RE.lastIndex = 0;
      while ((m = MEDIA_RE.exec(slice)) !== null) {
        out.push(m[0]);
        if (out.length >= MAX_URLS_PER_RESPONSE) break;
      }
      if (out.length > 0) post(out);
    } catch (e) { /* ignore */ }
  }

  // 响应是否符合「值得扫描」的条件（文本类 + 体积可控）
  function worthScan(contentType, contentLength) {
    try {
      if (!TEXT_CT_RE.test(contentType || '')) return false;
      if (contentLength && parseInt(contentLength, 10) > MAX_SCAN_BYTES) return false;
      return true;
    } catch (e) { return false; }
  }

  // ---------- 钩子 1：fetch（只挂观察者，不改写请求/响应） ----------
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        var p = origFetch.apply(this, arguments);   // 原样调用，行为零改变
        try {
          p.then(function (resp) {
            try {
              var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
              var cl = (resp.headers && resp.headers.get && resp.headers.get('content-length')) || '';
              if (!worthScan(ct, cl)) return;
              // clone 后再读，绝不消费原响应体（否则会破坏页面自身逻辑）
              var clone = resp.clone();
              clone.text().then(scanText).catch(function () {});
            } catch (e) { /* ignore */ }
          }).catch(function () {});
        } catch (e) { /* ignore */ }
        return p;
      };
    }
  } catch (e) { /* ignore */ }

  // ---------- 钩子 2：XMLHttpRequest（只读 responseText） ----------
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origSend = XHR.prototype.send;
      XHR.prototype.send = function () {
        try {
          var self = this;
          self.addEventListener('load', function () {
            try {
              var ct = (self.getResponseHeader && self.getResponseHeader('content-type')) || '';
              if (!TEXT_CT_RE.test(ct)) return;
              // 只处理默认 text 响应（json/arraybuffer/blob 等不碰）
              var rt = self.responseType;
              if (rt && rt !== 'text') return;
              scanText(self.responseText);
            } catch (e) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);   // 原样调用，行为零改变
      };
    }
  } catch (e) { /* ignore */ }
})();
