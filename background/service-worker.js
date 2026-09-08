/**
 * ============================================================
 * background/service-worker.js
 * 后台 Service Worker（Manifest V3）
 * ------------------------------------------------------------
 * 功能：
 *   1. chrome.webRequest 非阻塞观察网络请求
 *      （onBeforeRequest + onSendHeaders + onCompleted + onErrorOccurred）
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
 *
 * SW 生命周期健壮性（参考猫抓对抗 MV3 休眠的策略，独立实现）：
 *   a. 接受 SW 必死：关键数据落 storage.session，唤醒后 restoreFromStorage 自愈；
 *   b. chrome.alarms 定时唤醒（重注册监听器 + 孤儿 tab 回收）；
 *   c. webNavigation 空监听作为导航事件唤醒源；
 *   d. onConnect 长连接在 popup 打开期间保持 SW 活跃。
 * ============================================================
 */

importScripts('media-parser.js', 'm3u8-parser.js', 'mpd-parser.js');

// ---------- 安全 listener 注册 helper ----------
// v0.2.2 修复：所有新加的 chrome API 调用用 try/catch 包装，
// 防止单个 API 在某些 Edge/Chrome 版本不可用时导致整个 SW 注册失败（Status 15）。
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

// 是否已完成从 storage.session 的初始化恢复
let restored = false;

// 抓取模式：'default'（过滤垃圾资源） / 'deep'（全部抓取）
// 由 popup 通过 setMode 消息更新，并持久化到 chrome.storage.local。
let currentCaptureMode = 'default';

// 写存储的节流（debounce），避免高频 IO
const persistTimers = new Map();

// requestId -> referer（onSendHeaders 暂存，onCompleted 消费后删除）
const requestReferer = new Map();

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
// 参考猫抓用 alarms 定时调度的思想，这里用作 SW 心跳：
// alarm 触发本身会唤醒 SW，从而重新注册 webRequest 监听器，
// 并顺便回收孤儿 tab。periodInMinutes 5 分钟权衡了唤醒频率与开销。
try {
  chrome.alarms.create('media-heartbeat', { periodInMinutes: 5 });
} catch (e) { console.warn('[SW] alarms.create unavailable:', String(e && e.message || e)); }
safeOn(chrome.alarms, 'onAlarm', (alarm) => {
  if (alarm.name === 'media-heartbeat') sweepOrphanTabs();
});

// ---------- SW 生命周期：webNavigation 作为唤醒源 + 导航清理 ----------
// onBeforeNavigate / onCommitted 本身就是 MV3 的 SW 唤醒事件。
// 主框架（frameId === 0）导航提交时清空该 tab 的抓取数据，
// 解决"页面刷新 / 跳转后数据残留错乱"问题（参考猫抓 autoClear 思想）。
safeOn(chrome.webNavigation, 'onCommitted', (details) => {
  if (details.frameId === 0) clearTabData(details.tabId);
});

// ---------- SW 生命周期：onConnect 长连接保活 ----------
// popup 打开期间保持 SW 活跃，避免长驻弹窗时 SW 被回收。
safeOn(chrome.runtime, 'onConnect', (port) => {
  if (port.name !== 'media-heartbeat') return;
  const keepAlive = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); }
    catch (e) { clearInterval(keepAlive); }
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(keepAlive));
});

// ---------- 孤儿 tab 回收 ----------
// 用 tabs.query 快照删除已关闭 tab 的残留数据（参考猫抓 clearRedundant 思想）
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
  chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
  chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError);
}

