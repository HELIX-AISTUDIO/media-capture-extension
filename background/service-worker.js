/**
 * ============================================================
 * background/service-worker.js
 * 后台 Service Worker（Manifest V3）
 * ------------------------------------------------------------
 * 功能：
 *   1. chrome.webRequest 非阻塞观察网络请求
 *      （onBeforeRequest + onSendHeaders + onResponseStarted + onErrorOccurred）
 *   2. 资源数据按 tabId 隔离持久化到 chrome.storage.session（解决 SW 休眠丢数据）
 *   3. 页面生命周期清理：导航/刷新/SPA 路由切换即清空本 tab 旧资源（多 tab 隔离）
 *   4. 白名单优先的干净过滤（视频/音频/图片/流媒体），未知类型默认丢弃
 *   5. m3u8 / MPD 解析（调用 m3u8-parser.js / mpd-parser.js）
 *   6. 消息路由：取列表 / 清空 / 下载 / 批量复制 / DOM上报 / 解析 / 页面变更
 *
 * MV3 关键决策（务必遵守）：
 *   - 仅用「非阻塞」webRequest 观察，绝不使用已废弃的 blocking。
 *   - declarativeNetRequest 只能 block/redirect，无法"读取 URL 到扩展
 *     逻辑"，因此"收集资源列表"场景必须用 webRequest，这是 MV3 下
 *     唯一合规路径。
 *   - storage.session 跨 SW 休眠存活（浏览器会话期间），解决数据丢失。
 *
 * SW 生命周期健壮性（参考猫抓对抗 MV3 休眠的策略，独立实现）：
 *   a. 接受 SW 必死：关键数据落 storage.session，唤醒后 restoreFromStorage 自愈；
 *   b. chrome.alarms 定时唤醒（重注册监听器 + 孤儿 tab 回收）；
 *   c. webNavigation 空监听作为导航事件唤醒源；
 *   d. onConnect 长连接在 popup 打开期间保持 SW 活跃。
 *
 * 页面隔离（v0.2.3 新增，核心）：
 *   - 每个 tab 维护一个「页面代数」pageEpoch；导航/SPA 切换时 clearTabData + 代数 +1；
 *   - 请求在 onBeforeRequest 记录发起时的代数 requestGen，onResponseStarted 校验，
 *     旧页面残留的延迟请求（代数不匹配）直接丢弃，防止混入新页面列表；
 *   - 数据按 tabId 隔离，清理只影响本 tab，绝不干扰其他 tab。
 * ============================================================
 */

importScripts('media-parser.js', 'm3u8-parser.js', 'mpd-parser.js');

// ---------- 安全 listener 注册 helper ----------
// 防止单个 chrome API 在某些 Edge/Chrome 版本不可用时导致整个 SW 注册失败（Status 15）。
function safeOn(ns, event, fn, ...args) {
  try {
    if (ns && ns[event] && typeof ns[event].addListener === 'function') {
      ns[event].addListener(fn, ...args);
    } else {
      console.warn('[SW]', event, 'unavailable (namespace missing)');
    }
  } catch (e) {
    console.warn('[SW] addListener', event, 'failed:', String(e && e.message || e));
  }
}

// 内存存储：tabId -> Map<normalizedUrl, resource>
// 同时镜像到 chrome.storage.session，SW 休眠重启后可从 storage 恢复。
const store = new Map();

// 持久化键前缀
const STORE_KEY_PREFIX = 'mediaStore::';

// 存储结构版本：升级后与旧版本数据不兼容（过滤规则已换代），
// 版本不匹配的旧抓取数据直接作废清除，防止垃圾数据重新混入列表
const STORE_VERSION = 'v3';

// 是否已完成从 storage.session 的初始化恢复
let restored = false;

// 抓取模式：'default'（干净过滤） / 'deep'（全部抓取）
let currentCaptureMode = 'default';

// 写存储的节流（debounce），避免高频 IO
const persistTimers = new Map();

// requestId -> referer（onSendHeaders 暂存，onResponseStarted 消费后删除）
const requestReferer = new Map();

// tabId -> 页面代数（每次导航/SPA 切换 +1，用于拦截旧页面的延迟返回请求）
const pageEpoch = new Map();

// requestId -> 请求发起时的页面代数（onBeforeRequest 记录，onResponseStarted 校验）
const requestGen = new Map();

// ---------- storage.session 持久化 ----------
function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    persistTab(tabId);
  }, 500));
}

