/**
 * ============================================================
 * js/background.js
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

// 恢复回调是否真的跑完（区别于 restored：restored 是同步置位表示「已发起」，
// 本标志表示「store 已回填完毕」）。用途：restoreFromStorage 与
// refreshActiveTabId 是两条独立异步 IPC，完成顺序无保证；若 tabs.query
// 先返回、store 还没回填，补刷徽章会读到 count=0 而写成空串，且恢复完成后
// 不会自愈（要等下一条新资源）。因此补刷前必须先看这个标志。
let restoreFinished = false;

// 抓取模式：'default'（干净过滤） / 'deep'（全部抓取）
let currentCaptureMode = 'default';

// 写存储的节流（debounce），避免高频 IO
const persistTimers = new Map();

// requestId -> referer（onSendHeaders 暂存，onResponseStarted 消费后删除）
const requestReferer = new Map();

// requestId -> { headerName: value }（白名单鉴权头：referer/cookie/origin/authorization/x-* 等）
// 与 requestReferer 的区别：requestReferer 只存 referer 字符串（防盗链主链路），
// 这里存完整白名单对象，供「复制为 curl」、DNR 多头注入、viewer fetch 直传使用。
const requestAuthHeaders = new Map();

// tabId -> 页面代数（每次导航/SPA 切换 +1，用于拦截旧页面的延迟返回请求）
const pageEpoch = new Map();

// requestId -> 请求发起时的页面代数（onBeforeRequest 记录，onResponseStarted 校验）
const requestGen = new Map();

// 当前活跃 tabId 缓存：由 onActivated / onRemoved / onFocusChanged 维护。
// 为什么需要：updateBadge 原本每次都 chrome.tabs.query 一次（IPC），而
// storeResource 每入库一条就调用一次 → 抓 300 条 = 300 次 tabs.query。
// 缓存后免掉这轮 IPC，只在 tab 切换/关闭时刷新一次。
let activeTabId = null;

// 徽章更新节流定时器（合并高频调用，100ms 内只写一次）
let badgeTimer = null;
let badgePendingTabId = null;

// ---------- storage.session 持久化 ----------
function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    persistTab(tabId);
  }, 500));
}

// 持久化字段白名单：只落盘核心字段，丢弃 posterUrl / mime / width / height 等
// 仅用于 UI 展示（缩略图、尺寸标签、meta 文案）的大体积字段。
// 为什么必须瘦身：chrome.storage.session 有配额（Chromium 约 10MB），
// 多 tab 并发（20 tab × 500 条）时有触顶风险，一旦触顶 storage.session.set
// 会静默失败导致数据整体丢失；posterUrl 通常是长 URL，是体积大头，必须丢掉。
// 恢复后这些字段缺失只影响展示，不影响「嗅探 / 下载 / 预览」核心链路。
// mime 保留在白名单内：viewer.js 用它推导 blobType，对无扩展名 URL
// （如 https://cdn/videoplayback?id=xxx）缺失 mime 会退化成
// application/octet-stream，触发另存时扩展名被改成 .txt/.htm 的历史问题。
// mime 仅 10~30 字节，不是体积大头（大头是 posterUrl），瘦身收益基本不变。
const PERSIST_FIELDS = ['url', 'type', 'size', 'filename', 'referer', 'ts', 'source', 'mime', 'requestHeaders'];

// 单 tab 持久化条数上限：内存上限仍是 MAX_RESOURCES_PER_TAB(500)，
// 但落盘只保留最新的 200 条（按 ts 倒序），兼顾配额与恢复体验。
const PERSIST_MAX_PER_TAB = 200;

// 鉴权头落盘体积护栏：cookie 可能非常长，序列化后超过该长度则只保留 referer，
// 避免单条超长 cookie 把 storage.session 撑爆（触顶会静默失败导致整 tab 数据丢失）。
const PERSIST_HEADERS_MAX_CHARS = 4000;

function persistTab(tabId) {
  const map = store.get(tabId);
  if (!map) {
    chrome.storage.session.remove(STORE_KEY_PREFIX + tabId, () => void chrome.runtime.lastError);
    return;
  }
  // 超出上限时只保留最新的 PERSIST_MAX_PER_TAB 条（按 ts 倒序裁剪）
  let entries = Array.from(map.entries());
  if (entries.length > PERSIST_MAX_PER_TAB) {
    entries = entries
      .sort((a, b) => ((b[1] && b[1].ts) || 0) - ((a[1] && a[1].ts) || 0))
      .slice(0, PERSIST_MAX_PER_TAB);
  }
  // 序列化为普通对象（Map → Object），并逐条裁剪字段
  const obj = {};
  for (const [key, r] of entries) {
    const slim = {};
    for (const field of PERSIST_FIELDS) {
      if (r && r[field] !== undefined) slim[field] = r[field];
    }
    // 鉴权头体积护栏：超长（主要因 cookie）则只保留 referer，其余丢弃并告警
    if (slim.requestHeaders) {
      try {
        if (JSON.stringify(slim.requestHeaders).length > PERSIST_HEADERS_MAX_CHARS) {
          slim.requestHeaders = slim.requestHeaders.referer
            ? { referer: slim.requestHeaders.referer }
            : undefined;
          if (slim.requestHeaders === undefined) delete slim.requestHeaders;
          console.warn('[SW] persistTab 丢弃超长鉴权头，仅保留 referer：',
            'tabId=' + tabId, String(key).slice(0, 80));
        }
      } catch (e) { delete slim.requestHeaders; }
    }
    obj[key] = slim;
  }
  chrome.storage.session.set({ [STORE_KEY_PREFIX + tabId]: obj }, () => {
    // 落盘失败（最常见是配额触顶）必须告警，否则数据会静默丢失无从排查
    if (chrome.runtime.lastError) {
      console.warn('[SW] persistTab 落盘失败（可能 storage.session 配额不足）:',
        'tabId=' + tabId, chrome.runtime.lastError.message);
    }
  });
}

// 恢复收尾：标记「已回填」，并对当前活跃 tab 补刷一次徽章。
// 两个分支（版本不匹配作废 / 正常恢复）都必须调用，否则标志会永远卡在 false。
function finishRestore() {
  restoreFinished = true;
  if (activeTabId != null) updateBadge(activeTabId);
}

// 从 storage.session 恢复全部数据（SW 启动时调用一次）
function restoreFromStorage() {
  if (restored) return;
  restored = true;
  chrome.storage.session.get(null, (items) => {
    // 读取失败也是一条「恢复结束」路径：必须同样调用 finishRestore()，
    // 否则 restoreFinished 会永远停在 false，把 refreshActiveTabId 的
    // 徽章补刷永久门控住（等价于冷启动后徽章再也不刷新）。
    if (chrome.runtime.lastError || !items) { finishRestore(); return; }
    // 版本不匹配（首次升级 / 旧版本残留）→ 作废全部旧抓取数据
    if (items.storeVersion !== STORE_VERSION) {
      const stale = Object.keys(items).filter((k) => k.startsWith(STORE_KEY_PREFIX));
      chrome.storage.session.remove(stale, () => void chrome.runtime.lastError);
      chrome.storage.session.set({ storeVersion: STORE_VERSION }, () => void chrome.runtime.lastError);
      sweepOrphanTabs();
      finishRestore();   // 数据已作废（store 为空），同样要解锁徽章补刷
      return;
    }
    for (const key of Object.keys(items)) {
      if (!key.startsWith(STORE_KEY_PREFIX)) continue;
      const tabId = parseInt(key.slice(STORE_KEY_PREFIX.length), 10);
      if (isNaN(tabId)) continue;
      const obj = items[key];
      const map = new Map();
      for (const url of Object.keys(obj)) map.set(url, obj[url]);
      // 为什么必须「合并」而不是「覆盖」：
      // restored 是同步置位的，但 storage.session.get 是异步回调。SW 冷启动
      // 的这段空窗期内 webRequest 可能已经抓到新资源并写进内存 store；
      // 若此处直接 store.set(tabId, map)，就会用旧快照把冷启动期间新抓的
      // 资源整体替换掉（数据丢失）。因此以内存数据为准，快照只补齐缺失 key。
      const existing = store.get(tabId);
      if (existing && existing.size > 0) {
        for (const [url, r] of map) {
          if (!existing.has(url)) existing.set(url, r);
        }
      } else {
        store.set(tabId, map);
      }
    }
    // 恢复后回收孤儿 tab（已关闭的 tab 残留数据）
    sweepOrphanTabs();
    finishRestore();   // store 回填完毕，此时补刷徽章才能读到正确数量
  });
}
try { restoreFromStorage(); } catch (e) { console.warn('[SW] restoreFromStorage failed:', String(e && e.message || e)); }

// ---------- 用户规则加载（Ext / Type / Regex / blockUrl 四表） ----------
// 规则存 storage.sync（跨设备同步）。未配置时保持「空表」语义，
// 空表 = 与历史行为完全一致（不会误伤/误删任何资源），这是本设计的核心安全承诺。
// 冷启动加载完成前规则为空表，等价于「用户未配置」，因此不存在竞态风险。
function loadUserRules() {
  try {
    chrome.storage.sync.get('userRules', (result) => {
      if (chrome.runtime.lastError) return;
      const r = result && result.userRules;
      if (r) setUserRules(r);
    });
  } catch (e) { console.warn('[SW] loadUserRules failed:', String(e && e.message || e)); }
}
try { loadUserRules(); } catch (e) { /* ignore */ }

