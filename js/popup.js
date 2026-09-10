/**
 * ============================================================
 * js/popup.js
 * 弹窗逻辑：读取资源列表并渲染，含筛选/排序/批量复制/预览/解析
 * ------------------------------------------------------------
 * 功能：
 *   1. 查询当前活动标签页，向后台请求资源列表
 *   2. 类型筛选：视频/图片/音频/m3u8-mpd/全部
 *   3. 关键词筛选（文件名/URL/域名）
 *   4. 大小区间表达式筛选：>100KB、<1GB、=500KB、500-1000MB
 *   5. 排序：最新置顶 / 最旧置顶 / 按大小
 *   6. 资源去重展示（后台已按 URL 去重）
 *   7. 复制链接 / 下载 / 打开 / 批量复制
 *   8. m3u8/mpd 解析（调用后台 parseM3u8/parseMpd）
 *   9. 预览面板：视频直接播放、图片大图、音频播放
 * ------------------------------------------------------------
 * 国际化：所有用户可见文案统一走 t(key, '中文兜底')（i18n.js 提供）。
 * ============================================================
 */

let currentTabId = null;
let currentTabUrl = '';
let currentTabTitle = '';
let allResources = [];
let currentFilter = 'video';
let currentSort = 'desc';

// 抓取暂停提示：抓取开关由快捷键 / 右键菜单切换，popup 必须明确提示，
// 否则用户会以为扩展坏了（抓不到任何资源却不知道是自己暂停了）。
let captureEnabledState = true;
function updatePauseBanner() {
  const existing = document.getElementById('pauseBanner');
  if (captureEnabledState) { if (existing) existing.remove(); return; }
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'pauseBanner';
  el.textContent = t('popup_pause_banner', '⏸ 嗅探已暂停：新资源不会被记录（已有列表保留）。用上方开关可随时恢复。');
  const list = document.getElementById('list');
  if (list && list.parentNode) list.parentNode.insertBefore(el, list);
}

// ---------- 顶部「嗅探总开关」（需求第 4 条） ----------
// 把「后台返回的开关状态」映射到 checkbox + 状态文案 —— 单一入口，
// 初始化渲染与点击回写都走这里，避免两处状态各写一遍导致不一致。
// 同时驱动暂停横幅：两者共用同一个状态源 captureEnabledState。
function applySniffSwitchUI(enabled) {
  captureEnabledState = enabled !== false;
  const cb = document.getElementById('sniffToggle');
  const txt = document.getElementById('sniffStateText');
  if (cb) cb.checked = captureEnabledState;
  if (txt) {
    txt.textContent = captureEnabledState
      ? t('popup_switch_on', '嗅探运行中')
      : t('popup_switch_off', '嗅探已暂停');
  }
  updatePauseBanner();
}

const TYPE_META = {
  video: { label: t('popup_type_video', '视频'), cls: 'tag-video' },
  image: { label: t('popup_type_image', '图片'), cls: 'tag-image' },
  audio: { label: t('popup_type_audio', '音频'), cls: 'tag-audio' },
  stream: { label: t('popup_type_stream', '流媒体'), cls: 'tag-stream' },
  unknown: { label: t('popup_type_unknown', '未知'), cls: 'tag-unknown' }
};

const SOURCE_META = {
  dom: { label: 'DOM', cls: 'source-dom' },
  network: { label: 'NET', cls: 'source-net' }
};

