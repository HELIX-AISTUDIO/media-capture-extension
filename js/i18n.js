/**
 * ============================================================
 * js/i18n.js
 * 轻量国际化（i18n）本地化器 —— 「中文原文即兜底」
 * ------------------------------------------------------------
 * 设计原则：
 *   1. HTML 元素保留中文原文作为内容，仅附加 data-i18n* 属性；
 *      取不到翻译时回退到元素原有文本，绝不产生空白或裸 key。
 *   2. JS 统一以 t(key, '中文兜底') 调用；带变量时传第三参 subs 数组。
 * 引入方式：普通脚本（非 module），须位于 popup.js / viewer.js /
 *          options.js 之前：
 *         <script src="js/i18n.js"></script>
 * 暴露：window.t、window.localizeDom
 * ============================================================
 */
(function () {
  'use strict';

  /**
   * 读取翻译文本。
   * @param {string} key 语言包 key
   * @param {string} [fallback] 取不到时的中文兜底（未传则返回 key 本身）
   * @param {Array} [subs] 占位符 $1/$2… 的取值数组
   * @returns {string}
   */
  function t(key, fallback, subs) {
    let msg = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n &&
          typeof chrome.i18n.getMessage === 'function') {
        const args = Array.isArray(subs) ? subs.map((v) => String(v)) : undefined;
        msg = chrome.i18n.getMessage(key, args) || '';
      }
    } catch (e) {
      msg = '';
    }
    if (msg) return applySubs(msg, subs);
    // 兜底：中文原文（未提供 fallback 时返回 key 本身）
    const base = (fallback === undefined || fallback === null) ? key : String(fallback);
    return applySubs(base, subs);
  }

  /**
   * 简单的 $1/$2 占位替换（用于兜底路径；chrome.i18n 正常路径已替换）。
   * @param {string} str
   * @param {Array} subs
   * @returns {string}
   */
  function applySubs(str, subs) {
    if (!Array.isArray(subs) || subs.length === 0) return String(str);
    let out = String(str);
    for (let i = 0; i < subs.length; i++) {
      out = out.split('$' + (i + 1)).join(String(subs[i]));
    }
    return out;
  }

  /**
   * 写入文本且尽量不破坏内部子元素：
   * 元素若含元素子节点（如 <b>/<span>），只替换其第一个非空文本节点；
   * 纯文本元素则整体替换 textContent。
   * @param {Element} el
   * @param {string} text
   */
  function setTextPreserveChildren(el, text) {
    const hasElementChild = Array.prototype.some.call(
      el.childNodes, (n) => n.nodeType === 1
    );
    if (hasElementChild) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const node = el.childNodes[i];
        if (node.nodeType === 3 && node.textContent.trim() !== '') {
          // 保留原文本节点两侧的空白（如 h1 标题与计数徽标之间的空格），
          // 确保中文界面与外层元素间距与改造前完全一致。
          const orig = node.textContent;
          const lead = (orig.match(/^\s*/) || [''])[0];
          const trail = (orig.match(/\s*$/) || [''])[0];
          node.textContent = lead + text + trail;
          return;
        }
      }
      el.insertBefore(document.createTextNode(text), el.firstChild);
    } else {
      el.textContent = text;
    }
  }

  function localizeText(el) {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    setTextPreserveChildren(el, t(key, el.textContent));
  }

  function localizeTitle(el) {
    const key = el.getAttribute('data-i18n-title');
    if (!key) return;
    el.setAttribute('title', t(key, el.getAttribute('title') || ''));
  }

  function localizePlaceholder(el) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (!key) return;
    el.setAttribute('placeholder', t(key, el.getAttribute('placeholder') || ''));
  }

  // 富文本（含内联标签）元素：整体替换 innerHTML，兜底为元素原始 innerHTML
  function localizeHtml(el) {
    const key = el.getAttribute('data-i18n-html');
    if (!key) return;
    el.innerHTML = t(key, el.innerHTML);
  }

  /**
   * 扫描并本地化 root 子树内的 data-i18n* 元素。
   * @param {Document|Element} [root=document]
   */
  function localizeDom(root) {
    const scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('[data-i18n-html]').forEach(localizeHtml);
    scope.querySelectorAll('[data-i18n-title]').forEach(localizeTitle);
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(localizePlaceholder);
    scope.querySelectorAll('[data-i18n]').forEach(localizeText);
  }

  function boot() {
    try { localizeDom(document); } catch (e) { /* 非扩展上下文等场景静默 */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.t = t;
  window.localizeDom = localizeDom;
})();