// ---------- 下载偏好：是否弹出「另存为」对话框 ----------
// 默认 false = 直接下载到浏览器默认目录（参考猫抓 saveAs:false）。
// 旧行为是硬编码 true，每次下载都弹系统对话框，批量场景体验很差。
let downloadSaveAs = false;
try {
  chrome.storage.local.get('downloadSaveAs', (r) => {
    if (!chrome.runtime.lastError && r && r.downloadSaveAs === true) downloadSaveAs = true;
  });
} catch (e) { /* ignore */ }

// ---------- 下载文件名模板（P2-1）与 aria2 RPC 配置（P2-7） ----------
// 模板支持变量：${title} 页面标题 / ${ext} 扩展名 / ${date} 日期 / ${time} 时间
//               ${fileName} 原文件名（无扩展名）/ ${host} 域名 / ${type} 资源类型
// 模板里可写子目录（如 ${title}/${fileName}），逐段清洗后保留目录结构。
// 未配置模板 = 保持原文件名（与历史行为完全一致，升级零影响）。
let fileNameTemplate = '';
let aria2Rpc = '';

// 规则/偏好热更新：options 页保存后立即生效，无需重载扩展
safeOn(chrome.storage, 'onChanged', (changes, area) => {
  if (area === 'sync' && changes.userRules) {
    setUserRules(changes.userRules.newValue);
    console.log('[SW] 用户规则已热更新');
    return;
  }
  if (area === 'local') {
    if (changes.downloadSaveAs) downloadSaveAs = changes.downloadSaveAs.newValue === true;
    if (changes.fileNameTemplate && typeof changes.fileNameTemplate.newValue === 'string') {
      fileNameTemplate = changes.fileNameTemplate.newValue;
    }
    if (changes.aria2Rpc) {
      aria2Rpc = String(changes.aria2Rpc.newValue || '');
    }
  }
});

try {
  chrome.storage.local.get(['fileNameTemplate', 'aria2Rpc'], (r) => {
    if (chrome.runtime.lastError || !r) return;
    if (typeof r.fileNameTemplate === 'string') fileNameTemplate = r.fileNameTemplate;
    if (typeof r.aria2Rpc === 'string') aria2Rpc = r.aria2Rpc;
  });
} catch (e) { /* ignore */ }

