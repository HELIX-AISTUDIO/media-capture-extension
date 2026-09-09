/**
 * ============================================================
 * js/viewer.js
 * 媒体查看器（扩展全屏页面）：视频/音频/图片的"打开即看"体验
 * ------------------------------------------------------------
 * 触发时机：popup 点「打开」（视频/音频）或「下载」跳转（autodl=1）。
 * 防盗链处理：本页的媒体/fetch 请求受后台 DNR 会话规则注入的 Referer
 * 保护（previewReferer），页面关闭/刷新即移除（clearPreviewReferer）。
 * 下载通道：fetch(Referer 注入) → Blob → blob URL 交给下载 API 另存。
 *   已知 Chromium 限制：DNR 对 chrome.downloads.download 的请求不生效，
 *   且 downloads API 无法携带 Referer，因此直接下载防盗链 CDN 必 403。
 * 自诊断：Referer 注入状态显示在页面上；下载按「原始 Referer →
 *   bilibili 主页 → 无 Referer」逐级重试；内容嗅探防止把 403 错误页
 *   存成 .htm，失败时明确报告 HTTP 状态。
 * ============================================================
 */

const qs = new URLSearchParams(location.search);
const src = qs.get('src') || '';
const ref = qs.get('referer') || '';
const name = qs.get('name') || 'media';
const mime = qs.get('mime') || '';

const path = (() => { try { return new URL(src).pathname; } catch { return src; } })();
const isVideo = /^video\//i.test(mime) || /\.(mp4|webm|m4v|mov|mkv|m4s|ogv|3gp|f4v|wmv|flv|ts)$/i.test(path);
const isAudio = /^audio\//i.test(mime) || /\.(mp3|wav|flac|aac|ogg|m4a|wma|opus|mka)$/i.test(path);
const isImage = /^image\//i.test(mime) || /\.(jpe?g|png|gif|bmp|webp|avif|apng|heic)$/i.test(path);

// Referer 注入状态（下载重试链会用到）
let refInjected = false;