function formatSize(bytes) {
  if (bytes == null || bytes === 0) return t('popup_size_unknown', '未知');
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function shortUrl(url, headLen = 48, tailLen = 22) {
  if (!url) return '';
  if (url.length <= headLen + tailLen + 3) return url;
  return url.slice(0, headLen) + '…' + url.slice(-tailLen);
}

function safeFileName(name) {
  return String(name || 'resource').replace(/[\\/:*?"<>|~\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'resource';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ---------- 时间分组（P2-2） ----------
// 按时间排序时，相邻条目时间差超过阈值就插入一条时间分隔线，便于分辨「同一批抓取」
// 的资源（参考猫抓 groupTime 的分组思路，仅做视觉分隔，不改变排序与筛选逻辑）。
const GROUP_GAP_MS = 2 * 60 * 1000;
function fmtGroupTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 大小表达式解析 ----------
// 支持：>100KB  <1GB  =500KB  <=500KB  >=500KB  500-1000MB  1MB 等
function parseSizeExpr(expr) {
  const s = String(expr || '').trim();
  if (!s) return null;
  const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  const toBytes = (val, unit) => val * (units[unit.toUpperCase()] || 1);

  // 范围：500-1000MB
  let m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(s);
  if (m) {
    const unit = m[3] || 'MB';
    return { min: toBytes(parseFloat(m[1]), unit), max: toBytes(parseFloat(m[2]), unit) };
  }
  // 比较：>100KB  <1GB  =500KB  <=500KB  >=500KB
  m = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(s);
  if (m) {
    const op = m[1] || '=';
    const unit = m[3] || 'MB';
    const val = toBytes(parseFloat(m[2]), unit);
    if (op === '>') return { min: val, minEq: false };
    if (op === '>=') return { min: val, minEq: true };
    if (op === '<') return { max: val, maxEq: false };
    if (op === '<=') return { max: val, maxEq: true };
    return { min: val, max: val, minEq: true, maxEq: true };
  }
  return null;
}

function sizeMatches(size, filter) {
  if (!filter) return true;
  if (size == null) return false; // 未知大小不参与区间匹配
  if (filter.min != null) {
    if (filter.minEq ? size < filter.min : size <= filter.min) return false;
  }
  if (filter.max != null) {
    if (filter.maxEq ? size > filter.max : size >= filter.max) return false;
  }
  return true;
}

// ---------- 图标 ----------
const ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 8 16 12 10 16 10 8"/></svg>';
const ICON_AUDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const ICON_MEDIA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
const ICON_STREAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><path d="M5 5l14 14M19 5L5 19"/></svg>';

function thumbHtml(r) {
  if (r.type === 'image') {
    return `<img class="thumb" src="${escapeHtml(r.url)}" alt="" referrerpolicy="no-referrer">`;
  }
  if (r.type === 'video') {
    if (r.posterUrl) {
      return `<img class="thumb" src="${escapeHtml(r.posterUrl)}" alt="" referrerpolicy="no-referrer">`;
    }
    return `<div class="thumb-placeholder video">${ICON_VIDEO}</div>`;
  }
  if (r.type === 'audio') return `<div class="thumb-placeholder audio">${ICON_AUDIO}</div>`;
  if (r.type === 'stream') return `<div class="thumb-placeholder stream">${ICON_STREAM}</div>`;
  return `<div class="thumb-placeholder media">${ICON_MEDIA}</div>`;
}

// ---------- 筛选/排序 ----------
// 关键词支持 /正则/flags 语法（如 /\.mp4$/i）；非法正则自动降级为普通包含匹配。
function parseKeywordExpr(kw) {
  const s = String(kw || '').trim();
  if (s.length >= 3 && s.charAt(0) === '/') {
    const last = s.lastIndexOf('/');
    if (last > 0) {
      const body = s.slice(1, last);
      const flags = s.slice(last + 1);
      if (/^[gimsuy]*$/.test(flags)) {
        try { return { type: 'regex', re: new RegExp(body, flags) }; } catch (e) { /* 非法则降级为文本 */ }
      }
    }
  }
  return { type: 'text', low: s.toLowerCase() };
}

function filteredAndSorted() {
  const kwRaw = (document.getElementById('keyword').value || '').trim();
  const kwExpr = kwRaw ? parseKeywordExpr(kwRaw) : null;
  const sizeExpr = parseSizeExpr(document.getElementById('sizeFilter').value);

  let list = allResources.filter((r) => {
    // 类型筛选
    if (currentFilter !== 'all') {
      if (r.likelyAudio) {
        // B 站音频流（DASH 分离的 m4s）只归「音频」分类，不再混入视频列表
        if (currentFilter !== 'audio') return false;
      } else if (r.type !== currentFilter) {
        return false;
      }
    }
    // 关键词筛选（支持 /正则/ 语法）
    if (kwExpr) {
      const hay = (r.filename || '') + ' ' + (r.url || '') + ' ' + hostOf(r.url);
      if (kwExpr.type === 'regex') {
        kwExpr.re.lastIndex = 0;   // 带 g 标志时必须重置，否则 lastIndex 复用会漏匹配
        if (!kwExpr.re.test(hay)) return false;
      } else if (!hay.toLowerCase().includes(kwExpr.low)) {
        return false;
      }
    }
    // 大小筛选
    if (sizeExpr && !sizeMatches(r.size, sizeExpr)) return false;
    return true;
  });

  // 排序
  if (currentSort === 'size') {
    list.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (currentSort === 'asc') {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  } else {
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  return list;
}

// ---------- 媒体查看器（全屏页面） ----------
// 视频/音频的「打开」不再跳原始地址（防盗链 CDN 会 403），改为打开
// 扩展查看器页面，自动注入原始 Referer 后内嵌播放（参考图片的打开体验）

// 从资源 requestHeaders 里提取「非 forbidden」头（authorization/x-* 等）。
// referer/cookie/origin 属浏览器 forbidden 头，fetch 不能显式设置，只能走后台 DNR 注入，
// 因此这里只提取能被 fetch 直接携带的头，经 query 传给 viewer。
function nonForbiddenHeaders(r) {
  const src = r && r.requestHeaders;
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const k of Object.keys(src)) {
    const kl = k.toLowerCase();
    if (kl === 'referer' || kl === 'cookie' || kl === 'origin') continue;
    out[k] = src[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function openViewer(r, autoDownload) {
  const q = new URLSearchParams({
    src: r.url,
    referer: r.referer || currentTabUrl || '',
    name: r.filename || '',
    mime: r.mime || ''
  });
  if (autoDownload) q.set('autodl', '1');
  // 传递非 forbidden 鉴权头（authorization/x-*）给 viewer 的 fetch 直传。
  // 只带 JSON 短小的（避免 URL 超长）；超长时只带 authorization（最关键的鉴权头）。
  const nh = nonForbiddenHeaders(r);
  if (nh) {
    let payload = nh;
    try {
      if (JSON.stringify(nh).length > 2000) {
        payload = nh.authorization ? { authorization: nh.authorization } : null;
      }
    } catch (e) { payload = null; }
    if (payload) q.set('nh', JSON.stringify(payload));
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '?' + q.toString() });
}

// 装饰/头像/logo 小图判定（深度搜索模式下用于卡片标记；默认模式已在抓取侧过滤）
function isDecorativeImage(r) {
  if (!r || r.type !== 'image') return false;
  const lower = (r.url || '').toLowerCase();
  const DECOR_RE = /(?:^|[/._-])(avatar|logo|icon|head|profile|portrait|headshot|userpic|face)(?:[/._-]|$)/i;
  const AVATAR_HOST = /(gravatar\.com|libravatar|\.avatars?\.|\.avatar\.|profileimages|usercache|secure\.gravatar)/i;
  if (DECOR_RE.test(lower)) return true;
  if (AVATAR_HOST.test(lower)) return true;
  if (r.width != null && r.height != null && Math.min(r.width, r.height) < 180) return true;
  return false;
}

// ---------- 主渲染 ----------
function render() {
  const listEl = document.getElementById('list');
  const filtered = filteredAndSorted();
  document.getElementById('count').textContent = filtered.length ? `(${filtered.length})` : '';

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty">' + escapeHtml(t('popup_empty_title', '暂无匹配资源。')) + '<br>' + escapeHtml(t('popup_empty_hint', '请刷新页面、播放视频或滚动加载图片后重试。')) + '<br><br><span style="font-size:11px;">' + escapeHtml(t('popup_empty_drm', 'DRM 加密视频 / 直播流 / 平台签名受限视频无法抓取')) + '</span></div>';
    return;
  }

  // 时间分组：仅按时间排序时启用（按大小时分组无意义）
  const useTimeGroup = (currentSort === 'desc' || currentSort === 'asc');
  let prevGroupTs = null;

  listEl.innerHTML = filtered.map((r, idx) => {
    const baseMeta = r.likelyAudio ? { label: t('popup_type_audio_stream', '音频流'), cls: 'tag-audio' } : (TYPE_META[r.type] || TYPE_META.unknown);
    const sMeta = SOURCE_META[r.source] || SOURCE_META.network;
    // 装饰/头像/logo 小图标记：默认模式已被过滤，仅在深度搜索模式出现时显示此标记
    const decorTag = isDecorativeImage(r)
      ? `<span class="tag tag-decor" title="${escapeHtml(t('popup_decor_title', '装饰/头像/logo 小图：默认模式已自动过滤，仅深度搜索模式显示'))}">${escapeHtml(t('popup_decor_label', '装饰'))}</span>`
      : '';
    // 鉴权头标记：该资源带 Cookie/Authorization 等头，下载/预览将自动携带
    const authTag = (r.requestHeaders && Object.keys(r.requestHeaders).length > 0)
      ? `<span class="tag tag-auth" title="${escapeHtml(t('popup_auth_title', '该资源需要鉴权头（如 Cookie/Authorization），下载/预览将自动携带'))}">${escapeHtml(t('popup_auth_label', '🔒 鉴权'))}</span>`
      : '';
    const filename = r.filename || (() => {
      try {
        const last = new URL(r.url).pathname.split('/').filter(Boolean).pop();
        return decodeURIComponent(last || r.url);
      } catch { return r.url; }
    })();
    const dim = (r.width && r.height) ? `${r.width}×${r.height}` : '';
    const isStream = r.type === 'stream';
    // 时间分隔线（仅时间排序时；纯视觉，不影响 data-idx 与事件绑定）
    let groupHtml = '';
    if (useTimeGroup && r.ts) {
      if (prevGroupTs == null || Math.abs(prevGroupTs - r.ts) > GROUP_GAP_MS) {
        groupHtml = `<div class="time-group">${escapeHtml(fmtGroupTime(r.ts))}</div>`;
      }
      prevGroupTs = r.ts;
    }
    return groupHtml + `
      <div class="item" data-idx="${idx}">
        <div class="thumb-box">${thumbHtml(r)}</div>
        <div class="item-body">
          <div class="item-head">
            <span class="tag ${baseMeta.cls}">${baseMeta.label}</span>
            <span class="source ${sMeta.cls}" title="${escapeHtml(t('popup_source_title', '来源：$1', [sMeta.label === 'DOM' ? t('popup_source_dom', '页面元素/缓存') : t('popup_source_net', '网络请求')]))}">${sMeta.label}</span>
            ${decorTag}
            ${authTag}
            <span class="name" title="${escapeHtml(r.url)}">${escapeHtml(filename)}</span>
            ${dim ? `<span class="dim">${dim}</span>` : ''}
            <span class="size">${formatSize(r.size)}</span>
          </div>
          <div class="url" title="${escapeHtml(r.url)}">${escapeHtml(shortUrl(r.url))} · <span class="host">${escapeHtml(hostOf(r.url))}</span></div>
          <div class="item-actions">
            <button class="btn btn-copy" data-url="${escapeHtml(r.url)}">${t('common_copy', '复制')}</button>
            <button class="btn btn-download" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(safeFileName(filename))}" title="${escapeHtml(t('common_download', '下载'))}">${t('common_download', '下载')}</button>
            <button class="btn btn-open" data-url="${escapeHtml(r.url)}" title="${escapeHtml((r.type === 'video' || r.type === 'audio') ? t('popup_open_title_viewer', '在媒体查看器中查看') : t('popup_open_title_tab', '在新标签页打开'))}">${t('common_open', '打开')}</button>
            ${isStream ? `<button class="btn btn-parse" data-url="${escapeHtml(r.url)}" title="${escapeHtml(t('popup_btn_parse_title', '解析 m3u8/mpd 分片'))}">${t('popup_btn_parse', '解析')}</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  // 缩略图加载失败降级
  listEl.querySelectorAll('img.thumb').forEach((img) => {
    img.addEventListener('error', () => {
      const box = img.closest('.thumb-box');
      if (box) box.innerHTML = `<div class="thumb-placeholder media">${ICON_MEDIA}</div>`;
    });
  });

  // 复制按钮
  listEl.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        btn.textContent = t('common_copied', '已复制');
        setTimeout(() => (btn.textContent = t('common_copy', '复制')), 1200);
      });
    });
  });
  // 下载按钮：视频/音频走「查看器 Blob 下载」通道（downloads API 无法注入
  // Referer，防盗链 CDN 会 403 存成 .htm）；图片等直接下载即可
  listEl.querySelectorAll('.btn-download').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r2 = filtered.find((x) => x.url === btn.dataset.url);
      if (r2 && (r2.type === 'video' || r2.type === 'audio')) {
        openViewer(r2, true);
        return;
      }
      downloadUrl(btn, btn.dataset.url, btn.dataset.name, (r2 && r2.referer) || currentTabUrl || '', (r2 && r2.requestHeaders) || undefined, (r2 && r2.mime) || '', (r2 && r2.type) || '', currentTabTitle);
    });
  });
  // 打开按钮：视频/音频 → 媒体查看器；其它 → 新标签页原始地址
  listEl.querySelectorAll('.btn-open').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r2 = filtered.find((x) => x.url === btn.dataset.url);
      if (r2 && (r2.type === 'video' || r2.type === 'audio')) openViewer(r2);
      else chrome.tabs.create({ url: btn.dataset.url });
    });
  });
  // 解析按钮
  listEl.querySelectorAll('.btn-parse').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = filtered.find((x) => x.url === btn.dataset.url);
      if (r) showPreview(r, true);
    });
  });

  // 点击 item 主体 → 预览
  listEl.querySelectorAll('.item').forEach((item) => {
    const idx = parseInt(item.dataset.idx, 10);
    const r = filtered[idx];
    if (!r) return;
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      showPreview(r, false);
    });
  });
}