function applyFileNameTemplate(tpl, info) {
  if (!tpl) return null;
  const fileName = String((info && info.filename) || '');
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = (() => {
    if (dot > 0 && fileName.length - dot <= 16) return fileName.slice(dot + 1);
    try {
      const m = /\.([a-z0-9]{2,5})(\?|#|$)/i.exec(new URL(String((info && info.url) || '')).pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (e) { return ''; }
  })();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let host = '';
  try { host = new URL(String((info && info.url) || '')).hostname; } catch (e) { /* ignore */ }
  const vars = {
    title: String((info && info.title) || ''),
    ext: ext,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    fileName: base,
    host: host,
    type: String((info && info.type) || '')
  };
  const raw = String(tpl).replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  // 逐段清洗但保留 / 目录分隔符（safeFilename 会干掉 /，所以必须分段处理）
  const parts = raw.split('/').map((s) => s.trim()).filter(Boolean).map((s) => safeFilename(s));
  if (parts.length === 0) return null;
  // 安全网：模板结果最后一段若没有扩展名，自动补上原扩展名。
  // 避免用户只写 ${fileName}（该变量按设计不含扩展名）时下载出「无扩展名」的废文件。
  const last = parts[parts.length - 1];
  if (ext && last.lastIndexOf('.') <= 0) {
    parts[parts.length - 1] = last + '.' + ext;
  }
  return parts.join('/');
}

// ---------- 抓取开关（暂停/恢复） ----------
// 供快捷键 / 右键菜单控制：暂停时不再往列表里写入新资源（已有列表保留）。
let captureEnabled = true;
try {
  chrome.storage.local.get('captureEnabled', (r) => {
    if (!chrome.runtime.lastError && r && r.captureEnabled === false) captureEnabled = false;
  });
} catch (e) { /* ignore */ }

function setCaptureEnabled(v) {
  captureEnabled = v !== false;
  try { chrome.storage.local.set({ captureEnabled }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
}

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
  // 修复「二次导航起代数拦截失效」：
  // 原实现是 clearTabData() + bumpEpoch()，但 clearTabData 内部会
  // pageEpoch.delete()，导致 bumpEpoch 每次都从 0 起算 → 代数恒为 1，
  // 第 2 次导航起旧页面残留请求的 gen 与新页面相等，校验形同虚设。
  // 因此这里先算出「递增后的代数」，清理完再写回，保证代数单调递增：
  // 1 → 2 → 3 …，旧页面的残留请求（gen 更小）会被正确拦截。
  if (tabId == null || tabId < 0) return;   // 守卫：非法 tabId 不写代数，避免脏键
  const nextGen = (pageEpoch.get(tabId) || 0) + 1;
  clearTabData(tabId);           // 清数据（它内部仍会 delete pageEpoch，语义不变）
  pageEpoch.set(tabId, nextGen); // 写回已递增的代数，保证单调递增
  // 页面上下文已重置：MAIN world 注入标记随之作废；若当前是深度模式则重新注入
  injectedTabs.delete(tabId);
  injectDeepSearch(tabId);
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
    if (!existing.requestHeaders && resource.requestHeaders) existing.requestHeaders = resource.requestHeaders;
    if (!existing.cookie && resource.cookie) existing.cookie = resource.cookie;
    if (resource.width && !existing.width) existing.width = resource.width;
    if (resource.height && !existing.height) existing.height = resource.height;
    if (resource.posterUrl && !existing.posterUrl) existing.posterUrl = resource.posterUrl;
    if (resource.ts && (!existing.ts || resource.ts > existing.ts)) existing.ts = resource.ts;
  } else {
    map.set(key, resource);
    // 按 tab 自动下载：只对「新抓到的」资源入队（合并的旧资源不重复下载）
    enqueueAutoDown(tabId, resource);
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

// 刷新活跃 tab 缓存（仅一次 tabs.query，在 tab 切换/关闭/窗口切换时调用）
function refreshActiveTabId() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const next = (tabs && tabs[0] && tabs[0].id != null) ? tabs[0].id : null;
      // 补刷一次徽章：SW 冷启动时资源可能先于本回调入库（此时 activeTabId
      // 仍为 null 而被 updateBadge 跳过），这里从「未知」变为「有效」时
      // 补一次，避免首屏徽章停在旧值/不显示。
      const wasUnknown = (activeTabId == null);
      activeTabId = next;
      // 只有 store 回填完毕才补刷：否则会读到 count=0 把徽章写成空串，
      // 且不会自愈；restore 晚到时会由 finishRestore() 负责补刷。
      if (wasUnknown && next != null && restoreFinished) updateBadge(next);
    });
  } catch (e) { /* tabs API 不可用时保持原值，不影响抓取主流程 */ }
}

function updateBadge(tabId) {
  // 非活跃 tab 不更新徽章（与原逻辑一致：只为当前聚焦的 tab 写徽章），
  // 且这里直接读缓存，不再每条资源都发起一次 tabs.query IPC。
  if (tabId == null || tabId !== activeTabId) return;
  // 节流：100ms 内的连续调用合并成最后一次，避免抓取高峰疯狂写徽章
  badgePendingTabId = tabId;
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    const target = badgePendingTabId;
    badgePendingTabId = null;
    if (target == null || target !== activeTabId) return;
    const count = store.get(target)?.size || 0;
    chrome.action.setBadgeText({ tabId: target, text: count > 0 ? String(count) : '' }, () => void chrome.runtime.lastError);
    chrome.action.setBadgeBackgroundColor({ tabId: target, color: '#2563eb' }, () => void chrome.runtime.lastError);
  }, 100);
}

// ---------- 活跃 tab 维护（只影响徽章刷新，不参与任何过滤/抓取逻辑） ----------
safeOn(chrome.tabs, 'onActivated', (info) => {
  activeTabId = (info && info.tabId != null) ? info.tabId : null;
  // 深度模式下切到某 tab：补注入 MAIN world 深搜脚本（P1-6）
  if (activeTabId != null) injectDeepSearch(activeTabId);
});
safeOn(chrome.tabs, 'onRemoved', () => {
  // 关闭的可能是活跃 tab，重新查一次当前活跃 tab（异步，与 clearTabData 无顺序依赖）
  refreshActiveTabId();
});
safeOn(chrome.windows, 'onFocusChanged', (windowId) => {
  // windowId < 0 表示无聚焦窗口，此时无活跃 tab
  if (windowId != null && windowId < 0) { activeTabId = null; return; }
  refreshActiveTabId();
});
// SW 冷启动时初始化一次活跃 tab，避免首屏抓取期间徽章不刷新
refreshActiveTabId();

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
// DNR 会话规则 id 范围：1 是历史固定 id（已废弃，见下），改为按 URL 稳定生成。
// 为什么不能用固定 id：预览/下载并发时，多个资源共用 id=1 会互相 removeRuleIds 覆盖，
// 导致先打开的预览规则被后一个资源冲掉 → 防盗链 CDN 又 403。
// 改为按 URL hash 生成稳定 id（同一资源复用同一 id，不同资源互不干扰）。
const DNR_RULE_ID_MIN = 2;
const DNR_RULE_ID_MAX = 30000;

// 当前活跃的 DNR 规则 id 集合（并发预览/下载各自独立，清理时统一移除）
const activeRuleIds = new Set();

// 按资源 URL 生成稳定规则 id（简单字符串 hash，映射到 [2, 30000]）
function ruleIdForUrl(url) {
  let h = 0;
  const s = String(url || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) & 0x7fffffff;
  }
  return DNR_RULE_ID_MIN + (h % (DNR_RULE_ID_MAX - DNR_RULE_ID_MIN + 1));
}

// 浏览器禁止通过 fetch/XHR 显式设置的 forbidden 头，只能走 DNR 注入。
// 注意 header 名用规范大小写（Chromium DNR 大小写不敏感，但保持与历史 Referer 一致）。
const DNR_FORBIDDEN_HEADERS = [
  { key: 'referer', header: 'Referer' },
  { key: 'cookie', header: 'Cookie' },
  { key: 'origin', header: 'Origin' }
];