function persistTab(tabId) {
  const map = store.get(tabId);
  if (!map) {
    chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
    return;
  }
  // 序列化为普通对象（Map → Object）
  const obj = {};
  for (const [url, r] of map) obj[url] = r;
  chrome.storage.session.set({ [STORE_KEY_PREFIX + tabId]: obj }, () => void chrome.runtime.lastError);
}

// 从 storage.session 恢复全部数据（SW 启动时调用一次）
function restoreFromStorage() {
  if (restored) return;
  restored = true;
  chrome.storage.session.get(null, (items) => {
    if (chrome.runtime.lastError || !items) return;
    // 版本不匹配（首次升级 / 旧版本残留）→ 作废全部旧抓取数据
    if (items.storeVersion !== STORE_VERSION) {
      const stale = Object.keys(items).filter((k) => k.startsWith(STORE_KEY_PREFIX));
      chrome.storage.session.remove(stale, () => void chrome.runtime.lastError);
      chrome.storage.session.set({ storeVersion: STORE_VERSION }, () => void chrome.runtime.lastError);
      sweepOrphanTabs();
      return;
    }
    for (const key of Object.keys(items)) {
      if (!key.startsWith(STORE_KEY_PREFIX)) continue;
      const tabId = parseInt(key.slice(STORE_KEY_PREFIX.length), 10);
      if (isNaN(tabId)) continue;
      const obj = items[key];
      const map = new Map();
      for (const url of Object.keys(obj)) map.set(url, obj[url]);
      store.set(tabId, map);
    }
    // 恢复后回收孤儿 tab（已关闭的 tab 残留数据）
    sweepOrphanTabs();
  });
}
try { restoreFromStorage(); } catch (e) { console.warn('[SW] restoreFromStorage failed:', String(e && e.message || e)); }

// 启动时读取上次保存的抓取模式
try {
  chrome.storage.local.get('captureMode', (result) => {
    if (chrome.runtime.lastError) return;
    const v = result && result.captureMode;
    if (v === 'deep' || v === 'default') currentCaptureMode = v;
  });
} catch (e) { console.warn('[SW] storage.local.get failed:', String(e && e.message || e)); }

// ---------- SW 生命周期：alarms 定时唤醒 ----------
try {
  chrome.alarms.create('media-heartbeat', { periodInMinutes: 5 });
} catch (e) { console.warn('[SW] alarms.create unavailable:', String(e && e.message || e)); }
safeOn(chrome.alarms, 'onAlarm', (alarm) => {
  if (alarm.name === 'media-heartbeat') sweepOrphanTabs();
});

// ---------- SW 生命周期：webNavigation 作为唤醒源 + 导航清理 ----------
// 触发清理时机：主框架（frameId === 0）导航提交（刷新 / URL 跳转 / 前进后退 / 重载），
// 清空该 tab 抓取数据并递增页面代数，旧页面 in-flight 请求后续会被代数校验丢弃。
safeOn(chrome.webNavigation, 'onCommitted', (details) => {
  if (details.frameId === 0) resetTabForNavigation(details.tabId);
});

// ---------- SW 生命周期：onConnect 长连接保活 ----------
safeOn(chrome.runtime, 'onConnect', (port) => {
  if (port.name !== 'media-heartbeat') return;
  const keepAlive = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); }
    catch (e) { clearInterval(keepAlive); }
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(keepAlive));
});

// ---------- 页面代数 & 导航清理 ----------
// 递增页面代数：导航/SPA 切换后，旧代数发起的请求会被识别为"残留"而丢弃。
function bumpEpoch(tabId) {
  pageEpoch.set(tabId, (pageEpoch.get(tabId) || 0) + 1);
}

// 页面导航/SPA 切换：清空本 tab 数据 + 递增代数（只影响本 tab，不干扰其他 tab）
function resetTabForNavigation(tabId) {
  clearTabData(tabId);
  bumpEpoch(tabId);
}

// ---------- 孤儿 tab 回收 ----------
// 用 tabs.query 快照删除已关闭 tab 的残留数据（参考猫抓 clearRedundant 思想）
// 孤儿 tab 回收：参考猫抓 clearRedundant() 思路——按当前存活 tab 集合清理
// 已关闭 tab 的残留数据，防止多 tab 并发下 storage.session 无限增长（内存泄漏）。
// 另：单 tab 上限 MAX_RESOURCES_PER_TAB=500 与猫抓 tabFingerprints 的 500 上限一致。
function sweepOrphanTabs() {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    const alive = new Set((tabs || []).map((t) => t.id).filter((id) => id != null));
    for (const tabId of Array.from(store.keys())) {
      if (!alive.has(tabId)) clearTabData(tabId);
    }
  });
}

