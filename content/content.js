/**
 * ============================================================
 * content/content.js
 * 内容脚本：注入到所有页面（含 iframe），捕获媒体资源
 * ------------------------------------------------------------
 * 功能：
 *   1. 劫持 HTMLMediaElement.prototype.src，监听视频/音频 src 赋值
 *   2. 轮询 <video>/<audio>.currentSrc + <source> 标签
 *   3. 扫描 <img>（只抓已加载且尺寸达标的，过滤 logo/icon 垃圾）
 *   4. 缓存捕捉：performance.getEntriesByType('resource') 读取已载入
 *      缓存、不二次请求的资源（解决漏抓）
 *   5. 深度搜索：扫描页面 <script> 文本与 window 对象里的媒体 URL
 *      （m3u8/mp4/密钥/一次性 URL）
 *   6. 从 <video>.poster 提取封面，关联到视频资源
 *   7. IntersectionObserver：图片进入视口才抓（未加载不抓）
 *   8. 防死循环/高频轮询节流，控制 CPU 占用
 * ============================================================
 */

const reported = new Set(); // 本次页面生命周期内已上报 URL 去重

// 抓取模式：'default' 过滤垃圾 / 'deep' 全部抓取（由 popup 经后台同步）
let captureMode = 'default';

// 图片尺寸阈值
const MIN_IMG_EDGE = 120;
const MIN_IMG_AREA = 120 * 120;

// 图片垃圾关键词
const IMG_JUNK_RE = /(logo|icon|avatar|sprite|emoji|favicon|loading|placeholder|spinner|dot|badge|pixel|blank|transparent|tracking|beacon|spacer|1x1|arrow|btn|button|qrcode|qr_code|thum?b|tiny|small|mini|ad[-_]|banner|promo|slide|carousel|watermark|share[-_]|header|footer|nav-|sprite|cover-?img|sm[-_.]|xs[-_.]|bg[-_.]|^_|@!|_\d+_\d+\.|\d{2,4}x\d{2,4})/i;

// 平台图片黑名单（抖音/YouTube 不抓图片）
const IMG_HOST_BLOCKLIST = /(\.ytimg\.com|googlevideo\.com|douyinpic\.com|byteeffect|byteicdn|byteimg|byteimgcn|mmstat|alipay|aliimg|bdimg|baidu\.com\/img|doubleclick|googlesyndication|gstatic\.com\/ads)/i;

// 深度搜索：页面脚本/变量里的媒体 URL 正则
const DEEP_MEDIA_RE = /(https?:\/\/[^\s"'<>()\\]+?\.(?:m3u8|mp4|webm|mkv|flv|mov|avi|ts|m4s|m4v|mpd|mp3|aac|m4a|ogg|wav|flac|opus|png|jpe?g|gif|webp|bmp|avif)(?:\?[^\s"'<>()\\]*)?)/gi;

// 深度搜索：疑似密钥 URL
const DEEP_KEY_RE = /(https?:\/\/[^\s"'<>()\\]+?\.(?:key|bin)(?:\?[^\s"'<>()\\]*)?)/gi;

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:/i.test(u);
}

function isMeaningfulImage(img) {
  const w = img.naturalWidth || 0;
  const h = img.naturalHeight || 0;
  if (!img.complete || w === 0 || h === 0) return false;
  if (w < MIN_IMG_EDGE && h < MIN_IMG_EDGE) return false;
  if (w * h < MIN_IMG_AREA) return false;
  const src = img.currentSrc || img.src || '';
  // 显式过滤矢量图标/网站图标文件（svg/ico 基本不是"主要内容图"）
  if (/\.(svg|ico)(\?|#|$)/i.test(src)) return false;
  if (IMG_JUNK_RE.test(src)) return false;
  try {
    const hostname = new URL(src).hostname;
    if (IMG_HOST_BLOCKLIST.test(hostname)) return false;
  } catch { /* ignore */ }
  return true;
}

function reportResources(items) {
  const fresh = (items || []).filter((it) => {
    if (!it || !it.url || reported.has(it.url)) return false;
    reported.add(it.url);
    return true;
  });
  if (fresh.length === 0) return;
  try {
    chrome.runtime.sendMessage(
      { action: 'addDomResources', items: fresh },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    // 扩展上下文失效（如重载瞬间）时忽略，避免 "Invalid context" 污染控制台
  }
}

// ---------- 劫持 HTMLMediaElement.prototype.src ----------
let srcPatched = false;
function patchMediaSrc() {
  if (srcPatched) return;
  try {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        if (isHttpUrl(v)) {
          reportResources([{ url: v, size: null, source: 'dom' }]);
        }
        desc.set.call(this, v);
      }
    });
    srcPatched = true;
  } catch (e) { /* CSP 严格页面可能失败 */ }
}
patchMediaSrc();

// ---------- 扫描视频/音频元素 ----------
function scanMedia() {
  const out = [];
  document.querySelectorAll('video, audio').forEach((el) => {
    const src = el.currentSrc || el.src;
    if (src && isHttpUrl(src)) {
      const item = { url: src, size: null, source: 'dom' };
      if (el.tagName === 'VIDEO' && el.poster && isHttpUrl(el.poster)) {
        item.posterUrl = el.poster;
      }
      // 读取时长（视频元素已加载元数据时）
      if (el.duration && isFinite(el.duration)) item.duration = el.duration;
      out.push(item);
    }
  });
  // <source> 标签（多清晰度 src）
  document.querySelectorAll('video source, audio source').forEach((s) => {
    const src = s.src;
    if (src && isHttpUrl(src)) {
      out.push({ url: src, size: null, source: 'dom' });
    }
  });
  return out;
}

// ---------- 扫描图片 ----------
// mode 缺省时使用当前 captureMode；deep 模式不过滤，全部抓取
function scanImages(mode) {
  const m = mode || captureMode;
  const out = [];
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || !isHttpUrl(src)) return;
    if (m === 'deep') {
      // 深度搜索模式：不过滤尺寸/关键词/平台黑名单，全部抓取
      out.push({
        url: src, size: null, source: 'dom',
        width: img.naturalWidth || null, height: img.naturalHeight || null
      });
      return;
    }
    if (!isMeaningfulImage(img)) return;
    out.push({
      url: src, size: null, source: 'dom',
      width: img.naturalWidth, height: img.naturalHeight
    });
  });
  return out;
}