// 取近似主域（eTLD+1 的朴素实现，够用于排除原页面流量）
function rootDomainOf(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function setPreviewRefererRule(url, headers) {
  // headers 可为 {referer, cookie, origin, ...} 对象；也兼容旧的字符串 referer 调用
  const h = (typeof headers === 'string') ? { referer: headers } : (headers || {});
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
      // 只注入 forbidden 头（referer/cookie/origin）；authorization/x-* 等
      // 非 forbidden 头由 viewer 的 fetch 直接携带，不必走 DNR（fetch 可设）。
      const requestHeaders = [];
      for (const item of DNR_FORBIDDEN_HEADERS) {
        if (h[item.key]) requestHeaders.push({ header: item.header, operation: 'set', value: h[item.key] });
      }
      if (requestHeaders.length === 0) { resolve(false); return; }
      const ruleId = ruleIdForUrl(url);
      activeRuleIds.add(ruleId);
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders
          },
          condition: {
            requestDomains: [root],
            resourceTypes: ['media', 'xmlhttprequest', 'other']
          }
        }]
      }, () => {
        if (chrome.runtime.lastError) {
          activeRuleIds.delete(ruleId);
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
    if (activeRuleIds.size === 0) return;
    const ids = Array.from(activeRuleIds);
    activeRuleIds.clear();
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// ---------- 下载期间的生命周期管理 + 失败自动回退 ----------
// 1) 下载期间注入 Referer/鉴权头规则，全部结束（完成/中断）后移除。
// 2) 下载失败（CDN 拒绝类错误）时自动改走 viewer 的 Blob 通道重试一次
//    （参考猫抓 errorList → 自带下载器的回退链；Blob 通道带完整鉴权头，成功率更高）。
//    注意：这是「换通道重试」，用的仍是页面自己的凭据，不是绕过防盗链技术措施。
const trackedDownloads = new Map();  // downloadId -> { url, filename, mime, referer, requestHeaders }
let downloadCleanupTimer = null;

// 触发自动回退的下载错误码（参考猫抓 errorList，只挑「CDN/网络拒绝类」）
const RETRY_ERROR_CODES = [
  'SERVER_BAD_CONTENT', 'SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN',
  'SERVER_UNREACHABLE', 'SERVER_CROSS_ORIGIN_REDIRECT', 'SERVER_FAILED',
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED'
];

// 自动回退去重：同一 URL 只自动重试一次，防止反复开 viewer 造成「下载风暴」
const retriedUrls = new Set();
const RETRY_URL_MAX = 50;

// 下载失败 → 用 viewer 的 Blob 通道重试（带完整鉴权头 + Referer 重试链）
function openViewerForRetry(info) {
  try {
    if (!info || !info.url) return;
    if (retriedUrls.has(info.url)) return;
    retriedUrls.add(info.url);
    if (retriedUrls.size > RETRY_URL_MAX) retriedUrls.clear();
    const q = new URLSearchParams({
      src: info.url,
      referer: info.referer || '',
      name: info.filename || '',
      mime: info.mime || ''
    });
    q.set('autodl', '1');
    // 非 forbidden 头（authorization/x-*）经 query 传给 viewer 的 fetch
    const h = info.requestHeaders;
    if (h && typeof h === 'object') {
      const nh = {};
      for (const k of Object.keys(h)) {
        const kl = k.toLowerCase();
        if (kl === 'referer' || kl === 'cookie' || kl === 'origin') continue;
        nh[k] = h[k];
      }
      if (Object.keys(nh).length > 0) q.set('nh', JSON.stringify(nh));
    }
    // active:false 不抢焦点，避免打断用户当前操作
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?' + q.toString(), active: false });
    console.log('[SW] 直连下载失败，已自动改用扩展通道重试:', String(info.url).slice(0, 80));
  } catch (e) {
    console.warn('[SW] openViewerForRetry failed:', String(e && e.message || e));
  }
}

safeOn(chrome.downloads, 'onChanged', (delta) => {
  if (!trackedDownloads.has(delta.id)) return;
  const st = delta.state && delta.state.current;
  if (st === 'complete') {
    trackedDownloads.delete(delta.id);
    if (trackedDownloads.size === 0) clearPreviewRefererRule();
    return;
  }
  if (st === 'interrupted') {
    const info = trackedDownloads.get(delta.id);
    const errCode = (delta.error && delta.error.current) || '';
    trackedDownloads.delete(delta.id);
    if (trackedDownloads.size === 0) clearPreviewRefererRule();
    // 只对「CDN 拒绝类」错误回退；用户主动取消等不回退（避免打扰）
    if (RETRY_ERROR_CODES.indexOf(errCode) >= 0) openViewerForRetry(info);
  }
});

function trackDownloadCleanup(id, info) {
  if (id === undefined || id === null) { clearPreviewRefererRule(); return; }
  trackedDownloads.set(id, info || null);
  // 兜底：3 分钟后无论如何清掉规则，避免长期残留
  clearTimeout(downloadCleanupTimer);
  downloadCleanupTimer = setTimeout(() => {
    if (trackedDownloads.size > 0) {
      trackedDownloads.clear();
      clearPreviewRefererRule();
    }
  }, 180000);
}

// 从 URL 提取分片扩展名（用于批量下载时编号命名，如 001.ts / 002.m4s）
function segmentExtOf(url) {
  try {
    const m = /\.([a-z0-9]{2,5})(\?|#|$)/i.exec(new URL(url).pathname);
    if (m) return '.' + m[1].toLowerCase();
  } catch (e) { /* ignore */ }
  return '.bin';
}

// ---------- 按需补全缺失大小（P2-8） ----------
// 仅在用户主动打开预览时由 popup 触发**一次** HEAD，读取 content-length /
// content-range 得到真实大小；结果做 LRU 缓存防重复请求。
// 🔴 红线：只在 SW 侧按需探测一次——绝不在 content script 内探测，也绝不批量/自动探测。
const sizeProbeCache = new Map();   // url -> size | null
const SIZE_PROBE_CACHE_MAX = 200;
const SIZE_PROBE_TIMEOUT_MS = 3000;

function probeSize(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    if (sizeProbeCache.has(url)) { resolve(sizeProbeCache.get(url)); return; }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sizeProbeCache.set(url, v);
        if (sizeProbeCache.size > SIZE_PROBE_CACHE_MAX) {
          const oldest = sizeProbeCache.keys().next().value;
          sizeProbeCache.delete(oldest);
        }
      } catch (e) { /* ignore */ }
      resolve(v);
    };
    // 超时兜底：3 秒未返回按 null 处理，绝不阻塞 UI
    setTimeout(() => finish(null), SIZE_PROBE_TIMEOUT_MS);
    try {
      fetch(url, { method: 'HEAD', credentials: 'include' })
        .then((resp) => {
          let n = null;
          try {
            const cr = resp.headers.get('content-range');   // 优先（分片场景才是真实总大小）
            const cl = resp.headers.get('content-length');
            if (cr) {
              const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
              if (m) n = parseInt(m[1], 10);
            }
            if (n == null && cl) n = parseInt(cl, 10);
          } catch (e) { /* ignore */ }
          finish((n != null && !isNaN(n) && n > 0) ? n : null);
        })
        .catch(() => finish(null));
    } catch (e) { finish(null); }
  });
}

