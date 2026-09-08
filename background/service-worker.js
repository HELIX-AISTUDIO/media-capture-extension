/**
 * ============================================================
 * background/service-worker.js
 * 后台 Service Worker（Manifest V3）
 * ------------------------------------------------------------
 * 功能：
 *   1. chrome.webRequest 非阻塞观察网络请求（onBeforeRequest + onCompleted）
 *   2. 资源数据持久化到 chrome.storage.session（解决 SW 休眠丢数据）
 *   3. 严格媒体过滤：追踪/日志接口、垃圾图片、水印片段
 *   4. 按 DASH 音/视轨关键字正确分类；按 size 推测 B 站 m4s 音频流
 *   5. m3u8 / MPD 解析（调用 m3u8-parser.js / mpd-parser.js）
 *   6. 消息路由：取列表 / 清空 / 下载 / 批量复制 / DOM上报 / 解析
 *
 * MV3 关键决策（务必遵守）：
 *   - 仅用「非阻塞」webRequest 观察，绝不使用已废弃的 blocking。
 *   - declarativeNetRequest 只能 block/redirect，无法"读取 URL 到扩展
 *     逻辑"，因此"收集资源列表"场景必须用 webRequest，这是 MV3 下
 *     唯一合规路径（详见 references/principles.md）。
 *   - storage.session 跨 SW 休眠存活（浏览器会话期间），解决数据丢失。
 * ============================================================
 */

importScripts('media-parser.js', 'm3u8-parser.js', 'mpd-parser.js');

// 内存存储：tabId -> Map<url, resource>
// 同时镜像到 chrome.storage.session，SW 休眠重启后可从 storage 恢复。
const store = new Map();

// 持久化键前缀
const STORE_KEY_PREFIX = 'mediaStore::';

// 是否已完成从 storage.session 的初始化恢复
let restored = false;

// 写存储的节流（debounce），避免高频 IO
const persistTimers = new Map();

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
    for (const key of Object.keys(items)) {
      if (!key.startsWith(STORE_KEY_PREFIX)) continue;
      const tabId = parseInt(key.slice(STORE_KEY_PREFIX.length), 10);
      if (isNaN(tabId)) continue;
      const obj = items[key];
      const map = new Map();
      for (const url of Object.keys(obj)) map.set(url, obj[url]);
      store.set(tabId, map);
    }
  });
}
restoreFromStorage();

// ---------- 存储资源 ----------
function storeResource(tabId, resource) {
  if (!tabId || tabId < 0) return;
  if (!store.has(tabId)) store.set(tabId, new Map());
  const map = store.get(tabId);

  // 限制每 tab 资源数，防止内存泄漏/CPU 占用（参考猫抓 2.5.9）
  if (map.size >= MAX_RESOURCES_PER_TAB) return;

  const existing = map.get(resource.url);
  if (existing) {
    // 合并：DOM 来源优先；取更大 size；补全缺失字段
    if (existing.source === 'network' && resource.source !== 'network') {
      existing.source = resource.source;
    }
    if (resource.size && (!existing.size || resource.size > existing.size)) {
      existing.size = resource.size;
    }
    if (!existing.mime && resource.mime) existing.mime = resource.mime;
    if (resource.width && !existing.width) existing.width = resource.width;
    if (resource.height && !existing.height) existing.height = resource.height;
    if (resource.posterUrl && !existing.posterUrl) existing.posterUrl = resource.posterUrl;
    // 时间戳取最新
    if (resource.ts && (!existing.ts || resource.ts > existing.ts)) existing.ts = resource.ts;
  } else {
    map.set(resource.url, resource);
  }
  updateBadge(tabId);
  schedulePersist(tabId);
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
function getContentRangeTotal(headers) {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'content-range') {
      const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(h.value || '');
      if (m && m[1]) {
        const n = parseInt(m[1], 10);
        return isNaN(n) ? null : n;
      }
    }
  }
  return null;
}