// ---------- 缓存捕捉：performance 资源时间线 ----------
// 读取已载入缓存、不再二次请求的资源（解决漏抓，参考猫抓"缓存捕捉"）
function scanPerformance() {
  const out = [];
  try {
    const entries = performance.getEntriesByType('resource');
    for (const e of entries) {
      const name = e.name || '';
      if (!isHttpUrl(name)) continue;
      // 修复：只对「路径 pathname」做媒体扩展名匹配，不对完整 URL 匹配。
      // 否则日志接口（如 data.bilibili.com/log/web?...含".m4s?"字样的查询串）
      // 会因查询串里嵌着媒体扩展名被误报为媒体资源。
      let path = name;
      try { path = new URL(name).pathname; } catch { /* ignore */ }
      if (/\.(m3u8|m4s|mp4|webm|mkv|flv|mov|avi|ts|m4v|mpd|mp3|aac|m4a|ogg|wav|flac|opus|png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(path)) {
        out.push({
          url: name,
          size: e.transferSize > 0 ? e.transferSize : null,
          source: 'dom',
          ts: Math.round(performance.timeOrigin + e.startTime)
        });
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// ---------- 深度搜索：扫描 <script> 文本与 window 变量 ----------
let deepSearchDone = false;
function deepSearch() {
  if (captureMode !== 'deep') return; // 脚本深搜仅在「深度搜索模式」执行，默认模式保持干净
  if (deepSearchDone) return;
  deepSearchDone = true;
  const out = [];
  try {
    // 扫描所有 script 标签的内联文本
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.length < 10) continue;
      // 限制扫描长度，避免超大脚本拖慢页面
      const slice = text.slice(0, 200000);
      let m;
      DEEP_MEDIA_RE.lastIndex = 0;
      while ((m = DEEP_MEDIA_RE.exec(slice)) !== null) {
        if (m[1]) out.push({ url: m[1], size: null, source: 'dom', deep: true });
        if (out.length > 200) break; // 防死循环/资源爆量
      }
    }
  } catch (e) { /* ignore */ }
  if (out.length) reportResources(out);
}

// ---------- 初次扫描 ----------
reportResources(scanMedia().concat(scanImages()).concat(scanPerformance()));

// ---------- MutationObserver：捕获懒加载/动态插入 ----------
let pending = null;
new MutationObserver(() => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    reportResources(scanMedia().concat(scanImages()));
  }, 500);
}).observe(document.documentElement, {
  childList: true, subtree: true,
  attributes: true, attributeFilter: ['src', 'srcset', 'poster']
});