// ---------- 导出当前筛选结果（P2-9） ----------
// 导出「当前筛选/排序后」的列表为 URL 文本（每行一条），便于交给
// aria2 / IDM / 本地脚本批量处理。导出内容与界面所见完全一致。
function exportFilteredList() {
  const list = filteredAndSorted();
  if (list.length === 0) return 0;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  saveTextAsFile(list.map((r) => r.url).join('\n'), 'media-catch-' + stamp + '.txt', 'text/plain');
  return list.length;
}

// ---------- 下载（带失败兜底） ----------
// referer 传给后台：防盗链 CDN 的下载请求需注入 Referer，否则 403 被存成 .htm
// headers 是资源完整鉴权头对象（可为空），供后台 DNR 一并注入 cookie/origin。
function downloadUrl(btn, url, filename, referer, headers, mime, type, title) {
  btn.disabled = true;
  btn.textContent = t('popup_btn_downloading', '下载中…');
  chrome.runtime.sendMessage({ action: 'download', url, filename, referer, headers, mime, type, title }, (resp) => {
    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = t('popup_btn_started', '已发起');
      setTimeout(() => (btn.textContent = t('common_download', '下载')), 1200);
    } else {
      btn.textContent = t('popup_btn_use_open', '请用「打开」');
      btn.title = t('popup_download_fallback_title', '扩展无法注入 Referer；请点「打开」在新标签页右键另存');
      setTimeout(() => { btn.textContent = t('common_download', '下载'); btn.title = ''; }, 3000);
    }
  });
}

