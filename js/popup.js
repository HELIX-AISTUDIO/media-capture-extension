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
 * ============================================================
 */

let currentTabId = null;
let currentTabUrl = '';
let allResources = [];
let currentFilter = 'video';
let currentSort = 'desc';

const TYPE_META = {
  video: { label: '视频', cls: 'tag-video' },
  image: { label: '图片', cls: 'tag-image' },
  audio: { label: '音频', cls: 'tag-audio' },
  stream: { label: '流媒体', cls: 'tag-stream' },
  unknown: { label: '未知', cls: 'tag-unknown' }
};

const SOURCE_META = {
  dom: { label: 'DOM', cls: 'source-dom' },
  network: { label: 'NET', cls: 'source-net' }
};

function formatSize(bytes) {
  if (bytes == null || bytes === 0) return '未知';
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
function filteredAndSorted() {
  const keyword = (document.getElementById('keyword').value || '').trim().toLowerCase();
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
    // 关键词筛选
    if (keyword) {
      const hay = (r.filename + ' ' + r.url + ' ' + hostOf(r.url)).toLowerCase();
      if (!hay.includes(keyword)) return false;
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
function openViewer(r, autoDownload) {
  const q = new URLSearchParams({
    src: r.url,
    referer: r.referer || currentTabUrl || '',
    name: r.filename || '',
    mime: r.mime || ''
  });
  if (autoDownload) q.set('autodl', '1');
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
    listEl.innerHTML = '<div class="empty">暂无匹配资源。<br>请刷新页面、播放视频或滚动加载图片后重试。<br><br><span style="font-size:11px;">DRM 加密视频 / 直播流 / 平台签名受限视频无法抓取</span></div>';
    return;
  }

  listEl.innerHTML = filtered.map((r, idx) => {
    const baseMeta = r.likelyAudio ? { label: '音频流', cls: 'tag-audio' } : (TYPE_META[r.type] || TYPE_META.unknown);
    const sMeta = SOURCE_META[r.source] || SOURCE_META.network;
    // 装饰/头像/logo 小图标记：默认模式已被过滤，仅在深度搜索模式出现时显示此标记
    const decorTag = isDecorativeImage(r)
      ? '<span class="tag tag-decor" title="装饰/头像/logo 小图：默认模式已自动过滤，仅深度搜索模式显示">装饰</span>'
      : '';
    const filename = r.filename || (() => {
      try {
        const last = new URL(r.url).pathname.split('/').filter(Boolean).pop();
        return decodeURIComponent(last || r.url);
      } catch { return r.url; }
    })();
    const dim = (r.width && r.height) ? `${r.width}×${r.height}` : '';
    const isStream = r.type === 'stream';
    return `
      <div class="item" data-idx="${idx}">
        <div class="thumb-box">${thumbHtml(r)}</div>
        <div class="item-body">
          <div class="item-head">
            <span class="tag ${baseMeta.cls}">${baseMeta.label}</span>
            <span class="source ${sMeta.cls}" title="来源：${sMeta.label === 'DOM' ? '页面元素/缓存' : '网络请求'}">${sMeta.label}</span>
            ${decorTag}
            <span class="name" title="${escapeHtml(r.url)}">${escapeHtml(filename)}</span>
            ${dim ? `<span class="dim">${dim}</span>` : ''}
            <span class="size">${formatSize(r.size)}</span>
          </div>
          <div class="url" title="${escapeHtml(r.url)}">${escapeHtml(shortUrl(r.url))} · <span class="host">${escapeHtml(hostOf(r.url))}</span></div>
          <div class="item-actions">
            <button class="btn btn-copy" data-url="${escapeHtml(r.url)}">复制</button>
            <button class="btn btn-download" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(safeFileName(filename))}" title="下载">下载</button>
            <button class="btn btn-open" data-url="${escapeHtml(r.url)}" title="${(r.type === 'video' || r.type === 'audio') ? '在媒体查看器中查看' : '在新标签页打开'}">打开</button>
            ${isStream ? `<button class="btn btn-parse" data-url="${escapeHtml(r.url)}" title="解析 m3u8/mpd 分片">解析</button>` : ''}
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
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1200);
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
      downloadUrl(btn, btn.dataset.url, btn.dataset.name, (r2 && r2.referer) || currentTabUrl || '');
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

// ---------- 下载（带失败兜底） ----------
// referer 传给后台：防盗链 CDN 的下载请求需注入 Referer，否则 403 被存成 .htm
function downloadUrl(btn, url, filename, referer) {
  btn.disabled = true;
  btn.textContent = '下载中…';
  chrome.runtime.sendMessage({ action: 'download', url, filename, referer }, (resp) => {
    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = '已发起';
      setTimeout(() => (btn.textContent = '下载'), 1200);
    } else {
      btn.textContent = '请用「打开」';
      btn.title = '扩展无法注入 Referer；请点「打开」在新标签页右键另存';
      setTimeout(() => { btn.textContent = '下载'; btn.title = ''; }, 3000);
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
    return `<div class="preview-media skip">⚠ 预览跳过（浏览器无法直接播放该格式，如 m3u8/ts）<br>
      <button class="btn btn-viewer" style="margin-top:8px;">在新页面查看</button> 或点「下载」保存</div>`;
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
    return `<div class="preview-media unknown">流媒体描述文件（m3u8/mpd）。<br>点击「解析」查看分片列表。</div>`;
  }
  return `<div class="preview-media unknown">无法预览该媒体类型</div>`;
}

async function showPreview(r, autoParse) {
  // 先注入 Referer 会话规则，再渲染播放器——避免 <video> 请求先于规则发出
  // 导致防盗链 CDN 首次请求就 403（注入的 Referer 用抓取时记录的原始值）
  if ((r.type === 'video' || r.type === 'audio')) {
    const ref = r.referer || currentTabUrl || '';
    try {
      if (ref) {
        await chrome.runtime.sendMessage({ action: 'previewReferer', url: r.url, referer: ref });
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
  if (r.likelyAudio) metaParts.push('<span class="preview-warn">⚠ 推测为 B 站音频流</span>');
  if (r.type === 'video' && /\.m4s(\?|#|$)/i.test(r.url)) {
    metaParts.push('<span class="preview-warn">⚠ DASH 视频流无音轨（音视频已分离），请用本地 ffmpeg 合并音视频</span>');
  }
  if (r.type === 'stream') {
    metaParts.push('<span class="preview-warn">⚠ 流媒体：需解析分片后合并</span>');
  }
  metaParts.push(TYPE_META[r.type] ? TYPE_META[r.type].label : '未知');
  if (r.mime) metaParts.push(escapeHtml(r.mime));
  metaParts.push(formatSize(r.size));
  if (r.width && r.height) metaParts.push(`${r.width}×${r.height}`);
  if (r.duration) metaParts.push(formatDuration(r.duration));
  const meta = metaParts.join(' · ');

  const isStream = r.type === 'stream';
  const parseBtn = isStream ? `<button class="btn btn-parse" id="previewParse" data-url="${escapeHtml(r.url)}">解析分片</button>` : '';

  overlay.innerHTML = `
    <div class="preview-card">
      <div class="preview-bar">
        <span class="preview-title" title="${escapeHtml(r.url)}">${escapeHtml(filename)}</span>
        <span class="preview-close" id="previewClose" title="关闭(ESC)">×</span>
      </div>
      <div class="preview-media-wrap">${buildPreviewMedia(r)}</div>
      <div class="preview-info">
        <div class="preview-meta">${meta}</div>
        <div class="preview-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
        <div class="preview-actions">
          <button class="btn btn-copy" data-url="${escapeHtml(r.url)}">复制链接</button>
          <button class="btn btn-download" data-url="${escapeHtml(r.url)}" data-name="${escapeHtml(safeFileName(filename))}">下载</button>
          <button class="btn btn-open" data-url="${escapeHtml(r.url)}">打开</button>
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
      if (wrap) wrap.innerHTML = `<div class="preview-media fail">播放失败（CDN 可能校验 Referer 或链接已过期）。<br>
        <button class="btn btn-viewer" style="margin-top:8px;">在新页面查看</button> 或点「下载」保存</div>`;
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
      e.target.textContent = '已复制';
      setTimeout(() => (e.target.textContent = '复制链接'), 1200);
    });
  });
  overlay.querySelector('.btn-download').addEventListener('click', (e) => {
    if (r.type === 'video' || r.type === 'audio') {
      openViewer(r, true);
      closePreview();
      return;
    }
    downloadUrl(e.target, r.url, safeFileName(filename), r.referer || currentTabUrl || '');
  });
  overlay.querySelector('.btn-open').addEventListener('click', () => {
    if (r.type === 'video' || r.type === 'audio') openViewer(r);
    else chrome.tabs.create({ url: r.url });
  });
  const parseBtnEl = overlay.querySelector('#previewParse');
  if (parseBtnEl) {
    parseBtnEl.addEventListener('click', () => doParse(r));
  }
  // 自动解析
  if (autoParse && isStream) doParse(r);
}