function safeName(s) {
  return String(s || 'media').replace(/[\\/:*?"<>|~\x00-\x1f]/g, '_').slice(0, 120) || 'media';
}

// 修复历史 BUG：所有 DOM 写入前必须判空。下载进度有按钮时写按钮、
// 无按钮（autodl 自动下载视图）时自动创建状态行，绝不写 null
function setTextOn(el, text) {
  if (el) el.textContent = text;
}

function getOrCreateStatusEl() {
  // 优先用 failCard 里的下载按钮；autodl 视图没有按钮时创建状态行
  const btn = document.getElementById('dlBtn');
  if (btn) return btn;
  let st = document.getElementById('dlStatus');
  if (!st) {
    st = document.createElement('div');
    st.id = 'dlStatus';
    st.style.cssText = 'font-size:13px;color:#9ca3af;';
    const anchor = document.getElementById('diag') || document.getElementById('title');
    if (anchor && anchor.insertAdjacentElement) anchor.insertAdjacentElement('afterend', st);
  }
  return st;
}

function clearRefererRule() {
  try {
    chrome.runtime.sendMessage({ action: 'clearPreviewReferer' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// 设置/更新 DNR Referer 规则（referer 为空串表示移除规则）
async function applyRefererRule(referer) {
  try {
    if (!referer) {
      await chrome.runtime.sendMessage({ action: 'clearPreviewReferer' });
      return false;
    }
    const r = await chrome.runtime.sendMessage({ action: 'previewReferer', url: src, referer });
    return !!(r && r.injected);
  } catch (e) { return false; }
}

function failCard(msg) {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.innerHTML = `
    <div class="card">
      <div class="warn">⚠ ${msg}</div>
      <div class="hint">可能原因：CDN 强校验 Referer / 链接带时效签名已过期 / DRM 加密</div>
      <div class="actions" style="margin-top:14px;">
        <button class="ghost" id="copyBtn">复制链接</button>
        <button id="dlBtn">重新尝试下载</button>
        <button class="ghost" id="rawBtn">直接打开原始地址</button>
      </div>
    </div>`;
  const copyBtn = document.getElementById('copyBtn');
  const dlBtn = document.getElementById('dlBtn');
  const rawBtn = document.getElementById('rawBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(src).then(() => setTextOn(copyBtn, '已复制'));
  });
  if (dlBtn) dlBtn.addEventListener('click', () => downloadViaBlob());
  if (rawBtn) rawBtn.addEventListener('click', () => chrome.tabs.create({ url: src }));
}

// 嗅探响应开头是否为 HTML（CDN 的 403/错误页），防止存成 .htm
function looksLikeHtml(firstBytes) {
  const head = new TextDecoder().decode((firstBytes || []).slice(0, 64));
  return /^\s*(<\?|<!|<html|<body)/i.test(head);
}

/**
 * 带 Referer 重试链的流式下载：
 * 依次尝试「抓取时记录的原始 Referer → bilibili 主页 → 无 Referer」，
 * 每次要求 HTTP 200 且开头字节不是 HTML；全部失败则抛出带状态码的错误。
 */
async function fetchMediaWithRetry(onProgress) {
  const attempts = [];
  if (ref) attempts.push({ label: '原始页面 Referer', value: ref });
  attempts.push({ label: 'bilibili 主页 Referer', value: 'https://www.bilibili.com/' });
  attempts.push({ label: '无 Referer', value: '' });

  let lastStatus = 0;
  let lastLabel = '';
  for (const attempt of attempts) {
    onProgress('尝试 ' + attempt.label + '…');
    const injected = await applyRefererRule(attempt.value);
    refInjected = injected;
    updateDiag();
    let resp;
    try {
      resp = await fetch(src, { credentials: 'include' });
    } catch (e) {
      lastStatus = -1;
      continue;
    }
    if (!resp.ok) { lastStatus = resp.status; lastLabel = attempt.label; continue; }
    // 嗅探：200 但内容是 HTML → 视为被 CDN 拒绝，换下一个 Referer
    const reader = resp.body.getReader();
    const first = await reader.read();
    if (looksLikeHtml(first.value)) {
      lastStatus = resp.status;
      lastLabel = attempt.label;
      try { reader.cancel(); } catch (e) { /* ignore */ }
      continue;
    }
    return { resp, reader, first, via: attempt.label };
  }
  throw new Error('HTTP ' + lastStatus + '（' + lastLabel + ' 也被 CDN 拒绝）');
}

// 根据扩展名推断正确的 MIME（Blob 带上正确类型后，
// Chromium 才会保留我们指定的 .m4s/.mp4 等扩展名，不会乱改成 .txt）
function guessMimeFromPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  const ext = m ? m[1].toLowerCase() : '';
  const map = {
    m4s: 'video/mp4', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t', flv: 'video/x-flv',
    ogv: 'video/ogg', avi: 'video/x-msvideo', wmv: 'video/x-mswmv',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma'
  };
  return map[ext] || 'application/octet-stream';
}

async function downloadViaBlob() {
  const statusEl = getOrCreateStatusEl();
  const setTxt = (t) => setTextOn(statusEl, t);
  try {
    setTxt('连接中…');
    const res = await fetchMediaWithRetry(setTxt);
    setTxt('下载中…');
    const total = parseInt(res.resp.headers.get('content-length') || '0', 10);
    const chunks = [];
    let got = 0;
    const push = (v) => {
      chunks.push(v);
      got += v.length;
      if (total > 0) setTxt('下载中 ' + Math.round((got / total) * 100) + '%');
      else setTxt('下载中 ' + (got / 1048576).toFixed(1) + 'MB');
    };
    push(res.first.value);
    for (;;) {
      const { done, value } = await res.reader.read();
      if (done) break;
      push(value);
    }
    setTxt('准备保存…');
    // Blob 必须带正确 MIME：空类型会被 Chromium 内容嗅探，
    // 另存时扩展名被改成 .txt/.htm（修复历史 BUG）
    const blobType = (/^(video|audio)\//i.test(mime) ? mime : '') || guessMimeFromPath(path);
    const blob = new Blob(chunks, { type: blobType });
    const objUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: objUrl, filename: safeName(name), saveAs: true }, () => {
      // blob URL 延迟回收：等待用户在另存对话框确认 / 下载完成
      setTimeout(() => URL.revokeObjectURL(objUrl), 10 * 60 * 1000);
    });
    setTxt('已发起保存 ✓');
    setTimeout(() => { setTxt('下载保存'); }, 2500);
  } catch (e) {
    setTxt('下载失败');
    failCard('下载失败：' + String(e && e.message || e));
  }
}

// 页面顶部的注入状态行
function updateDiag() {
  const el = document.getElementById('diag');
  if (!el) return;
  el.textContent = refInjected
    ? '防盗链 Referer 注入：已生效'
    : '防盗链 Referer 注入：未生效（CDN 可能拒绝）';
  el.style.color = refInjected ? '#34d399' : '#fbbf24';
}

async function init() {
  const titleEl = document.getElementById('title');
  const urlEl = document.getElementById('url');
  const stage = document.getElementById('stage');
  if (!stage) return;

  setTextOn(titleEl, safeName(name));
  setTextOn(urlEl, src);

  if (!/^https?:/i.test(src)) {
    failCard('无效的媒体地址');
    return;
  }

  // 注入状态行（在页面标题下方实时显示 DNR 规则是否生效）
  const diag = document.createElement('div');
  diag.id = 'diag';
  diag.style.cssText = 'font-size:12px;color:#9ca3af;';
  if (titleEl && titleEl.insertAdjacentElement) titleEl.insertAdjacentElement('afterend', diag);

  // 先注入 Referer 规则，再渲染媒体元素（避免首次请求 403）
  const autoDl = qs.get('autodl') === '1';
  if ((isVideo || isAudio) && ref) {
    refInjected = await applyRefererRule(ref);
  }
  updateDiag();

  if (isVideo) {
    const v = document.createElement('video');
    v.controls = true;
    v.autoplay = !autoDl; // 自动下载时不自动播放，避免重复拉取大文件
    v.preload = autoDl ? 'none' : 'auto';
    v.playsInline = true;
    v.referrerPolicy = 'no-referrer';
    v.src = src;
    v.addEventListener('error', () => {
      failCard('播放失败：该资源无法在浏览器直接播放（可用下方下载通道保存）');
    });
    stage.appendChild(v);
  } else if (isAudio) {
    const a = document.createElement('audio');
    a.controls = true;
    a.autoplay = !autoDl;
    a.src = src;
    a.addEventListener('error', () => {
      failCard('播放失败：该资源无法在浏览器直接播放（可用下方下载通道保存）');
    });
    stage.appendChild(a);
  } else if (isImage) {
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.alt = safeName(name);
    img.src = src;
    img.addEventListener('error', () => failCard('图片加载失败'));
    stage.appendChild(img);
  } else {
    // 无法直接内嵌播放的类型（如 m3u8/ts/未知）：展示信息卡 + 操作入口
    failCard('该类型无法直接内嵌预览（如 m3u8/ts 流或未识别格式）');
  }

  if (autoDl) downloadViaBlob();
}

// 兜底捕获：init 内任何异常都记到控制台，不再产生 uncaught (in promise)
init().catch((e) => console.warn('[viewer] init failed:', String(e && e.message || e)));

// 页面关闭/刷新即移除 Referer 注入规则，不留全局副作用
window.addEventListener('unload', clearRefererRule);