function clearTabData(tabId) {
  if (tabId == null || tabId < 0) return;
  store.delete(tabId);
  pageEpoch.delete(tabId);
  chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
  chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError);
}

// ---------- 存储资源 ----------
function storeResource(tabId, resource) {
  if (!tabId || tabId < 0) return;
  if (!store.has(tabId)) store.set(tabId, new Map());
  const map = store.get(tabId);

  // 限制每 tab 资源数，防止内存泄漏/CPU 占用
  if (map.size >= MAX_RESOURCES_PER_TAB) return;

  // 归一化 key：去掉缓存/分片参数，让同一资源的不同分片/带缓存串的
  // 请求收敛成一条（参考猫抓对 bytestart 分片的归一化思路）。
  const key = normalizeUrl(resource.url);
  const existing = map.get(key);
  if (existing) {
    // 合并：DOM 来源优先；取更大 size；补全缺失字段
    if (existing.source === 'network' && resource.source !== 'network') {
      existing.source = resource.source;
    }
    if (resource.size && (!existing.size || resource.size > existing.size)) {
      existing.size = resource.size;
    }
    if (!existing.mime && resource.mime) existing.mime = resource.mime;
    if (!existing.referer && resource.referer) existing.referer = resource.referer;
    if (resource.width && !existing.width) existing.width = resource.width;
    if (resource.height && !existing.height) existing.height = resource.height;
    if (resource.posterUrl && !existing.posterUrl) existing.posterUrl = resource.posterUrl;
    if (resource.ts && (!existing.ts || resource.ts > existing.ts)) existing.ts = resource.ts;
  } else {
    map.set(key, resource);
  }
  updateBadge(tabId);
  schedulePersist(tabId);
}

// 移除单条资源（用于"过滤不通过时撤销已有条目"）
function removeResource(tabId, url) {
  const map = store.get(tabId);
  if (!map) return;
  if (map.delete(normalizeUrl(url))) {
    updateBadge(tabId);
    schedulePersist(tabId);
  }
}

function updateBadge(tabId) {
  const count = store.get(tabId)?.size || 0;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id === tabId) {
      chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }, () => void chrome.runtime.lastError);
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }, () => void chrome.runtime.lastError);
    }
  });
}

// ---------- 响应头解析 ----------
function getHeaderValue(headers, name) {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === name.toLowerCase()) return h.value || null;
  }
  return null;
}

function getContentRangeTotal(headers) {
  const v = getHeaderValue(headers, 'content-range');
  if (!v) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(v);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function getContentLength(headers) {
  const rangeTotal = getContentRangeTotal(headers);
  if (rangeTotal != null) return rangeTotal;
  const v = getHeaderValue(headers, 'content-length');
  if (v) {
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function getContentType(headers) {
  const v = getHeaderValue(headers, 'content-type');
  return v ? v.split(';')[0].trim() : null;
}

// ---------- 预览防盗链：declarativeNetRequest 会话规则注入 Referer ----------
// MV3 约束：popup 里的 <video>/<audio> 无法直接携带 Referer（downloads 注入
// 头也会被拒），导致 B 站 bilivideo.com 等校验 Referer 的 CDN 预览必 403。
// 解决：预览打开期间用 DNR 会话规则为该资源域名注入「抓取时记录的原始
// Referer」；通过 excludedInitiatorDomains 排除原页面自身流量，不影响页面
// 正常播放；预览关闭即移除规则。
const PREVIEW_RULE_ID = 1;

// 取近似主域（eTLD+1 的朴素实现，够用于排除原页面流量）
function rootDomainOf(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function setPreviewRefererRule(url, referer) {
  // 返回 Promise<boolean>：规则是否成功写入（供查看器显示注入状态）
  return new Promise((resolve) => {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) {
        resolve(false);
        return;
      }
      const host = new URL(url).hostname;
      // 用主域而非精确子域：CDN 常在播放中重定向到同主域的其它子域
      // （如 upos-sz-estghw → upos-sz-mirror-coldetc），精确域名会导致
      // 重定向后的请求不受规则保护而 403。注入的 Referer 值就是原页面
      // 自己发请求时用的 Referer，因此对页面正常播放无副作用。
      const root = rootDomainOf(host);
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [PREVIEW_RULE_ID],
        addRules: [{
          id: PREVIEW_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }]
          },
          condition: {
            requestDomains: [root],
            resourceTypes: ['media', 'xmlhttprequest', 'other']
          }
        }]
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[SW] previewReferer rule failed:', chrome.runtime.lastError.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      console.warn('[SW] setPreviewRefererRule failed:', String(e && e.message || e));
      resolve(false);
    }
  });
}