// ---------- 预览面板（居中大窗口 + 视频播放 + 解析） ----------
let previewOpen = false;
let previewResource = null;

function closePreview() {
  const overlay = document.getElementById('previewOverlay');
  if (overlay) overlay.classList.remove('active');
  previewOpen = false;
  previewResource = null;
  // 预览关闭即移除 Referer 注入规则，不留全局副作用
  try {
    chrome.runtime.sendMessage({ action: 'clearPreviewReferer' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// ---------- 防盗链/分片预览跳过判断 ----------
// 防盗链 CDN（bilivideo.com 等）不再跳过：打开预览时会先通过后台 DNR
// 会话规则注入原始 Referer（见 SW previewReferer），CDN 校验可正常通过；
// 仅跳过浏览器无法直接播放的格式与过小分片。
const PREVIEW_SKIP_EXT_RE = /\.(m3u8|mpd|ts)(\?|#|$)/i; // 播放列表/原始TS流浏览器无法直接播放
const PREVIEW_MIN_VIDEO_SIZE = 2 * 1024 * 1024; // 2MB，小于视为分片

function shouldSkipVideoPreview(r) {
  if (!r) return false;
  const url = (r.url || '').toLowerCase();
  // 1) 无法直接播放的格式
  if (PREVIEW_SKIP_EXT_RE.test(url)) return true;
  // 2) type='video' 且体积过小（很可能为分片而非完整视频）
  if (r.type === 'video' && r.size != null && r.size > 0 && r.size < PREVIEW_MIN_VIDEO_SIZE) return true;
  return false;
}

function buildPreviewMedia(r) {
  const url = escapeHtml(r.url);
  // 防盗链/分片资源：不渲染播放器，展示提示卡（元信息与操作按钮保留）
  if ((r.type === 'video' || r.type === 'audio') && shouldSkipVideoPreview(r)) {
    return `<div class="preview-media skip">${t('popup_preview_skip', '⚠ 预览跳过（浏览器无法直接播放该格式，如 m3u8/ts）')}<br>
      <button class="btn btn-viewer" style="margin-top:8px;">${t('popup_btn_viewer_new', '在新页面查看')}</button> ${t('popup_preview_or_download', '或点「下载」保存')}</div>`;
  }
  if (r.type === 'video') {
    return `<video class="preview-media" controls autoplay preload="auto" referrerpolicy="no-referrer" src="${url}"></video>`;
  }
  if (r.type === 'audio') {
    return `<audio class="preview-media audio" controls autoplay preload="auto" referrerpolicy="no-referrer" src="${url}"></audio>`;
  }
  if (r.type === 'image') {
    return `<img class="preview-media image" src="${url}" referrerpolicy="no-referrer" alt="">`;
  }
  if (r.type === 'stream') {
    return `<div class="preview-media unknown">${t('popup_preview_stream_desc', '流媒体描述文件（m3u8/mpd）。<br>点击「解析」查看分片列表。')}</div>`;
  }
  return `<div class="preview-media unknown">${t('popup_preview_unknown', '无法预览该媒体类型')}</div>`;
}

// 生成 curl 下载命令：只为实际存在的鉴权头生成 -H；值写入剪贴板由用户自行使用。
// 注意：curl 输出的是明文凭据，用户粘贴到自己终端即视为知情。
function buildCurlCommand(r) {
  const nm = safeFileName(r.filename || 'resource');
  const parts = ['curl', '-o', '"' + nm + '"'];
  const h = r.requestHeaders;
  if (h && typeof h === 'object') {
    for (const k of Object.keys(h)) {
      // 简单转义：值里的双引号/反斜杠会影响 shell，做最小转义
      const v = String(h[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      parts.push('-H', '"' + k + ': ' + v + '"');
    }
  }
  parts.push('"' + r.url + '"');
  return parts.join(' ');
}

async function showPreview(r, autoParse) {
  // 缺失大小按需补全（P2-8）：仅在用户主动打开预览时探测一次（后台发一次 HEAD），
  // 绝不在 content script 内探测、绝不批量/自动探测（项目红线）。
  if (r.size == null && /^https?:/i.test(r.url)) {
    try {
      const pr = await chrome.runtime.sendMessage({ action: 'probeSize', url: r.url, tabId: currentTabId });
      if (pr && pr.ok && pr.size != null) {
        r.size = pr.size;
        const same = allResources.find((x) => x.url === r.url);
        if (same) same.size = pr.size;   // 同步列表数据，下次渲染即显示
      }
    } catch (e) { /* 探测失败不影响预览 */ }
  }

  // 先注入 Referer 会话规则，再渲染播放器——避免 <video> 请求先于规则发出
  // 导致防盗链 CDN 首次请求就 403（注入的 Referer 用抓取时记录的原始值）
  if ((r.type === 'video' || r.type === 'audio')) {
    const ref = r.referer || currentTabUrl || '';
    try {
      if (ref) {
        // 传完整白名单对象（含 cookie/origin），让后台 DNR 注入全部 forbidden 头
        await chrome.runtime.sendMessage({
          action: 'previewReferer',
          url: r.url,
          referer: ref,
          headers: r.requestHeaders || { referer: ref }
        });
      }
    } catch (e) { /* ignore */ }
  }
  previewResource = r;
  let overlay = document.getElementById('previewOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'previewOverlay';
    overlay.className = 'preview-overlay';
    document.body.appendChild(overlay);
  }
  const filename = r.filename || (() => {
    try {
      const last = new URL(r.url).pathname.split('/').filter(Boolean).pop();
      return decodeURIComponent(last || r.url);
    } catch { return r.url; }
  })();

  const metaParts = [];
  if (r.likelyAudio) metaParts.push(`<span class="preview-warn">${t('popup_preview_warn_bili', '⚠ 推测为 B 站音频流')}</span>`);
  if (r.type === 'video' && /\.m4s(\?|#|$)/i.test(r.url)) {
    metaParts.push(`<span class="preview-warn">${t('popup_preview_warn_dash', '⚠ DASH 视频流无音轨（音视频已分离），请用本地 ffmpeg 合并音视频')}</span>`);
  }
  if (r.type === 'stream') {
    metaParts.push(`<span class="preview-warn">${t('popup_preview_warn_stream', '⚠ 流媒体：需解析分片后合并')}</span>`);
  }
  metaParts.push(TYPE_META[r.type] ? TYPE_META[r.type].label : t('popup_type_unknown', '未知'));
  if (r.requestHeaders && Object.keys(r.requestHeaders).length > 0) {
    // 只显示鉴权头「名称」，不显示值（避免明文凭据铺在界面上）
    const hnames = Object.keys(r.requestHeaders).map((k) => k.charAt(0).toUpperCase() + k.slice(1)).join(', ');
    metaParts.push(escapeHtml(t('popup_preview_auth_headers', '🔒 鉴权头: $1', [hnames])));
  }
  if (r.mime) metaParts.push(escapeHtml(r.mime));
  metaParts.push(formatSize(r.size));
  if (r.width && r.height) metaParts.push(`${r.width}×${r.height}`);
  if (r.duration) metaParts.push(formatDuration(r.duration));
  const meta = metaParts.join(' · ');

  const isStream = r.type === 'stream';
  const parseBtn = isStream ? `<button class="btn btn-parse" id="previewParse" data-url="${escapeHtml(r.url)}">${t('popup_btn_parse_segments', '解析分片')}</button>` : '';
  // 「复制为 curl」按钮：仅当资源带鉴权头时才显示（否则 curl 与「复制链接」无差别）
  const curlBtn = (r.requestHeaders && Object.keys(r.requestHeaders).length > 0)
    ? `<button class="btn btn-curl" data-url="${escapeHtml(r.url)}" title="${escapeHtml(t('popup_curl_title', '生成带鉴权头的 curl 命令'))}">${t('popup_btn_curl', '复制为curl')}</button>`
    : '';
  // 「发送到 aria2」按钮（P2-7）：需先在设置页配置 RPC 地址；未配置时点击会提示
  const aria2Btn = `<button class="btn btn-aria2" data-url="${escapeHtml(r.url)}" title="${escapeHtml(t('popup_aria2_title', '发送到 aria2（需在设置页配置 RPC 地址与可选密钥）'))}">${t('popup_btn_aria2', '发送到 aria2')}</button>`;

  overlay.innerHTML = `
    <div class="preview-card">
      <div class="preview-bar">
        <span class="preview-title" title="${escapeHtml(r.url)}">${escapeHtml(filename)}</span>
        <span class="preview-close" id="previewClose" title="${escapeHtml(t('popup_close_title', '关闭(ESC)'))}">×</span>
      </div>
      <div class="preview-media-wrap">${buildPreviewMedia(r)}</div>
      <div class="preview-info">
        <div class="preview-meta">${meta}</div>
        <div class="preview-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
        <div class="preview-actions">
          <button class="btn btn-copy" data-url="${escapeHtml(r.url)}">${t('popup_btn_copy_link', '复制链接')}</button>
          <button class="btn btn-download" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(safeFileName(filename))}">${t('common_download', '下载')}</button>
          <button class="btn btn-open" data-url="${escapeHtml(r.url)}">${t('common_open', '打开')}</button>
          ${curlBtn}
          ${aria2Btn}
          ${parseBtn}
        </div>
      </div>
      <div id="parseResult" class="parse-result" style="display:none;"></div>
    </div>
  `;
  overlay.classList.add('active');
  previewOpen = true;

  // 视频播放失败降级：给出「在新页面查看」入口（查看器页同样注入 Referer）
  const mediaEl = overlay.querySelector('.preview-media');
  if (mediaEl && mediaEl.tagName === 'VIDEO') {
    mediaEl.addEventListener('error', () => {
      const wrap = overlay.querySelector('.preview-media-wrap');
      if (wrap) wrap.innerHTML = `<div class="preview-media fail">${t('popup_preview_fail', '播放失败（CDN 可能校验 Referer 或链接已过期）。')}<br>
        <button class="btn btn-viewer" style="margin-top:8px;">${t('popup_btn_viewer_new', '在新页面查看')}</button> ${t('popup_preview_or_download', '或点「下载」保存')}</div>`;
      const vb = overlay.querySelector('.btn-viewer');
      if (vb) vb.addEventListener('click', () => { if (previewResource) openViewer(previewResource); });
    });
  }

  // 提示卡（跳过/失败）里的「在新页面查看」统一绑定
  const skipViewerBtn = overlay.querySelector('.preview-media.skip .btn-viewer');
  if (skipViewerBtn) {
    skipViewerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (previewResource) openViewer(previewResource);
    });
  }

  document.getElementById('previewClose').addEventListener('click', closePreview);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
  overlay.querySelector('.btn-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(r.url).then(() => {
      e.target.textContent = t('common_copied', '已复制');
      setTimeout(() => (e.target.textContent = t('popup_btn_copy_link', '复制链接')), 1200);
    });
  });
  overlay.querySelector('.btn-download').addEventListener('click', (e) => {
    if (r.type === 'video' || r.type === 'audio') {
      openViewer(r, true);
      closePreview();
      return;
    }
    downloadUrl(e.target, r.url, safeFileName(filename), r.referer || currentTabUrl || '', r.requestHeaders || undefined, r.mime || '', r.type || '', currentTabTitle);
  });
  overlay.querySelector('.btn-open').addEventListener('click', () => {
    if (r.type === 'video' || r.type === 'audio') openViewer(r);
    else chrome.tabs.create({ url: r.url });
  });
  // 「复制为 curl」按钮绑定（仅当按钮存在，即资源带鉴权头时）
  const curlBtnEl = overlay.querySelector('.btn-curl');
  if (curlBtnEl) {
    curlBtnEl.addEventListener('click', () => {
      navigator.clipboard.writeText(buildCurlCommand(r)).then(() => {
        curlBtnEl.textContent = t('common_copied', '已复制');
        setTimeout(() => (curlBtnEl.textContent = t('popup_btn_curl', '复制为curl')), 1200);
      });
    });
  }
  const parseBtnEl = overlay.querySelector('#previewParse');
  if (parseBtnEl) {
    parseBtnEl.addEventListener('click', () => doParse(r));
  }
  // 「发送到 aria2」绑定（P2-7）
  const aria2BtnEl = overlay.querySelector('.btn-aria2');
  if (aria2BtnEl) {
    aria2BtnEl.addEventListener('click', () => {
      aria2BtnEl.disabled = true;
      chrome.runtime.sendMessage({
        action: 'sendToAria2',
        item: {
          url: r.url,
          filename: filename,
          referer: r.referer || currentTabUrl || '',
          type: r.type,
          title: currentTabTitle,
          requestHeaders: r.requestHeaders || null
        }
      }, (resp) => {
        aria2BtnEl.disabled = false;
        if (resp && resp.ok) {
          aria2BtnEl.textContent = t('popup_aria2_sent', '已发送');
        } else {
          const err = resp && resp.error;
          aria2BtnEl.textContent = (err === 'no_rpc') ? t('popup_aria2_no_rpc', '请先在设置页配置') : t('popup_aria2_failed', '发送失败');
        }
        setTimeout(() => { aria2BtnEl.textContent = t('popup_btn_aria2', '发送到 aria2'); }, 2000);
      });
    });
  }
  // 自动解析
  if (autoParse && isStream) doParse(r);
}

// ---------- m3u8/mpd 解析 ----------
function doParse(r) {
  const resultEl = document.getElementById('parseResult');
  if (!resultEl) return;
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div class="parse-head">' + escapeHtml(t('popup_parse_parsing', '解析中…')) + '</div>';
  const isMpd = /\.mpd(\?|#|$)/i.test(r.url);
  const action = isMpd ? 'parseMpd' : 'parseM3u8';

  chrome.runtime.sendMessage({ action, url: r.url, pageUrl: currentTabUrl }, (resp) => {
    if (!resp || !resp.ok) {
      resultEl.innerHTML = `<div class="parse-head">${escapeHtml(t('popup_parse_failed', '解析失败'))}</div><div class="preview-meta">${escapeHtml(resp && resp.message || t('popup_parse_unknown_err', '未知错误'))}<br>${escapeHtml(t('popup_parse_failed_hint', '可能是 CDN 需要 Referer 或跨域限制。'))}</div>`;
      return;
    }
    renderParseResult(resultEl, resp.parsed, isMpd);
  });
}

// ---------- 分片导出 / 批量下载（不合并，红线内） ----------
// 只做「批量下载分片」与「导出播放列表」，绝不合并（在线 ffmpeg.wasm 已永久否决）。
// 合并交给本地工具（ffmpeg / N_m3u8DL-CLI / aria2），避免在扩展里拼大文件。
function buildM3u8Text(segments) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const maxDur = Math.max(1, Math.ceil(segments.reduce((m, s) => Math.max(m, s.duration || 0), 0)));
  lines.push('#EXT-X-TARGETDURATION:' + maxDur);
  lines.push('#EXT-X-MEDIA-SEQUENCE:0');
  for (const s of segments) {
    lines.push('#EXTINF:' + (s.duration || 0).toFixed(3) + ',');
    lines.push(s.url);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function saveTextAsFile(text, filename, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: safeFileName(filename), saveAs: false }, () => {
      void chrome.runtime.lastError; // popup 关闭时会有 lastError，属正常
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  } catch (e) { /* ignore */ }
}

function downloadAllSegments(btn, segments, baseName) {
  if (!segments || segments.length === 0) return;
  const urls = segments.map((s) => s.url).filter(Boolean);
  if (urls.length === 0) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = t('popup_seg_queued', '已入队 $1 个…', [urls.length]);
  chrome.runtime.sendMessage({ action: 'downloadSegments', urls, baseName }, () => {
    setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 1600);
  });
}

function renderParseResult(el, parsed, isMpd) {
  const allSegs = parsed.segments || [];
  // 导出文件名前缀：优先用当前预览资源名
  const baseName = (() => {
    const f = (previewResource && previewResource.filename) || 'segments';
    return String(f).replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'segments';
  })();

  if (isMpd) {
    const reps = parsed.representations || [];
    const segs = parsed.segments || [];
    let html = `<div class="parse-head">${t('popup_dash_tracks', 'DASH 轨道（$1 个）', [reps.length])}</div>`;
    reps.forEach((rep) => {
      html += `<div class="parse-seg"><span class="idx">${escapeHtml(rep.kind || '')}</span><span class="seg-url">${escapeHtml(rep.mimeType || '')} ${rep.resolution || ''} ${rep.bandwidth ? formatSize(rep.bandwidth * 8) + '/s' : ''}</span></div>`;
    });
    html += `<div class="parse-head">${t('popup_seg_count', '分片（$1 个）', [segs.length])}</div>`;
    segs.slice(0, 50).forEach((s, i) => {
      html += `<div class="parse-seg"><span class="idx">${i + 1}</span><span class="seg-url" title="${escapeHtml(s.url)}">${escapeHtml(shortUrl(s.url))}</span><span class="seg-copy" data-url="${escapeHtml(s.url)}">${t('common_copy', '复制')}</span></div>`;
    });
    if (segs.length > 50) html += `<div class="parse-seg">${t('popup_seg_truncated', '… 仅显示前 50 个分片（共 $1）', [segs.length])}</div>`;
    el.innerHTML = html;
  } else {
    const playlists = parsed.playlists || [];
    const segs = parsed.segments || [];
    const keys = parsed.keys || [];
    let html = '';
    if (playlists.length > 0) {
      html += `<div class="parse-head">${t('popup_nested_playlists', '嵌套播放列表（$1 个多码率）', [playlists.length])}</div>`;
      playlists.forEach((p) => {
        html += `<div class="parse-seg"><span class="idx">${p.resolution || ''}</span><span class="seg-url" title="${escapeHtml(p.url)}">${escapeHtml(shortUrl(p.url))}</span><span class="seg-copy" data-url="${escapeHtml(p.url)}">${t('common_copy', '复制')}</span></div>`;
      });
    }
    if (keys.length > 0) {
      html += `<div class="parse-head">${t('popup_keys_count', '加密密钥（$1 个，仅列出不解密）', [keys.length])}</div>`;
      keys.forEach((k) => {
        html += `<div class="parse-seg"><span class="idx">${escapeHtml(k.method)}</span><span class="seg-url" title="${escapeHtml(k.uri || '')}">${escapeHtml(shortUrl(k.uri || ''))}</span><span class="seg-copy" data-url="${escapeHtml(k.uri || '')}">${t('common_copy', '复制')}</span></div>`;
      });
    }
    html += `<div class="parse-head">${t('popup_seg_count', '分片（$1 个）', [segs.length])}</div>`;
    segs.slice(0, 50).forEach((s, i) => {
      html += `<div class="parse-seg"><span class="idx">${i + 1}</span><span class="seg-url" title="${escapeHtml(s.url)}">${escapeHtml(shortUrl(s.url))}</span><span class="seg-copy" data-url="${escapeHtml(s.url)}">${t('common_copy', '复制')}</span></div>`;
    });
    if (segs.length > 50) html += `<div class="parse-seg">${t('popup_seg_truncated', '… 仅显示前 50 个分片（共 $1）', [segs.length])}</div>`;
    if (segs.length === 0 && playlists.length === 0) html = '<div class="parse-head">' + escapeHtml(t('popup_parse_no_segments', '未解析到分片，可能是嵌套 m3u8 或加密流。')) + '</div>';
    el.innerHTML = html;
  }

  // 操作条：导出 / 批量下载（仅当确有分片时显示；明确不做合并）
  if (allSegs.length > 0) {
    const isM3u8 = !isMpd;
    const bar = document.createElement('div');
    bar.className = 'parse-actions';
    if (isM3u8) {
      const bM3u8 = document.createElement('button');
      bM3u8.className = 'btn';
      bM3u8.textContent = t('popup_btn_export_m3u8', '导出为 .m3u8');
      bM3u8.addEventListener('click', () => {
        saveTextAsFile(buildM3u8Text(allSegs), baseName + '.m3u8', 'application/vnd.apple.mpegurl');
      });
      bar.appendChild(bM3u8);
    }
    const bTxt = document.createElement('button');
    bTxt.className = 'btn';
    bTxt.textContent = t('popup_btn_export_urls', '导出 URL 列表');
    bTxt.addEventListener('click', () => {
      saveTextAsFile(allSegs.map((s) => s.url).join('\n'), baseName + '_urls.txt', 'text/plain');
    });
    const bDl = document.createElement('button');
    bDl.className = 'btn';
    bDl.textContent = t('popup_btn_download_all_segs', '下载全部分片（$1）', [allSegs.length]);
    bDl.addEventListener('click', () => downloadAllSegments(bDl, allSegs, baseName));
    bar.appendChild(bTxt);
    bar.appendChild(bDl);
    const hint = document.createElement('div');
    hint.className = 'parse-hint';
    hint.textContent = t('popup_parse_hint', '仅下载 / 导出分片，不做合并；合并请用本地 ffmpeg / N_m3u8DL。');
    el.appendChild(bar);
    el.appendChild(hint);
  }

  // 绑定分片复制
  el.querySelectorAll('.seg-copy').forEach((span) => {
    span.addEventListener('click', () => {
      navigator.clipboard.writeText(span.dataset.url).then(() => {
        span.textContent = t('common_copied', '已复制');
        setTimeout(() => (span.textContent = t('common_copy', '复制')), 1000);
      });
    });
  });
}

// ---------- 数据读取 ----------
// P1-2：SW 冷启动竞态自愈。restoreFromStorage() 是异步的；当本次 getResources 恰好
// 唤醒了刚被回收的 Service Worker 时，storage 恢复回调可能晚于本消息返回，
// 导致弹窗首帧拿到空列表且不会自动更新。此处仅在「非重试轮且结果为空」时，
// 300ms 后补拉一次；isRetry 参数保证最多补拉一次，避免空页面陷入轮询。
function scheduleEmptyRetry(isRetry) {
  if (isRetry) return;
  if (allResources.length > 0) return;
  setTimeout(() => { refresh(true); }, 300);
}

function refresh(isRetry) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { resolve(); return; }
      currentTabId = tabs[0].id;
      currentTabUrl = tabs[0].url || '';
      currentTabTitle = tabs[0].title || '';   // 供文件名模板 ${title} 使用（P2-1）
      // 读取抓取开关状态（快捷键/右键菜单/顶部总开关均可切换）。
      // 复用这条既有链路同时刷新「顶部总开关」与「暂停横幅」，不新增重复请求。
      try {
        chrome.runtime.sendMessage({ action: 'getCaptureState' }, (st) => {
          if (chrome.runtime.lastError) return;
          if (st) applySniffSwitchUI(st.enabled);
        });
      } catch (e) { /* ignore */ }
      loadAutoDown();   // 同步自动下载开关的按钮态
      chrome.runtime.sendMessage({ action: 'getResources', tabId: currentTabId }, (resp) => {
        if (chrome.runtime.lastError) {
          allResources = [];
          render();
          scheduleEmptyRetry(isRetry);
          resolve();
          return;
        }
        allResources = (resp && resp.resources) || [];
        if (previewOpen && previewResource) {
          const stillThere = allResources.find((r) => r.url === previewResource.url);
          if (!stillThere) closePreview();
        }
        render();
        scheduleEmptyRetry(isRetry);
        resolve();
      });
    });
  });
}