// ---------- 存储资源 ----------
function storeResource(tabId, resource) {
  if (!tabId || tabId < 0) return;
  if (!store.has(tabId)) store.set(tabId, new Map());
  const map = store.get(tabId);

  // 限制每 tab 资源数，防止内存泄漏/CPU 占用（参考猫抓 2.5.9）
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
    // 时间戳取最新
    if (resource.ts && (!existing.ts || resource.ts > existing.ts)) existing.ts = resource.ts;
  } else {
    map.set(key, resource);
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

// ---------- 网络层图片接受判断（按抓取模式集中控制） ----------
// default 模式：过滤垃圾图片（关键词/平台黑名单/尺寸阈值/svg/ico）
// deep 模式：不过滤，全部接受（仍保留 isTrackingUrl 追踪过滤）
function shouldAcceptNetworkImage(url, size, mode) {
  if (mode === 'deep') return true;
  return !isJunkImage(url, size);
}

// ---------- 监听请求开始 ----------
safeOn(chrome.webRequest, 'onBeforeRequest', (details) => {
  const { tabId, url } = details;
  if (tabId < 0) return; // 后台请求无归属 tab，忽略
  if (isTrackingUrl(url)) return;
  if (isMediaUrl(url)) {
    const type = classify(url, null);
    // 图片统一放到 onCompleted 处理：等拿到 size 后由
    // shouldAcceptNetworkImage 决定是否存储（default 模式过滤垃圾图）。
    // 否则 onBeforeRequest 无条件存储会让 default 模式漏出小 logo/icon。
    if (type === 'image') return;
    storeResource(tabId, {
      url,
      type,
      mime: null,
      size: null,
      filename: filenameFromUrl(url),
      source: 'network',
      ts: Date.now()
    });
  }
}, { urls: ['<all_urls>'] });

// ---------- 监听请求头：暂存 referer（用于防盗链识别） ----------
safeOn(chrome.webRequest, 'onSendHeaders', (details) => {
  if (details.tabId < 0) return;
  const referer = getHeaderValue(details.requestHeaders, 'referer');
  if (referer) requestReferer.set(details.requestId, referer);
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

// ---------- 监听响应完成：补全 MIME/大小 + 过滤垃圾 ----------
safeOn(chrome.webRequest, 'onCompleted', (details) => {
  const { tabId, url, responseHeaders, type: resourceType } = details;
  if (tabId < 0) return;
  if (isTrackingUrl(url)) return;

  // 消费 referer（用完即删，防内存泄漏）
  const referer = requestReferer.get(details.requestId);
  requestReferer.delete(details.requestId);

  const mime = getContentType(responseHeaders);
  const size = getContentLength(responseHeaders);
  let type = classify(url, mime);

  // resourceType 兜底：webRequest 判定为 media/video/audio 的资源，
  // 即使 URL 无媒体扩展名、mime 也不明确，也视为媒体（参考猫抓三路判定）
  if (type === 'media' && (resourceType === 'media' || resourceType === 'video' || resourceType === 'audio')) {
    type = resourceType === 'audio' ? 'audio' : 'video';
  }

  // 过滤 .flv 直播流（RTMP-flv 不可下载）
  if (/\.flv(\?|#|$)/i.test(url)) return;

  // 图片垃圾过滤（deep 模式完全跳过）
  if (type === 'image' && !shouldAcceptNetworkImage(url, size, currentCaptureMode)) return;

  // 视频/音频片段过滤（deep 模式完全跳过）
  if (currentCaptureMode === 'default') {
    if (type === 'video') {
      if (size != null && size < MIN_VIDEO_SIZE) return;
      if (VIDEO_FRAGMENT_HOST.test(url)) return;
    }
    if (type === 'audio' && size != null && size < MIN_AUDIO_SIZE) return;
  }

  if (isMediaUrl(url) || isMediaMime(mime) || resourceType === 'media' || resourceType === 'video' || resourceType === 'audio') {
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
  }
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// ---------- 监听请求失败：清理 referer 暂存 ----------
safeOn(chrome.webRequest, 'onErrorOccurred', (details) => {
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
        // DOM 图片过滤仅在默认模式启用（deep 模式全部接受）
        if (currentCaptureMode === 'default') {
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
          referer: it.referer || null,
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