// ---------- 按 tab 自动下载（P1-4） ----------
// 开关与 tab 绑定，状态存 storage.session（跨 SW 休眠存活）。
// 🔴 三道防失控护栏（分片流场景最容易出事）：
//   a. 串行 + 300ms 间隔入队——瞬间发起上百个下载会把浏览器打崩；
//   b. 单 tab 总量上限 50——误开启后不会无限下载；
//   c. tab 关闭即清空队列 / 计数 / 开关。
const AUTO_DOWN_MAX_PER_TAB = 50;
const AUTO_DOWN_INTERVAL_MS = 300;
let autoDownTabs = new Set();          // 开启自动下载的 tabId 集合
const autoDownQueue = new Map();       // tabId -> 待下载项数组
const autoDownCount = new Map();       // tabId -> 已发起数量
const autoDownPumping = new Set();     // 正在泵的 tabId（防重复泵）

function persistAutoDownTabs() {
  try {
    chrome.storage.session.set({ autoDownTabs: Array.from(autoDownTabs) }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}
try {
  chrome.storage.session.get('autoDownTabs', (r) => {
    if (chrome.runtime.lastError) return;
    if (r && Array.isArray(r.autoDownTabs)) {
      autoDownTabs = new Set(r.autoDownTabs.filter((x) => typeof x === 'number'));
    }
  });
} catch (e) { /* ignore */ }

function clearAutoDownForTab(tabId) {
  autoDownTabs.delete(tabId);
  autoDownQueue.delete(tabId);
  autoDownCount.delete(tabId);
  autoDownPumping.delete(tabId);
}

function setAutoDown(tabId, on) {
  if (tabId == null || tabId < 0) return false;
  if (on) autoDownTabs.add(tabId);
  else clearAutoDownForTab(tabId);
  persistAutoDownTabs();
  return autoDownTabs.has(tabId);
}

function enqueueAutoDown(tabId, resource) {
  if (!autoDownTabs.has(tabId) || !resource || !resource.url) return;
  if ((autoDownCount.get(tabId) || 0) >= AUTO_DOWN_MAX_PER_TAB) return;
  const q = autoDownQueue.get(tabId) || [];
  q.push({
    url: resource.url,
    filename: resource.filename || '',
    mime: resource.mime || '',
    referer: resource.referer || null,
    requestHeaders: resource.requestHeaders || null
  });
  autoDownQueue.set(tabId, q);
  pumpAutoDown(tabId);
}

function pumpAutoDown(tabId) {
  if (autoDownPumping.has(tabId)) return;
  autoDownPumping.add(tabId);
  const step = () => {
    const q = autoDownQueue.get(tabId) || [];
    if (q.length === 0) { autoDownPumping.delete(tabId); return; }
    if ((autoDownCount.get(tabId) || 0) >= AUTO_DOWN_MAX_PER_TAB) {
      q.length = 0;
      autoDownPumping.delete(tabId);
      console.warn('[SW] 自动下载达到单 tab 上限，已停止：tabId=' + tabId + '，上限=' + AUTO_DOWN_MAX_PER_TAB);
      return;
    }
    const item = q.shift();
    autoDownCount.set(tabId, (autoDownCount.get(tabId) || 0) + 1);
    try {
      if (item.requestHeaders || item.referer) {
        setPreviewRefererRule(item.url, item.requestHeaders || { referer: item.referer });
      }
      chrome.downloads.download({
        url: item.url,
        filename: safeFilename(item.filename || ''),
        saveAs: false
      }, (id) => {
        if (chrome.runtime.lastError) return;
        trackDownloadCleanup(id, item);
      });
    } catch (e) { /* ignore */ }
    // 串行间隔：一片下完（发起）再发下一片，避免下载风暴
    setTimeout(step, AUTO_DOWN_INTERVAL_MS);
  };
  step();
}

// ---------- 深度搜索增强：MAIN world 注入（P1-6） ----------
// 只在「深度搜索模式」下注入 js/injected-search.js，钩住 fetch/XHR 从响应体里发现
// 媒体 URL（覆盖「JS 动态拼接的 m3u8」「URL 藏在 JSON 响应里」等静态扫描抓不到的场景）。
// 🔴 只做 URL 发现，不做任何解密 / DRM 处理；注入脚本的钩子只观察、不改写响应。
// 注入标记随页面导航清空（页面上下文已重置，需重新注入）。
const injectedTabs = new Set();

function injectDeepSearch(tabId) {
  if (tabId == null || tabId < 0) return;
  if (currentCaptureMode !== 'deep') return;   // 只有深度模式才注入，避免性能与合规风险
  if (injectedTabs.has(tabId)) return;
  try {
    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return;
    injectedTabs.add(tabId);   // 先标记防并发重复注入；失败时回滚
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      injectImmediately: true,
      files: ['js/injected-search.js']
    }, () => {
      if (chrome.runtime.lastError) {
        injectedTabs.delete(tabId);
        console.warn('[SW] 注入深度搜索脚本失败（页面可能已关闭）：', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    injectedTabs.delete(tabId);
    console.warn('[SW] injectDeepSearch failed:', String(e && e.message || e));
  }
}

function injectDeepSearchActiveTab() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      if (tabs && tabs[0] && tabs[0].id != null) injectDeepSearch(tabs[0].id);
    });
  } catch (e) { /* ignore */ }
}

// ---------- 监听请求开始：记录页面代数 + 过滤追踪 ----------
// requestGen 总量熔断阈值：与 requestReferer 是同一个泄漏模式（每个请求都写，
// 只有 onResponseStarted / onErrorOccurred 才删），必须同样兜底。
const REQUEST_GEN_MAX = 10000;