function clearPreviewRefererRule() {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PREVIEW_RULE_ID] }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// ---------- 下载期间的 Referer 规则生命周期 ----------
// chrome.downloads.download 的请求同样不带 Referer：防盗链 CDN 直接 403，
// Edge 会把 403 错误页保存成 .htm（表现为"下载变成 htm / 没有权限"）。
// 因此下载期间也注入 Referer 规则，全部下载结束（完成/中断）后移除。
const trackedDownloads = new Set();
let downloadCleanupTimer = null;

safeOn(chrome.downloads, 'onChanged', (delta) => {
  if (!trackedDownloads.has(delta.id)) return;
  const st = delta.state && delta.state.current;
  if (st === 'complete' || st === 'interrupted') {
    trackedDownloads.delete(delta.id);
    if (trackedDownloads.size === 0) clearPreviewRefererRule();
  }
});

function trackDownloadCleanup(id) {
  if (id === undefined || id === null) { clearPreviewRefererRule(); return; }
  trackedDownloads.add(id);
  // 兜底：3 分钟后无论如何清掉规则，避免长期残留
  clearTimeout(downloadCleanupTimer);
  downloadCleanupTimer = setTimeout(() => {
    if (trackedDownloads.size > 0) {
      trackedDownloads.clear();
      clearPreviewRefererRule();
    }
  }, 180000);
}

// ---------- 监听请求开始：记录页面代数 + 过滤追踪 ----------
safeOn(chrome.webRequest, 'onBeforeRequest', (details) => {
  const { tabId } = details;
  if (tabId < 0) return; // 后台请求无归属 tab，忽略
  // 记录该请求发起时的页面代数，供 onResponseStarted 拦截旧页面残留的延迟请求
  requestGen.set(details.requestId, pageEpoch.get(tabId) || 0);
}, { urls: ['<all_urls>'] });