// ---------- 抓取模式 UI ----------
function applyCaptureMode(mode) {
  const m = mode === 'deep' ? 'deep' : 'default';
  document.querySelectorAll('input[name="captureMode"]').forEach((r) => {
    r.checked = (r.value === m);
  });
}

function loadCaptureMode() {
  chrome.storage.local.get('captureMode', (result) => {
    if (chrome.runtime.lastError) { applyCaptureMode('default'); return; }
    applyCaptureMode(result && result.captureMode === 'deep' ? 'deep' : 'default');
  });
}

// 清空当前 tab 资源 → 通知 content 重扫 → 重新拉取列表
async function doFullRefresh() {
  const btn = document.getElementById('refresh');
  if (btn) { btn.disabled = true; btn.textContent = t('popup_btn_refreshing', '刷新中…'); }
  try {
    await chrome.runtime.sendMessage({ action: 'clearResources', tabId: currentTabId });
    if (currentTabId) {
      try { await chrome.tabs.sendMessage(currentTabId, { action: 'rescan' }); }
      catch (e) { /* content 未注入时静默 */ }
    }
    // 等待 content script 的 addDomResources 异步重报落地，减少列表短暂为空
    await new Promise((r) => setTimeout(r, 300));
    await refresh();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('popup_btn_refresh', '刷新'); }
  }
}