safeOn(chrome.webRequest, 'onBeforeRequest', (details) => {
  const { tabId } = details;
  if (tabId < 0) return; // 后台请求无归属 tab，忽略
  // 总量熔断：超过阈值直接清空兜底。代价是被清掉的在途请求 reqGen 变
  // undefined，会跳过代数校验（最坏混入少量旧页面资源），但换来 Map 不再
  // 无限增长；正常浏览远达不到 10000，属于纯兜底。
  if (requestGen.size > REQUEST_GEN_MAX) requestGen.clear();
  // 记录该请求发起时的页面代数，供 onResponseStarted 拦截旧页面残留的延迟请求
  requestGen.set(details.requestId, pageEpoch.get(tabId) || 0);
}, { urls: ['<all_urls>'] });

// ---------- 监听请求头：暂存 referer（用于防盗链识别）+ 白名单鉴权头 ----------
// requestReferer 总量熔断阈值（参考猫抓的总量熔断思路）
const REQUEST_REFERER_MAX = 10000;
// 白名单鉴权头（小写）。仅捕获鉴权/来源相关头，不捕获无关头，避免 storage 膨胀与隐私外扩。
// 注意：referer 必须是第一项——它是现有防盗链下载/预览链路的基石，不能被挤掉。
const DIRECT_INCLUDE_HEADERS = ['referer', 'origin', 'cookie', 'authorization', 'auth', 'token', 'key', 'access-token', 'api-key', 'app-token', 'authtoken', 'session-id'];
// x-* 自定义鉴权头：按关键字匹配（如 x-auth-token、x-sign、x-api-key 等）
const X_AUTH_KEYWORD_REG = /(auth|token|sign|key|ticket|session)/i;
// 鉴权头 Map 总量熔断阈值（与 requestReferer 同款泄漏模式，必须同样兜底）
const REQUEST_AUTH_MAX = 10000;

