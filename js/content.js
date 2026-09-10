/**
 * ============================================================
 * js/content.js
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

// 嗅探总开关的暂停态（由后台的 setPaused 消息 / 启动时的 getCaptureState 同步）。
// 暂停时：所有上报与扫描入口一律早退，真正省 CPU（不只是"报了再丢"）。
let sniffPaused = false;

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
  // 暂停开关：暂停期间一律不上报。
  // 注意守卫放在最前面（在写入 reported 去重集合之前），这样暂停期间发现的资源
  // 不会被标记为「已上报」，恢复后还能正常重新上报，不会永久漏掉。
  if (sniffPaused) return;
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
// 注：此处刻意**不**加 sniffPaused 早退。劫持是一次性开销（改全局原型），
// 若因暂停跳过劫持，页面在暂停期间加载完就永远不再劫持（srcPatched 未置位也没人重调），
// 会留下状态相关的初始化空洞。保留劫持、让 setter 走 reportResources 的守卫即可，
// 暂停时的额外成本仅一次字符串判断。
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
  if (sniffPaused) return;            // 暂停期间不扫描（本就最耗 CPU 的入口之一）
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

// ---------- 深度搜索增强：接收 MAIN world 注入脚本发现的媒体 URL（P1-6） ----------
// 注入脚本（js/injected-search.js，MAIN world）钩住 fetch/XHR，从响应体里发现
// 「JS 动态拼接的 m3u8」「藏在 JSON 响应里的媒体 URL」等静态扫描抓不到的地址，
// 经 window.postMessage 传到这里（ISOLATED world），再由本脚本上报后台。
// 只在深度搜索模式下生效，避免默认模式的列表被噪音污染。
window.addEventListener('message', (ev) => {
  try {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__mcMediaFound !== true || !Array.isArray(d.urls)) return;
    if (sniffPaused) return;            // 暂停期间丢弃 MAIN world 桥接来的深搜结果
    if (captureMode !== 'deep') return;
    const items = d.urls
      .filter((u) => typeof u === 'string' && isHttpUrl(u))
      .map((u) => ({ url: u, size: null, source: 'dom', deep: true }));
    if (items.length > 0) reportResources(items);
  } catch (e) { /* ignore */ }
});

// ---------- 初次扫描 ----------
// ⚠️ 必须延后到「暂停状态同步完成」之后再扫描：内容脚本是异步向后台查状态的，
// 若在这里立即扫描，页面在暂停期间被打开/刷新时，首次扫描会抢在状态同步之前
// 把整页资源报上去（那时脚本还不知道自己处于暂停态）→ 暂停形同虚设。
// 因此包成函数，只由下方 getCaptureState 的回调触发。
let initialScanDone = false;
function runInitialScan() {
  if (initialScanDone) return;
  initialScanDone = true;
  reportResources(scanMedia().concat(scanImages()).concat(scanPerformance()));
}

// 300ms 兜底：若状态回调仍未到达，**只记录告警，不扫描、不上报、也不置 initialScanDone**。
// 为什么兜底不能"乐观扫一次"：getCaptureState 的回调最终一定会到达（成功走回调；
// 失败/异常也走回调，按「运行中」处理），所以这里不需要抢跑——抢跑反而会在
// 「已暂停 + SW 冷启动 >300ms」时先按运行态把整页资源报上去（漏出首扫）。
// 兜底只用于避免"永久静默"：留一条 warn 便于排查。
// 兜底跳过不会永久漏资源：即便状态查询彻底失败，回调分支仍会触发首扫，
// 且 2s 轮询与 MutationObserver 也会自然补上。
setTimeout(() => {
  if (initialScanDone) return;
  console.warn('[content] 暂停状态同步 300ms 内未返回，暂缓首扫，等回调到达后再决定（避免暂停态漏出首扫）');
}, 300);

// ---------- MutationObserver：捕获懒加载/动态插入 ----------
let pending = null;
new MutationObserver(() => {
  // 暂停期间直接跳过：不排队、不做 scanMedia/scanImages（DOM 全量查询是本脚本的大头开销）。
  // 用标志位早退而不是 disconnect —— 观察器重连逻辑复杂易错，且断连期间的结构变化会丢。
  if (sniffPaused) return;
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    if (sniffPaused) return;   // 排队期间可能被暂停，落地前再确认一次
    reportResources(scanMedia().concat(scanImages()));
  }, 500);
}).observe(document.documentElement, {
  childList: true, subtree: true,
  attributes: true, attributeFilter: ['src', 'srcset', 'poster']
});

// ---------- IntersectionObserver：图片进入视口才抓 ----------
try {
  const io = new IntersectionObserver((entries) => {
    // 暂停期间早退（同样不 disconnect：断连后新插入的懒加载图片就没人重新 observe 了）。
    if (sniffPaused) return;
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

  // 这个 MutationObserver 只负责「把新插入的未加载图片登记进 IntersectionObserver」，
  // 不做任何扫描与上报（无 CPU 大头）。因此**刻意不加** sniffPaused 早退：
  // 若暂停期间跳过登记，这些图片之后既不会被 IO 观察（无重连逻辑），
  // 白白丢掉观察资格；保持登记的成本极低，且恢复后 IO 会正常触发。
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
  // 暂停期间直接跳过本轮（本 tick 每 2 秒跑一次全量 DOM 查询，是常驻 CPU 大头）
  if (sniffPaused) return;
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

// 启动时向后台读取「暂停/恢复」状态（复用已有的 getCaptureState 消息，不新增消息类型）。
// 失败时按「运行中」处理（默认值 sniffPaused=false 即为运行中）。
try {
  chrome.runtime.sendMessage({ action: 'getCaptureState' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.ok && resp.enabled === false) {
      sniffPaused = true;
    }
    // 拿到状态后再做初次扫描：暂停时不发、恢复时照常发（守卫在 reportResources 内）
    runInitialScan();
  });
} catch (e) {
  // 扩展上下文失效：按运行中处理，并照常做初次扫描
  runInitialScan();
}

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
    // 嗅探总开关：后台状态变化后广播下来（暂停/恢复）。
    // 只新增分支，不改动既有的 setMode / rescan 行为。
    if (msg.action === 'setPaused') {
      const next = msg.paused === true;
      if (next === sniffPaused) return;   // 状态未变，无需动作
      sniffPaused = next;
      if (!sniffPaused) {
        // 恢复：立即补一次扫描。暂停期间 reportResources 是「在最前面早退」，
        // 资源没有被写进 reported 去重集合，所以这里能正常补报，不会永久漏抓。
        reportResources(scanMedia().concat(scanImages()));
      }
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