// ---------- 事件绑定 ----------
document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    render();
  });
});

// 关键词 / 大小筛选：input 是高频事件，资源多时每次按键都会全量重建列表并让
// 所有缩略图重新加载。这里加 200ms 防抖，只作用于这两个输入框；
// 类型标签、排序、清空等仍即时响应，不受影响。
function debounceRender(wait) {
  let timer = null;
  return function debouncedRender() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; render(); }, wait);
  };
}
const renderDebounced = debounceRender(200);
document.getElementById('keyword').addEventListener('input', renderDebounced);
document.getElementById('sizeFilter').addEventListener('input', renderDebounced);
document.getElementById('sortOrder').addEventListener('change', (e) => {
  currentSort = e.target.value;
  render();
});

document.getElementById('refresh').addEventListener('click', doFullRefresh);

// 抓取模式切换
document.querySelectorAll('input[name="captureMode"]').forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    const mode = radio.value;
    applyCaptureMode(mode);
    // 同步到后台（含 storage 持久化）
    await chrome.runtime.sendMessage({ action: 'setMode', mode });
    // 同步到当前 tab 的 content script（避免重扫时仍用旧模式）
    if (currentTabId) {
      try { await chrome.tabs.sendMessage(currentTabId, { action: 'setMode', mode }); }
      catch (e) { /* content 未注入时静默 */ }
    }
    // 切换后自动刷新：清空 + 重扫 + 重新拉取
    await doFullRefresh();
  });
});
document.getElementById('clear').addEventListener('click', () => {
  closePreview();
  chrome.runtime.sendMessage({ action: 'clearResources', tabId: currentTabId }, () => refresh());
});
// 设置按钮：打开规则设置页（options.html，扩展名/MIME/正则/黑白名单四表）
document.getElementById('settings').addEventListener('click', () => {
  try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
});