// ---------- IntersectionObserver：图片进入视口才抓 ----------
try {
  const io = new IntersectionObserver((entries) => {
    const items = [];
    for (const e of entries) {
      if (e.isIntersecting && e.target.complete && e.target.naturalWidth) {
        const src = e.target.currentSrc || e.target.src;
        if (src && isHttpUrl(src) && isMeaningfulImage(e.target)) {
          items.push({
            url: src, size: null, source: 'dom',
            width: e.target.naturalWidth, height: e.target.naturalHeight
          });
        }
        io.unobserve(e.target);
      }
    }
    if (items.length) reportResources(items);
  }, { rootMargin: '300px' });

  document.querySelectorAll('img').forEach((img) => {
    if (!img.complete || !img.naturalWidth) io.observe(img);
  });

  new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          if (node.tagName === 'IMG' && (!node.complete || !node.naturalWidth)) io.observe(node);
          node.querySelectorAll && node.querySelectorAll('img').forEach((img) => {
            if (!img.complete || !img.naturalWidth) io.observe(img);
          });
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
} catch (e) { /* 老浏览器不支持 */ }

// ---------- 轮询兜底（节流：2 秒一次） ----------
let scanTick = 0;
setInterval(() => {
  scanTick++;
  reportResources(scanMedia().concat(scanImages()));
  // 每 5 次（约 10 秒）做一次 performance 扫描，捕捉新缓存资源
  if (scanTick % 5 === 0) {
    reportResources(scanPerformance());
  }
}, 2000);

// ---------- 页面加载完成后做深度搜索 ----------
window.addEventListener('load', () => {
  reportResources(scanMedia().concat(scanImages()).concat(scanPerformance()));
  // 延迟 2 秒做深度搜索，等页面脚本执行完毕
  setTimeout(deepSearch, 2000);
}, { once: true });

// 若 load 已触发，直接排深度搜索
if (document.readyState === 'complete') {
  setTimeout(deepSearch, 2000);
}

// ---------- 抓取模式同步与重扫 ----------
// 启动时向后台读取当前模式
try {
  chrome.runtime.sendMessage({ action: 'getMode' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.ok) captureMode = resp.mode === 'deep' ? 'deep' : 'default';
  });
} catch (e) { /* 扩展上下文失效时忽略 */ }

// 监听后台/弹窗下发的模式切换与重扫指令
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.action === 'setMode') {
      captureMode = msg.mode === 'deep' ? 'deep' : 'default';
      // 切到深度模式时，触发脚本深搜（默认模式下深搜被跳过）
      if (captureMode === 'deep') deepSearch();
      return;
    }
    if (msg.action === 'rescan') {
      // 清空去重集合，允许已上报资源被重新上报
      reported.clear();
      // 立即重扫媒体与图片（缓存捕捉由常规轮询兜底）
      reportResources(scanMedia().concat(scanImages()));
      return;
    }
  });
} catch (e) { /* 忽略 */ }

// ---------- SPA 单页应用路由切换检测 ----------
// 触发清理时机：history.pushState/replaceState 或 popstate/hashchange 导致
// 「路由」变化时（history 路由看 pathname，hash 路由看 #/ 前缀），通知后台
// 清空本 tab 旧资源，防止旧路由的媒体混入新路由列表。纯 hash 锚点（#section）
// 不触发，避免误清。
function spaRouteKey() {
  const h = location.hash || '';
  const hashRoute = /^#!?\//.test(h) ? h : '';
  return location.pathname + location.search + hashRoute;
}
let lastSpaRoute = spaRouteKey();
let spaTimer = null;
function onSpaRouteChange() {
  const key = spaRouteKey();
  if (key === lastSpaRoute) return; // 无实质路由变化
  lastSpaRoute = key;
  if (spaTimer) return; // 防抖：连续 pushState 只通知一次
  spaTimer = setTimeout(() => {
    spaTimer = null;
    try { chrome.runtime.sendMessage({ action: 'pageChanged' }); } catch (e) { /* ignore */ }
  }, 80);
}

// patch history.pushState / replaceState
['pushState', 'replaceState'].forEach((m) => {
  const orig = history[m];
  if (typeof orig === 'function') {
    history[m] = function (...args) {
      const ret = orig.apply(history, args);
      onSpaRouteChange();
      return ret;
    };
  }
});
window.addEventListener('popstate', onSpaRouteChange);
window.addEventListener('hashchange', onSpaRouteChange);