// ---------- m3u8/mpd 解析 ----------
function doParse(r) {
  const resultEl = document.getElementById('parseResult');
  if (!resultEl) return;
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div class="parse-head">解析中…</div>';
  const isMpd = /\.mpd(\?|#|$)/i.test(r.url);
  const action = isMpd ? 'parseMpd' : 'parseM3u8';

  chrome.runtime.sendMessage({ action, url: r.url, pageUrl: currentTabUrl }, (resp) => {
    if (!resp || !resp.ok) {
      resultEl.innerHTML = `<div class="parse-head">解析失败</div><div class="preview-meta">${escapeHtml(resp && resp.message || '未知错误')}<br>可能是 CDN 需要 Referer 或跨域限制。</div>`;
      return;
    }
    renderParseResult(resultEl, resp.parsed, isMpd);
  });
}

function renderParseResult(el, parsed, isMpd) {
  if (isMpd) {
    const reps = parsed.representations || [];
    const segs = parsed.segments || [];
    let html = `<div class="parse-head">DASH 轨道（${reps.length} 个）</div>`;
    reps.forEach((rep) => {
      html += `<div class="parse-seg"><span class="idx">${escapeHtml(rep.kind || '')}</span><span class="seg-url">${escapeHtml(rep.mimeType || '')} ${rep.resolution || ''} ${rep.bandwidth ? formatSize(rep.bandwidth * 8) + '/s' : ''}</span></div>`;
    });
    html += `<div class="parse-head">分片（${segs.length} 个）</div>`;
    segs.slice(0, 50).forEach((s, i) => {
      html += `<div class="parse-seg"><span class="idx">${i + 1}</span><span class="seg-url" title="${escapeHtml(s.url)}">${escapeHtml(shortUrl(s.url))}</span><span class="seg-copy" data-url="${escapeHtml(s.url)}">复制</span></div>`;
    });
    if (segs.length > 50) html += `<div class="parse-seg">… 仅显示前 50 个分片（共 ${segs.length}）</div>`;
    el.innerHTML = html;
  } else {
    const playlists = parsed.playlists || [];
    const segs = parsed.segments || [];
    const keys = parsed.keys || [];
    let html = '';
    if (playlists.length > 0) {
      html += `<div class="parse-head">嵌套播放列表（${playlists.length} 个多码率）</div>`;
      playlists.forEach((p) => {
        html += `<div class="parse-seg"><span class="idx">${p.resolution || ''}</span><span class="seg-url" title="${escapeHtml(p.url)}">${escapeHtml(shortUrl(p.url))}</span><span class="seg-copy" data-url="${escapeHtml(p.url)}">复制</span></div>`;
      });
    }
    if (keys.length > 0) {
      html += `<div class="parse-head">加密密钥（${keys.length} 个，仅列出不解密）</div>`;
      keys.forEach((k) => {
        html += `<div class="parse-seg"><span class="idx">${escapeHtml(k.method)}</span><span class="seg-url" title="${escapeHtml(k.uri || '')}">${escapeHtml(shortUrl(k.uri || ''))}</span><span class="seg-copy" data-url="${escapeHtml(k.uri || '')}">复制</span></div>`;
      });
    }
    html += `<div class="parse-head">分片（${segs.length} 个）</div>`;
    segs.slice(0, 50).forEach((s, i) => {
      html += `<div class="parse-seg"><span class="idx">${i + 1}</span><span class="seg-url" title="${escapeHtml(s.url)}">${escapeHtml(shortUrl(s.url))}</span><span class="seg-copy" data-url="${escapeHtml(s.url)}">复制</span></div>`;
    });
    if (segs.length > 50) html += `<div class="parse-seg">… 仅显示前 50 个分片（共 ${segs.length}）</div>`;
    if (segs.length === 0 && playlists.length === 0) html = '<div class="parse-head">未解析到分片，可能是嵌套 m3u8 或加密流。</div>';
    el.innerHTML = html;
  }
  // 绑定分片复制
  el.querySelectorAll('.seg-copy').forEach((span) => {
    span.addEventListener('click', () => {
      navigator.clipboard.writeText(span.dataset.url).then(() => {
        span.textContent = '已复制';
        setTimeout(() => (span.textContent = '复制'), 1000);
      });
    });
  });
}

// ---------- 数据读取 ----------
function refresh() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { resolve(); return; }
      currentTabId = tabs[0].id;
      currentTabUrl = tabs[0].url || '';
      chrome.runtime.sendMessage({ action: 'getResources', tabId: currentTabId }, (resp) => {
        if (chrome.runtime.lastError) {
          allResources = [];
          render();
          resolve();
          return;
        }
        allResources = (resp && resp.resources) || [];
        if (previewOpen && previewResource) {
          const stillThere = allResources.find((r) => r.url === previewResource.url);
          if (!stillThere) closePreview();
        }
        render();
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
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
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
    if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
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

document.getElementById('keyword').addEventListener('input', render);
document.getElementById('sizeFilter').addEventListener('input', render);
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