safeOn(chrome.webRequest, 'onSendHeaders', (details) => {
  if (details.tabId < 0) return;

  // 1) referer 单独暂存（防盗链主链路，已有熔断 + 防泄漏）
  const referer = getHeaderValue(details.requestHeaders, 'referer');
  if (referer) {
    if (requestReferer.size > REQUEST_REFERER_MAX) requestReferer.clear();
    requestReferer.set(details.requestId, referer);
  }

  // 2) 白名单鉴权头整体暂存（供 curl 复制 / DNR 多头注入 / viewer 直传）。
  //    只收有值的头；空值头对鉴权无意义，还会白白占空间。
  const headers = {};
  for (const h of (details.requestHeaders || [])) {
    if (!h.name || !h.value) continue;
    const nm = h.name.toLowerCase();
    if (DIRECT_INCLUDE_HEADERS.indexOf(nm) >= 0 ||
        (nm.charAt(0) === 'x' && nm.charAt(1) === '-' && X_AUTH_KEYWORD_REG.test(nm))) {
      headers[nm] = h.value;
    }
  }
  if (Object.keys(headers).length > 0) {
    if (requestAuthHeaders.size > REQUEST_AUTH_MAX) requestAuthHeaders.clear();
    requestAuthHeaders.set(details.requestId, headers);
  }
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

// ---------- 监听响应开始：主捕获点（更早拿到响应头） ----------
safeOn(chrome.webRequest, 'onResponseStarted', (details) => {
  const { tabId, url, responseHeaders, type: resourceType } = details;
  if (tabId < 0) return;

  // 消费 referer：必须放在所有提前 return 之前「取完即删」。
  // 否则被代数校验丢弃的请求、命中追踪 URL 的请求，其 referer 会永久
  // 残留在 requestReferer 里；追踪/日志类请求是全网最高频请求之一，
  // 长时间浏览会导致该 Map 单调增长（内存泄漏）。
  const referer = requestReferer.get(details.requestId);
  requestReferer.delete(details.requestId);
  // 鉴权头整体：与 referer 同因，必须在所有提前 return 之前「取完即删」，
  // 否则被代数校验丢弃 / 命中追踪 URL 的请求，其鉴权头会永久残留导致泄漏。
  const authHeaders = requestAuthHeaders.get(details.requestId);
  requestAuthHeaders.delete(details.requestId);

  // 抓取开关：暂停时不再写入新资源（注意：上面的暂存 Map 已在暂停判断前消费，
  // 因此暂停期间也不会泄漏）。已有列表保留，恢复后继续抓取。
  if (!captureEnabled) return;

  // 校验页面代数：旧页面残留的延迟返回请求（代数不匹配）直接丢弃，
  // 防止跳转前页面的请求混入新页面资源列表（修复边界 bug）。
  const reqGen = requestGen.get(details.requestId);
  requestGen.delete(details.requestId);
  const curGen = pageEpoch.get(tabId) || 0;
  if (reqGen !== undefined && reqGen !== curGen) return;

  if (isTrackingUrl(url)) return;

  // 页面级黑白名单（用户规则 blockUrl）：按「发起请求的页面 URL」判定，命中则整页不抓。
  // details.initiator 是发起请求的页面源（如 https://www.bilibili.com），
  // 拿不到时回退 originUrl；都没有则跳过该规则（宁可不判，不误伤）。
  const pageUrl = details.initiator || details.originUrl || null;
  if (pageUrl && isBlockedPageUrl(pageUrl)) return;

  const mime = getContentType(responseHeaders);
  const size = getContentLength(responseHeaders);

  // 用户规则（Ext/Type/Regex）：只调用一次，取「意见 + 可能被改写的 URL」，
  // 避免后续在 shouldKeepResource 里二次应用导致 Regex 改写不幂等。
  const ur = applyUserRules(url, mime, size);
  if (ur.verdict === 'drop') return;
  const effUrl = ur.url;

  let type = classify(effUrl, mime);

  // resourceType 兜底：URL 无媒体扩展名、mime 不明但浏览器判定为明确的
  // video/audio/media（媒体元素发起），视为媒体（参考猫抓多路判定）。
  if (type === 'unknown') {
    if (resourceType === 'video' || resourceType === 'media') type = 'video';
    else if (resourceType === 'audio') type = 'audio';
  }

  // 过滤 .flv 直播流（RTMP-flv 不可下载）
  if (/\.flv(\?|#|$)/i.test(effUrl)) return;

  // 统一过滤闸门：白名单优先 + 黑名单 + content-type + 尺寸（默认模式）。
  // 用户规则已在上方应用（skipUserRules=true 避免重复改写）；但 verdict=keep
  // 是用户显式放行，直接跳过闸门。
  if (ur.verdict !== 'keep' && !shouldKeepResource(type, effUrl, mime, size, currentCaptureMode, true)) return;

  // content-disposition 附件名优先（修复 URL 无文件名场景）
  const cdName = parseContentDisposition(responseHeaders);
  storeResource(tabId, {
    url: effUrl,
    type,
    mime,
    size,
    filename: cdName || filenameFromUrl(effUrl),
    source: 'network',
    referer: referer || null,
    // 鉴权头：无则保持 undefined（不写空对象，省空间）
    requestHeaders: (authHeaders && Object.keys(authHeaders).length > 0) ? authHeaders : undefined,
    cookie: (authHeaders && authHeaders.cookie) || undefined,
    ts: Date.now()
  });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// ---------- 监听请求失败：清理暂存 ----------
safeOn(chrome.webRequest, 'onErrorOccurred', (details) => {
  requestGen.delete(details.requestId);
  requestReferer.delete(details.requestId);
  requestAuthHeaders.delete(details.requestId);
});

// ---------- 标签页关闭时清理 ----------
safeOn(chrome.tabs, 'onRemoved', (tabId) => {
  clearTabData(tabId);
  clearAutoDownForTab(tabId);   // 自动下载队列/计数/开关随 tab 一起清理
});

// ---------- 快捷键 + 右键菜单（单一 runCommands 函数双入口，参考猫抓设计） ----------
// MV3 限制：commands 不能动态注册，必须在 manifest 里声明；用户可在
// edge://extensions/shortcuts 自行绑定快捷键（manifest 未设默认键，避免冲突）。
function runCommands(command, tab) {
  if (!command) return;
  // 清空当前标签页资源
  if (command === 'clear') {
    if (tab && tab.id != null && tab.id >= 0) clearTabData(tab.id);
    return;
  }
  // 切换深度搜索模式（与 popup 的 setMode 行为保持一致）
  if (command === 'deepSearch') {
    const next = currentCaptureMode === 'deep' ? 'default' : 'deep';
    currentCaptureMode = next;
    try { chrome.storage.local.set({ captureMode: next }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
    try {
      chrome.tabs.query({}, (tabs) => {
        for (const t of tabs) {
          if (t.id != null) chrome.tabs.sendMessage(t.id, { action: 'setMode', mode: next }, () => void chrome.runtime.lastError);
        }
      });
    } catch (e) { /* ignore */ }
    return;
  }
  // 暂停 / 恢复抓取
  if (command === 'toggleCapture') {
    setCaptureEnabled(!captureEnabled);
  }
}

safeOn(chrome.commands, 'onCommand', (command, tab) => {
  try { runCommands(command, tab); } catch (e) { console.warn('[SW] onCommand failed:', String(e && e.message || e)); }
});

// 右键菜单：安装/启动时重建（先 removeAll 防重复创建）
function buildContextMenus() {
  try {
    if (!chrome.contextMenus || typeof chrome.contextMenus.create !== 'function') return;
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) return;
      chrome.contextMenus.create({ id: 'mc-clear', title: '清空本页抓取资源', contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'mc-deepSearch', title: '切换深度搜索模式', contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'mc-toggleCapture', title: '暂停 / 恢复抓取', contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'mc-saveImage', title: '用媒体抓取器下载此图片', contexts: ['image'] });
    });
  } catch (e) { console.warn('[SW] buildContextMenus failed:', String(e && e.message || e)); }
}
safeOn(chrome.runtime, 'onInstalled', () => buildContextMenus());
try { buildContextMenus(); } catch (e) { /* ignore */ }

safeOn(chrome.contextMenus, 'onClicked', (info, tab) => {
  try {
    if (!info) return;
    // 「下载此图片」：直接走 downloads（图片通常无防盗链；有则注入页面 Referer 兜底）
    if (info.menuItemId === 'mc-saveImage') {
      const src = info.srcUrl || '';
      if (!src) return;
      const pageRef = (tab && tab.url) || '';
      if (pageRef) setPreviewRefererRule(src, { referer: pageRef });
      try {
        chrome.downloads.download({ url: src, saveAs: downloadSaveAs }, (id) => {
          if (chrome.runtime.lastError) { if (pageRef) clearPreviewRefererRule(); return; }
          trackDownloadCleanup(id, { url: src, referer: pageRef, mime: 'image/*' });
        });
      } catch (e) { /* ignore */ }
      return;
    }
    const map = { 'mc-clear': 'clear', 'mc-deepSearch': 'deepSearch', 'mc-toggleCapture': 'toggleCapture' };
    const cmd = map[info.menuItemId];
    if (cmd) runCommands(cmd, tab);
  } catch (e) { console.warn('[SW] contextMenus onClicked failed:', String(e && e.message || e)); }
});

// ---------- 对外接口（P2-7）：供其他扩展 / 脚本读取抓取结果 ----------
// 只暴露「只读」的资源列表（url/type/size/filename/referer 等展示字段），
// 🔴 刻意不返回 requestHeaders / cookie 等敏感凭据；也不接受任何写操作。
// 参考猫抓的 onMessageExternal(getData / getCurrentTabData)，独立实现。
safeOn(chrome.runtime, 'onMessageExternal', (msg, sender, sendResponse) => {
  try {
    if (!msg || msg.action !== 'getData') {
      sendResponse({ ok: false, error: 'unsupported_action' });
      return;
    }
    let tabId = msg.tabId;
    if (tabId == null && sender && sender.tab && sender.tab.id != null) tabId = sender.tab.id;
    if (tabId == null || tabId < 0) {
      sendResponse({ ok: false, error: 'no_tab' });
      return;
    }
    const list = Array.from(store.get(tabId)?.values() || []);
    sendResponse({
      ok: true,
      count: list.length,
      resources: list.map((r) => ({
        url: r.url,
        type: r.type,
        mime: r.mime || null,
        size: r.size || null,
        filename: r.filename || null,
        referer: r.referer || null,
        width: r.width || null,
        height: r.height || null,
        source: r.source || null,
        ts: r.ts || null
      }))
    });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  }
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
        // 切到深度模式：对当前活跃 tab 注入 MAIN world 深搜脚本（P1-6）
        if (mode === 'deep') injectDeepSearchActiveTab();
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

    // 抓取开关状态（供 popup 显示「已暂停」提示，避免用户忘记自己暂停过）
    case 'getCaptureState': {
      sendResponse({ ok: true, enabled: captureEnabled });
      break;
    }

    // 按 tab 自动下载开关（P1-4）
    case 'setAutoDown': {
      const tabId = msg.tabId ?? sender.tab?.id;
      const on = setAutoDown(tabId, msg.on === true);
      sendResponse({ ok: true, on });
      break;
    }

    case 'getAutoDown': {
      const tabId = msg.tabId ?? sender.tab?.id;
      sendResponse({
        ok: true,
        on: autoDownTabs.has(tabId),
        count: autoDownCount.get(tabId) || 0,
        max: AUTO_DOWN_MAX_PER_TAB
      });
      break;
    }

    // 预览期间为目标资源域名注入鉴权头（DNR 会话规则，预览关闭即移除）
    case 'previewReferer': {
      // msg.headers 是完整白名单对象（优先），msg.referer 是兼容旧调用的字符串
      const headers = msg.headers || msg.referer;
      if (msg.url && headers) {
        setPreviewRefererRule(msg.url, headers).then((injected) => sendResponse({ ok: true, injected }));
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

    // 供 viewer 查询某 URL 的鉴权头（避免把 cookie 等敏感头拼进 viewer 的 URL query）
    case 'getResourceHeaders': {
      let found = null;
      if (msg.url) {
        outer:
        for (const map of store.values()) {
          for (const r of map.values()) {
            if (r.url === msg.url && r.requestHeaders) { found = r.requestHeaders; break outer; }
          }
        }
      }
      sendResponse({ ok: true, headers: found });
      break;
    }

    // 按需补全缺失大小（P2-8）：用户主动打开预览时探测一次 HEAD
    case 'probeSize': {
      probeSize(msg.url).then((size) => {
        // 回写 store：让列表与后续读取也能拿到大小
        if (size != null && msg.tabId != null) {
          try {
            const map = store.get(msg.tabId);
            if (map) {
              const r = map.get(normalizeUrl(msg.url));
              if (r && (r.size == null || r.size === 0)) {
                r.size = size;
                schedulePersist(msg.tabId);
              }
            }
          } catch (e) { /* ignore */ }
        }
        sendResponse({ ok: true, size });
      });
      return true; // 异步
    }

    // 发送到 aria2（P2-7）：JSON-RPC aria2.addUri，透传 referer / 鉴权头 / 文件名模板
    case 'sendToAria2': {
      const item = msg.item || {};
      const rpc = aria2Rpc;
      if (!rpc) { sendResponse({ ok: false, error: 'no_rpc' }); break; }
      if (!item.url) { sendResponse({ ok: false, error: 'no_url' }); break; }
      // 解析 endpoint 与 token（支持把 token 写成 query：.../jsonrpc?token=xxx）
      let endpoint = rpc;
      let token = '';
      try {
        const u = new URL(rpc);
        if (u.searchParams.has('token')) {
          token = u.searchParams.get('token') || '';
          u.searchParams.delete('token');
          endpoint = u.toString();
        }
      } catch (e) { /* 非法 URL 交给 fetch 报错 */ }
      const options = {};
      if (item.referer) options.referer = item.referer;
      const tplName = applyFileNameTemplate(fileNameTemplate, item);
      if (tplName) options.out = tplName;
      if (item.requestHeaders && typeof item.requestHeaders === 'object') {
        const hs = [];
        for (const k of Object.keys(item.requestHeaders)) hs.push(k + ': ' + item.requestHeaders[k]);
        if (hs.length > 0) options.header = hs;
      }
      const params = token ? [token, [item.url], options] : [[item.url], options];
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now().toString(), method: 'aria2.addUri', params })
      }).then((resp) => resp.json())
        .then((data) => {
          if (data && data.error) sendResponse({ ok: false, error: 'rpc_error', message: data.error.message });
          else sendResponse({ ok: true, gid: data && data.result });
        })
        .catch((e) => sendResponse({ ok: false, error: 'network', message: String(e && e.message || e) }));
      return true; // 异步
    }

    case 'download': {
      // MV3 安全约束：扩展不能通过 chrome.downloads.download({headers:[...]})
      // 注入 Referer 等 unsafe 头（会抛 "Unsafe request header name"）。
      // 防盗链 CDN 的下载请求不带 Referer 会 403（Edge 把 403 错误页存成 .htm），
      // 因此下载期间用 DNR 会话规则注入 Referer，下载结束自动移除。
      // 文件名先经 safeFilename 清洗，修复超长/非法字符导致下载失败。
      if (msg.url && (msg.headers || msg.referer)) setPreviewRefererRule(msg.url, msg.headers || msg.referer);
      // 文件名模板（P2-1）：未配置则用原文件名（行为与历史一致）
      const tplName = applyFileNameTemplate(fileNameTemplate, {
        title: msg.title, url: msg.url, filename: msg.filename, type: msg.type
      });
      chrome.downloads.download({
        url: msg.url,
        filename: tplName || safeFilename(msg.filename),
        // saveAs 由用户偏好决定（默认 false = 直接下载到默认目录）
        saveAs: downloadSaveAs
      }, (id) => {
        if (chrome.runtime.lastError) {
          if (msg.url && (msg.headers || msg.referer)) clearPreviewRefererRule();
          sendResponse({ ok: false, error: 'download_failed', message: chrome.runtime.lastError.message });
          return;
        }
        // 记录资源信息：下载失败（CDN 拒绝类）时据此自动回退 Blob 通道
        trackDownloadCleanup(id, {
          url: msg.url,
          filename: msg.filename,
          mime: msg.mime,
          referer: msg.referer,
          requestHeaders: msg.headers,
          title: msg.title,
          type: msg.type
        });
        sendResponse({ ok: id !== undefined, downloadId: id });
      });
      return true;
    }

    // 批量下载分片（🔴 不做合并：仅逐片落盘，合并交给本地 ffmpeg / N_m3u8DL）
    // 串行 + 250ms 间隔入队，避免分片流场景瞬间发起上百个下载把浏览器打崩。
    case 'downloadSegments': {
      const urls = Array.isArray(msg.urls) ? msg.urls.slice(0, 500) : [];
      // 目录名单独清洗（safeFilename 会干掉 /，而 / 正是我们要保留的目录分隔符）
      const safeBase = String(msg.baseName || 'segments')
        .replace(/[\\/:*?"<>|~\x00-\x1f]/g, '_').slice(0, 60) || 'segments';
      urls.forEach((u, i) => {
        setTimeout(() => {
          try {
            chrome.downloads.download({
              url: u,
              filename: safeBase + '/' + String(i + 1).padStart(3, '0') + segmentExtOf(u),
              saveAs: false
            }, (id) => {
              if (chrome.runtime.lastError) return;
              trackDownloadCleanup(id, { url: u, mime: '' });
            });
          } catch (e) { /* ignore */ }
        }, i * 250);
      });
      sendResponse({ ok: true, count: urls.length });
      break;
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