// ---------- 监听请求头：暂存 referer（用于防盗链识别） ----------
safeOn(chrome.webRequest, 'onSendHeaders', (details) => {
  if (details.tabId < 0) return;
  const referer = getHeaderValue(details.requestHeaders, 'referer');
  if (referer) requestReferer.set(details.requestId, referer);
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

// ---------- 监听响应开始：主捕获点（更早拿到响应头） ----------
safeOn(chrome.webRequest, 'onResponseStarted', (details) => {
  const { tabId, url, responseHeaders, type: resourceType } = details;
  if (tabId < 0) return;

  // 校验页面代数：旧页面残留的延迟返回请求（代数不匹配）直接丢弃，
  // 防止跳转前页面的请求混入新页面资源列表（修复边界 bug）。
  const reqGen = requestGen.get(details.requestId);
  requestGen.delete(details.requestId);
  const curGen = pageEpoch.get(tabId) || 0;
  if (reqGen !== undefined && reqGen !== curGen) return;

  if (isTrackingUrl(url)) return;

  // 消费 referer（用完即删，防内存泄漏）
  const referer = requestReferer.get(details.requestId);
  requestReferer.delete(details.requestId);

  const mime = getContentType(responseHeaders);
  const size = getContentLength(responseHeaders);
  let type = classify(url, mime);

  // resourceType 兜底：URL 无媒体扩展名、mime 不明但浏览器判定为明确的
  // video/audio/media（媒体元素发起），视为媒体（参考猫抓多路判定）。
  if (type === 'unknown') {
    if (resourceType === 'video' || resourceType === 'media') type = 'video';
    else if (resourceType === 'audio') type = 'audio';
  }

  // 过滤 .flv 直播流（RTMP-flv 不可下载）
  if (/\.flv(\?|#|$)/i.test(url)) return;

  // 统一过滤闸门：白名单优先 + 黑名单 + content-type + 尺寸（默认模式）
  if (!shouldKeepResource(type, url, mime, size, currentCaptureMode)) return;

  // content-disposition 附件名优先（修复 URL 无文件名场景）
  const cdName = parseContentDisposition(responseHeaders);
  storeResource(tabId, {
    url,
    type,
    mime,
    size,
    filename: cdName || filenameFromUrl(url),
    source: 'network',
    referer: referer || null,
    ts: Date.now()
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// ---------- 监听请求失败：清理暂存 ----------
safeOn(chrome.webRequest, 'onErrorOccurred', (details) => {
  requestGen.delete(details.requestId);
  requestReferer.delete(details.requestId);
});

// ---------- 标签页关闭时清理 ----------
safeOn(chrome.tabs, 'onRemoved', (tabId) => {
  clearTabData(tabId);
});

// ---------- 消息路由 ----------
safeOn(chrome.runtime, 'onMessage', (msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case 'getResources': {
      const tabId = msg.tabId ?? sender.tab?.id;
      let list = Array.from(store.get(tabId)?.values() || []);
      // 读取时二次过滤（双保险）：拦截旧版本残留 / 任何边界漏网的
      // 非媒体资源，保证弹窗列表永远干净（深度模式不过滤）
      if (currentCaptureMode !== 'deep') {
        list = list.filter((r) => !isTrackingUrl(r.url) && (() => {
          // 用当前规则重算类型：修正旧数据可能存在的类型误标
          // （如封面图被标成视频）；classify 认不出时沿用存储的类型
          const t = classify(r.url, r.mime);
          return shouldKeepResource(t !== 'unknown' ? t : r.type, r.url, r.mime, r.size, 'default');
        })());
        // 类型误标修正同步到展示（如封面图 video → image）
        list.forEach((r) => {
          const t = classify(r.url, r.mime);
          if (t !== 'unknown' && t !== r.type) r.type = t;
        });
      }
      // 倒序排列：最新抓取的置顶（参考猫抓 2.7.2）
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // B 站 m4s 音频流推测
      for (const r of list) {
        if (r.type === 'video' && /\.m4s(\?|#|$)/i.test(r.url) &&
            r.size != null && r.size > 0 && r.size < BILI_AUDIO_M4S_MAX) {
          r.likelyAudio = true;
        }
      }
      sendResponse({ ok: true, resources: list });
      break;
    }

    case 'clearResources': {
      const tabId = msg.tabId ?? sender.tab?.id;
      clearTabData(tabId);
      sendResponse({ ok: true });
      break;
    }

    // SPA 单页应用路由切换（由 content script 检测 pushState/popstate 上报）
    case 'pageChanged': {
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId != null && tabId >= 0) resetTabForNavigation(tabId);
      sendResponse({ ok: true });
      break;
    }

    case 'setMode': {
      const mode = msg.mode === 'deep' ? 'deep' : 'default';
      currentCaptureMode = mode;
      chrome.storage.local.set({ captureMode: mode }, () => {
        // 同步到所有已注入的 content script
        chrome.tabs.query({}, (tabs) => {
          for (const t of tabs) {
            if (t.id != null) {
              chrome.tabs.sendMessage(t.id, { action: 'setMode', mode }, () => void chrome.runtime.lastError);
            }
          }
        });
        sendResponse({ ok: true, mode });
      });
      return true; // 异步
    }

    case 'getMode': {
      // 直接从 storage 读取，避免 SW 冷启动时缓存尚未就绪的竞态
      chrome.storage.local.get('captureMode', (result) => {
        const v = result && result.captureMode;
        const mode = (v === 'deep' || v === 'default') ? v : currentCaptureMode;
        currentCaptureMode = mode;
        sendResponse({ ok: true, mode });
      });
      return true; // 异步
    }

    case 'rescan': {
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId != null && tabId >= 0) {
        chrome.tabs.sendMessage(tabId, { action: 'rescan' }, () => void chrome.runtime.lastError);
      }
      sendResponse({ ok: true });
      break;
    }

    // 预览期间为目标资源域名注入 Referer（DNR 会话规则，预览关闭即移除）
    case 'previewReferer': {
      if (msg.url && msg.referer) {
        setPreviewRefererRule(msg.url, msg.referer).then((injected) => sendResponse({ ok: true, injected }));
      } else {
        clearPreviewRefererRule();
        sendResponse({ ok: true, injected: false });
      }
      return true; // 异步
    }

    case 'clearPreviewReferer': {
      clearPreviewRefererRule();
      sendResponse({ ok: true });
      break;
    }

    case 'download': {
      // MV3 安全约束：扩展不能通过 chrome.downloads.download({headers:[...]})
      // 注入 Referer 等 unsafe 头（会抛 "Unsafe request header name"）。
      // 防盗链 CDN 的下载请求不带 Referer 会 403（Edge 把 403 错误页存成 .htm），
      // 因此下载期间用 DNR 会话规则注入 Referer，下载结束自动移除。
      // 文件名先经 safeFilename 清洗，修复超长/非法字符导致下载失败。
      if (msg.url && msg.referer) setPreviewRefererRule(msg.url, msg.referer);
      chrome.downloads.download({
        url: msg.url,
        filename: safeFilename(msg.filename),
        saveAs: true
      }, (id) => {
        if (chrome.runtime.lastError) {
          if (msg.url && msg.referer) clearPreviewRefererRule();
          sendResponse({ ok: false, error: 'download_failed', message: chrome.runtime.lastError.message });
          return;
        }
        trackDownloadCleanup(id);
        sendResponse({ ok: id !== undefined, downloadId: id });
      });
      return true;
    }

    case 'addDomResources': {
      const tabId = msg.tabId ?? sender.tab?.id;
      (msg.items || []).forEach((it) => {
        if (!it || !it.url) return;
        // 追踪/日志接口（data.bilibili.com/log 等）一律不收——
        // DOM/缓存上报路径此前没有这层过滤，导致日志接口混入列表
        if (isTrackingUrl(it.url)) return;
        const type = classify(it.url, it.mime || null);
        // 默认模式：统一过滤闸门（DOM 资源通常已是媒体，此处兜底未知/非媒体）
        if (!shouldKeepResource(type, it.url, it.mime || null, it.size || null, currentCaptureMode)) return;
        // 默认模式：DOM 图片按短边阈值过滤（DOM 图片无字节大小，用自然尺寸判断）。
        // 短边 < 180px 视为图标/头像/装饰小图（v0.2.4：由 120 上调，仅默认模式生效）。
        if (currentCaptureMode === 'default' && type === 'image') {
          if (it.width != null && it.height != null && Math.min(it.width, it.height) < IMG_SHORT_EDGE_MIN) return;
        }
        storeResource(tabId, {
          url: it.url,
          type,
          mime: it.mime || null,
          size: it.size || null,
          filename: filenameFromUrl(it.url),
          source: it.source || 'dom',
          width: it.width || null,
          height: it.height || null,
          posterUrl: it.posterUrl || null,
          referer: it.referer || null,
          ts: it.ts || Date.now()
        });
      });
      sendResponse({ ok: true });
      break;
    }

    case 'parseM3u8': {
      handleParseM3u8(msg, sendResponse);
      return true; // 异步
    }

    case 'parseMpd': {
      handleParseMpd(msg, sendResponse);
      return true; // 异步
    }
  }
});

// ---------- m3u8 解析处理 ----------
function handleParseM3u8(msg, sendResponse) {
  const url = msg.url;
  fetch(url, {
    credentials: 'include',
    referrerPolicy: 'no-referrer-when-downgrade',
    headers: { 'Accept': '*/*' }
  }).then((resp) => {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.text();
  }).then((text) => {
    const parsed = parseM3u8(text, url);
    sendResponse({
      ok: true,
      parsed: {
        playlists: parsed.playlists,
        segments: parsed.segments,
        keys: parsed.keys,
        map: parsed.map,
        mediaType: parsed.mediaType,
        totalSegments: parsed.segments.length
      }
    });
  }).catch((err) => {
    sendResponse({ ok: false, error: 'parse_failed', message: String(err && err.message || err) });
  });
}

// ---------- MPD 解析处理 ----------
function handleParseMpd(msg, sendResponse) {
  const url = msg.url;
  fetch(url, {
    credentials: 'include',
    headers: { 'Accept': '*/*' }
  }).then((resp) => {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.text();
  }).then((text) => {
    const parsed = parseMpd(text, url);
    sendResponse({
      ok: true,
      parsed: {
        representations: parsed.representations,
        segments: parsed.segments,
        totalRepresentations: parsed.representations.length
      }
    });
  }).catch((err) => {
    sendResponse({ ok: false, error: 'parse_failed', message: String(err && err.message || err) });
  });
}