// 录制按钮（P2-6）：打开录制页 recorder.html，录制当前标签页画面与声音。
// 未取到标签页 id 时不做任何事（防错）。
document.getElementById('record').addEventListener('click', () => {
  if (!currentTabId) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('recorder.html') + '?tabId=' + currentTabId });
});

// ---------- 顶部总开关：点击写入后台（setCaptureState） ----------
// 关键：必须以「后台响应里的 enabled」回写 UI，而不是本地勾选态——
// 否则一旦写入失败（比如 SW 刚重启、消息丢失），UI 会与真实状态脱钩。
document.getElementById('sniffToggle').addEventListener('change', (e) => {
  const desired = !!(e.target && e.target.checked);
  chrome.runtime.sendMessage({ action: 'setCaptureState', on: desired }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      // 写入失败：回滚到「已知的权威状态」，避免出现"勾选已变但实际没变"的假象
      applySniffSwitchUI(captureEnabledState);
      return;
    }
    applySniffSwitchUI(resp.enabled);
  });
});

// ---------- 自动下载开关（P1-4，按 tab 绑定） ----------
// 只对新抓到的资源生效（不会把列表里已有的几百条一次性下载下来），
// 后台另有「串行 + 单 tab 上限 50」两道护栏。
let autoDownOn = false;
function applyAutoDownUI() {
  const btn = document.getElementById('autoDown');
  if (!btn) return;
  btn.textContent = autoDownOn ? t('popup_btn_autodown_on', '自动下载·开') : t('popup_btn_autodown', '自动下载');
  if (autoDownOn) btn.classList.add('active'); else btn.classList.remove('active');
  btn.title = autoDownOn
    ? t('popup_autodown_on_title', '自动下载已开启：本页新抓到的资源会自动下载（点击关闭）')
    : t('popup_autodown_off_title', '开启后，本页新抓到的资源将自动下载（串行 + 单标签页上限 50）');
}
function loadAutoDown() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ action: 'getAutoDown', tabId: currentTabId }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp) { autoDownOn = !!resp.on; applyAutoDownUI(); }
  });
}
document.getElementById('autoDown').addEventListener('click', () => {
  if (currentTabId == null) return;
  const next = !autoDownOn;
  chrome.runtime.sendMessage({ action: 'setAutoDown', tabId: currentTabId, on: next }, (resp) => {
    if (chrome.runtime.lastError) return;
    autoDownOn = !!(resp && resp.on);
    applyAutoDownUI();
  });
});

// 导出按钮：把「当前筛选结果」导出为 URL 列表（.txt）
document.getElementById('export').addEventListener('click', () => {
  const btn = document.getElementById('export');
  const n = exportFilteredList();
  btn.textContent = n > 0 ? t('popup_export_done', '已导出 $1', [n]) : t('popup_export_empty', '列表为空');
  setTimeout(() => { btn.textContent = t('popup_btn_export', '导出'); }, 1600);
});

// 批量复制按钮已移除（v0.2.4 精简界面，仅保留刷新/清空）

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewOpen) closePreview();
});

loadCaptureMode();
refresh();

// ---------- SW 长连接保活 ----------
// popup 打开期间保持后台 SW 活跃，避免长时间操作时 SW 被回收（参考猫抓 HeartBeat 思想）
try {
  const hbPort = chrome.runtime.connect({ name: 'media-heartbeat' });
  window.addEventListener('unload', () => {
    try { hbPort.disconnect(); } catch (e) { /* ignore */ }
    // popup 关闭时兜底清理预览 Referer 规则
    try { chrome.runtime.sendMessage({ action: 'clearPreviewReferer' }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
  });
} catch (e) { /* ignore */ }