function getContentLength(headers) {
  if (!headers) return null;
  const rangeTotal = getContentRangeTotal(headers);
  if (rangeTotal != null) return rangeTotal;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'content-length') {
      const n = parseInt(h.value, 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

function getContentType(headers) {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'content-type') {
      return (h.value || '').split(';')[0].trim();
    }
  }
  return null;
}

// ---------- 监听请求开始 ----------
chrome.webRequest.onBeforeRequest.addListener((details) => {
  const { tabId, url } = details;
  if (isTrackingUrl(url)) return;
  if (isMediaUrl(url)) {
    storeResource(tabId, {
      url,
      type: classify(url, null),
      mime: null,
      size: null,
      filename: filenameFromUrl(url),
      source: 'network',
      ts: Date.now()
    });
  }
}, { urls: ['<all_urls>'] });

// ---------- 监听响应完成：补全 MIME/大小 + 过滤垃圾 ----------
chrome.webRequest.onCompleted.addListener((details) => {
  const { tabId, url, responseHeaders } = details;
  if (isTrackingUrl(url)) return;
  const mime = getContentType(responseHeaders);
  const size = getContentLength(responseHeaders);
  const type = classify(url, mime);

  // 过滤 .flv 直播流（RTMP-flv 不可下载）
  if (/\.flv(\?|#|$)/i.test(url)) return;

  // 图片垃圾过滤
  if (type === 'image' && isJunkImage(url, size)) return;

  // 视频：过滤过小片段与水印域
  if (type === 'video') {
    if (size != null && size < MIN_VIDEO_SIZE) return;
    if (VIDEO_FRAGMENT_HOST.test(url)) return;
  }
  // 音频：过滤过小片段
  if (type === 'audio' && size != null && size < MIN_AUDIO_SIZE) return;

  if (isMediaUrl(url) || isMediaMime(mime)) {
    storeResource(tabId, {
      url,
      type,
      mime,
      size,
      filename: filenameFromUrl(url),
      source: 'network',
      ts: Date.now()
    });
  }
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// ---------- 标签页关闭时清理 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  store.delete(tabId);
  chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
});

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case 'getResources': {
      const tabId = msg.tabId ?? sender.tab?.id;
      let list = Array.from(store.get(tabId)?.values() || []);
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
      store.delete(tabId);
      chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
      if (tabId >= 0) chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError);
      sendResponse({ ok: true });
      break;
    }

    case 'download': {
      // MV3 安全约束：扩展不能通过 chrome.downloads.download({headers:[...]})
      // 注入 Referer 等 unsafe 头（会抛 "Unsafe request header name"）。
      // 文件名先经 safeFilename 清洗，修复超长/非法字符导致下载失败。
      chrome.downloads.download({
        url: msg.url,
        filename: safeFilename(msg.filename),
        saveAs: true
      }, (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'download_failed', message: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: id !== undefined, downloadId: id });
      });
      return true;
    }

    case 'addDomResources': {
      const tabId = msg.tabId ?? sender.tab?.id;
      (msg.items || []).forEach((it) => {
        if (!it || !it.url) return;
        // DOM 图片尺寸过滤
        if (it.width != null && it.height != null) {
          if (it.width < 120 && it.height < 120) return;
        }
        // DOM 图片平台黑名单
        if (it.width != null || /\.(png|jpe?g|gif|webp|bmp|avif)/i.test(it.url)) {
          try {
            const host = new URL(it.url).hostname;
            if (IMG_HOST_BLOCKLIST.test(host)) return;
          } catch { /* ignore */ }
        }
        storeResource(tabId, {
          url: it.url,
          type: classify(it.url, null),
          mime: null,
          size: it.size || null,
          filename: filenameFromUrl(it.url),
          source: it.source || 'dom',
          width: it.width || null,
          height: it.height || null,
          posterUrl: it.posterUrl || null,
          ts: it.ts || Date.now()
        });
      });
      sendResponse({ ok: true });
      break;
    }

    case 'parseM3u8': {
      // 解析 m3u8：fetch 内容 → parseM3u8 → 返回分片/嵌套列表
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
  const pageUrl = msg.pageUrl || '';
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
