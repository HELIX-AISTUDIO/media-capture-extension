/**
 * ============================================================
 * tests/helpers/loader.js —— 测试辅助：把浏览器端经典脚本载入 vm 沙箱
 * ------------------------------------------------------------
 * 背景：
 *   js/media-parser.js / m3u8-parser.js / mpd-parser.js 都是「经典脚本」
 *   （非 ES module、无 module.exports），通过 background.js 的 importScripts
 *   或页面 <script> 引入。为了在 Node 里直接测它们的纯函数，这里用内置
 *   vm 模块把它们跑在同一个沙箱上下文里 —— 顶层 `function` 声明会挂到
 *   沙箱全局，测试即可直接取用（如 sandbox.classify）。
 *
 *   注意：mpd-parser 依赖 m3u8-parser 的 resolveUrl，故两者必须按序载入
 *   同一沙箱（与 background.js 中 importScripts 的顺序保持一致）。
 *
 *   Node 没有内置 DOMParser，这里提供一个仅够 parseMpd 使用的极简实现
 *   （getElementsByTagName / getAttribute / textContent）。
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 项目根目录（tests/helpers/ → 上两级）。 */
const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 极简 XML DOM（仅覆盖 parseMpd 用到的能力） ----------
/** XML 元素节点。 */
class XmlElement {
  /**
   * @param {string} tag 标签名
   * @param {Object<string,string>} attrs 属性表
   */
  constructor(tag, attrs) {
    this.tagName = tag;
    this._attrs = attrs || {};
    this.children = [];   // 子元素
    this.childNodes = []; // 子节点（含文本节点）
    this.nodeType = 1;
  }

  /** 读取属性；不存在返回 null（与浏览器一致）。 */
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  /** 递归后代文本拼接。 */
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join('');
  }

  /** 按标签名深度优先查找后代（返回数组，带 length，兼容浏览器用法）。 */
  getElementsByTagName(name) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (name === '*' || child.tagName === name) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

/** 追加文本节点。 */
function appendText(el, text) {
  el.childNodes.push({ nodeType: 3, data: text });
}

/** XML 实体解码（够用即可）。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** 属性串 → 属性表。 */
function parseAttrs(attrText) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m = re.exec(attrText || '');
  while (m) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    m = re.exec(attrText || '');
  }
  return attrs;
}

const XML_TOKEN_RE = new RegExp([
  '<\\?[\\s\\S]*?\\?>',                                        // 声明
  '<!--[\\s\\S]*?-->',                                         // 注释
  '<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>',                          // CDATA
  '</([A-Za-z_][\\w:.-]*)\\s*>',                               // 闭合标签
  '<([A-Za-z_][\\w:.-]*)((?:\\s+[A-Za-z_][\\w:.-]*\\s*=\\s*(?:"[^"]*"|\'[^\']*\'))*)\\s*(/)?>', // 开标签
  '([^<]+)'                                                    // 文本
].join('|'), 'g');

/** 解析 XML 文本为 XmlElement 文档根。 */
function parseXml(text) {
  const root = new XmlElement('#document', {});
  const stack = [root];
  let m = XML_TOKEN_RE.exec(text);
  while (m) {
    if (m[1] !== undefined) {                       // CDATA
      appendText(stack[stack.length - 1], m[1]);
    } else if (m[2] !== undefined) {                // 闭合标签
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {                // 开标签
      const el = new XmlElement(m[3], parseAttrs(m[4]));
      const parent = stack[stack.length - 1];
      parent.children.push(el);
      parent.childNodes.push(el);
      if (!m[5]) stack.push(el);                    // 非自闭合 → 入栈
    } else if (m[6] !== undefined) {                // 文本
      appendText(stack[stack.length - 1], decodeEntities(m[6]));
    }
    m = XML_TOKEN_RE.exec(text);
  }
  XML_TOKEN_RE.lastIndex = 0;
  return root;
}

/** 极简 DOMParser：Node 无内置，仅实现 parseFromString(xml)。 */
class MiniDOMParser {
  /**
   * @param {string} text XML 文本
   * @returns {XmlElement} 文档根
   */
  parseFromString(text) {
    return parseXml(String(text == null ? '' : text));
  }
}

/** 最小 chrome API 桩：避免脚本顶层读取 chrome 时抛错。 */
function makeChromeStub() {
  const noopCb = (keys, cb) => { if (typeof cb === 'function') cb({}); };
  return {
    runtime: { lastError: null, getURL: (p) => 'chrome-extension://test/' + p, sendMessage: () => {} },
    storage: {
      sync: { get: noopCb, set: () => {} },
      local: { get: noopCb, set: () => {} },
      session: { get: noopCb, set: () => {} }
    },
    i18n: { getMessage: () => '' }
  };
}

/**
 * 创建沙箱上下文。
 * @returns {object} 沙箱全局对象
 */
function createSandbox() {
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    DOMParser: MiniDOMParser,
    chrome: makeChromeStub()
  };
  vm.createContext(sandbox);
  return sandbox;
}

/**
 * 把一个经典脚本载入沙箱。
 * @param {object} sandbox 沙箱全局
 * @param {string} relPath 相对项目根的路径，如 'js/media-parser.js'
 */
function loadScript(sandbox, relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInContext(code, sandbox, { filename: relPath });
}

/**
 * 载入三个解析器（顺序与 background.js 的 importScripts 一致）。
 * @returns {object} 沙箱全局（可直接取 classify / parseM3u8 / parseMpd 等）
 */
function loadParsers() {
  const sandbox = createSandbox();
  loadScript(sandbox, 'js/media-parser.js');
  loadScript(sandbox, 'js/m3u8-parser.js');
  loadScript(sandbox, 'js/mpd-parser.js');
  return sandbox;
}

module.exports = { ROOT, loadParsers, createSandbox, loadScript, MiniDOMParser };
