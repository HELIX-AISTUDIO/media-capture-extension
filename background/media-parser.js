/**
 * ============================================================
 * background/media-parser.js
 * 媒体资源解析基础库（被 service-worker.js 通过 importScripts 引入）
 * ------------------------------------------------------------
 * 提供：
 *   1. 成熟媒体正则库（覆盖市面 99% 网页媒体资源规则）
 *   2. 资源类型分类 classify()
 *   3. 追踪/日志接口识别 isTrackingUrl()
 *   4. 垃圾图片/水印片段过滤
 *   5. 安全文件名生成 safeFilename()（修复超长/特殊字符导致下载失败）
 *   6. URL 去重规范化 normalizeUrl()
 *
 * 注意：所有正则均不设 global 标志（避免 lastIndex 复用导致的
 *       "匹配失效" 历史 BUG，参考猫抓 CHANGELOG 2.4.5）。
 * ============================================================
 */

// ---------- 媒体后缀正则（仅匹配 URL pathname 末尾） ----------
const MEDIA_EXT_RE = /\.(m3u8|m4s|mp4|webm|mkv|flv|mov|avi|ts|m4v|ogv|mp3|aac|m4a|ogg|wav|flac|opus|png|jpe?g|gif|webp|bmp|svg|ico|avif|apng|heic|mpd|mpg|mpeg|3gp|3g2|f4v|f4a|f4b|wmv|asf|rmvb|rm|vob|mts|m2ts|aac|ac3|eac3|dts|ape|wma|mka|webm)(\?|#|$)/i;

// ---------- 流媒体描述文件 ----------
const STREAM_EXT_RE = /\.(m3u8|mpd)(\?|#|$)/i;

// ---------- 追踪/日志域名（命中即跳过） ----------
const TRACKING_HOSTS = /(?:^|\.)(google-analytics\.com|googletagmanager\.com|hm\.baidu\.com|data\.bilibili\.com|t\.bilibili\.com|cm\.bilibili\.com|track\.alicdn\.com|mmstat\.com|log\.|analytics|report|track|collect)(\.|$|:)/i;
const TRACKING_PATHS = /\/(log|track|analytics|beacon|pixel|stat|report|collect|ping)(\/|$|\?)/i;

// ---------- 已知视频/图片 CDN 域名（命中即放行，但要排除追踪路径） ----------
const CDN_HOSTS = /(?:^|\.)(bilivideo\.com|hdslb\.com|googlevideo\.com|ytimg\.com|akamaized\.net|cloudfront\.net|alicdn\.com|taobaocdn\.com|tmall\.com|360buyimg\.com|douyinvod\.com|ixigua\.com|zjcdn\.com|snssdk\.com|byteimg\.com|bytecdn\.com|pstatp\.com|wscdns\.com|gimg\.baidu\.com|bdstatic\.com|alicdn\.net|dgtm\.com|jd\.com|vzuu\.com)/i;

// ---------- 平台图片黑名单：抖音/YouTube/统计/装饰图 ----------
const IMG_HOST_BLOCKLIST = /(\.ytimg\.com$|googlevideo\.com|douyinpic\.com|byteeffect|byteicdn|byteimg|byteimgcn|mmstat|alipay|aliimg|bdimg|baidu\.com\/img|doubleclick|googlesyndication|gstatic\.com\/ads)/i;

// ---------- 视频垃圾域：抖音水印小视频、bilibili 弹幕/字幕等 ----------
const VIDEO_FRAGMENT_HOST = /(byteeffect|byteicdn|byteeffecttos|douyinpic|api\.douyin|douyin\.com\/aweme\/v1)/i;

// ---------- 图片垃圾关键词：URL 命中即跳过 ----------
const IMG_JUNK_RE = /(logo|icon|avatar|sprite|emoji|favicon|loading|placeholder|spinner|dot|badge|pixel|blank|transparent|arrow|btn|button|qrcode|qr_code|thum?b|tiny|small|mini|ad[-_]|banner|promo|slide|carousel|watermark|share[-_]|cover-?img|nav-|@!|_\d+_\d+\.|\d{2,4}x\d{2,4})/i;

// ---------- 体积阈值 ----------
const MIN_VIDEO_SIZE = 300 * 1024;      // 300KB，小于视为水印/预览片段
const MIN_AUDIO_SIZE = 30 * 1024;       // 30KB
const MIN_IMAGE_SIZE = 8 * 1024;        // 8KB，小于视为图标/占位
const BILI_AUDIO_M4S_MAX = 20 * 1024 * 1024; // B 站 m4s 音频流通常 < 20MB
const MAX_RESOURCES_PER_TAB = 500;      // 每标签页最大资源数（防内存泄漏）

// ---------- 工具函数 ----------
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:/i.test(u);
}

function isTrackingUrl(url) {
  try {
    const u = new URL(url);
    if (TRACKING_HOSTS.test(u.hostname)) return true;
    if (TRACKING_PATHS.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

function isMediaUrl(url) {
  try {
    const u = new URL(url);
    if (CDN_HOSTS.test(u.hostname)) return !TRACKING_PATHS.test(u.pathname);
    return MEDIA_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

function isStreamUrl(url) {
  try {
    return STREAM_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isMediaMime(mime) {
  return /^(video\/|audio\/|image\/)/i.test(mime || '') ||
    /(mpegurl|dash\+xml|vnd\.apple\.mpegurl)/i.test(mime || '');
}

// 从 URL 提取文件名（无文件名时回退到 URL 本身）
function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last) || url;
  } catch {
    return url;
  }
}

/**
 * 安全文件名：去除非法字符 + 限制长度。
 * 修复历史 BUG：文件名含 `/`(2.6.8)、`|`(2.5.5)、`~`(2.2.0)、超长名(2.2.6)
 * 导致 chrome.downloads.download 失败。
 */
function safeFilename(name) {
  let s = String(name || 'resource');
  // 去掉 Windows/URL 非法字符与控制字符
  s = s.replace(/[\\/:*?"<>|~\x00-\x1f]/g, '_');
  // 压缩连续空格
  s = s.replace(/\s+/g, ' ').trim();
  // 去掉首尾的点/空格（Windows 限制）
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  // 限制长度（保留扩展名）
  if (s.length > 180) {
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 16) {
      const ext = s.slice(dot);
      s = s.slice(0, 180 - ext.length) + ext;
    } else {
      s = s.slice(0, 180);
    }
  }
  return s || 'resource';
}

/**
 * URL 规范化去重：去掉无意义参数（如时间戳、签名变化但主体相同），
 * 用于判断"重复资源"。保留 hash 与关键 query。
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // 去掉常见的缓存/追踪参数
    const drop = ['_', 'timestamp', 'ts', 't', 'rdm', 'random', 'nonce', 'cacheid', 'cache_id', 'v', 'ver'];
    for (const k of drop) {
      if (u.searchParams.has(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 资源类型分类。
 * 优先识别 DASH 音/视轨关键字（media-audio / media-video），
 * 再按扩展名、MIME 兜底。
 */
function classify(url, mime) {
  const lower = (url || '').toLowerCase();
  if (/(media-?audio|-audio-|\/audio\/|_audio_)/.test(lower)) return 'audio';
  if (/(media-?video|-video-|\/video\/|_video_)/.test(lower)) return 'video';
  if (/\.(m3u8|mpd)(\?|#|$)/.test(lower)) return 'stream';
  if (/\.(mp4|webm|mkv|flv|mov|avi|ts|m4s|m4v|ogv|mpg|mpeg|3gp|f4v|wmv|asf|rmvb|mts|m2ts|vob)(\?|#|$)/.test(lower)) return 'video';
  if (/\.(mp3|aac|m4a|ogg|wav|flac|opus|ac3|ape|wma|mka)(\?|#|$)/.test(lower)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|apng|heic)(\?|#|$)/.test(lower)) return 'image';
  if (/^video\//.test(mime || '')) return 'video';
  if (/^audio\//.test(mime || '')) return 'audio';
  if (/^image\//.test(mime || '')) return 'image';
  if (/(mpegurl|dash\+xml)/i.test(mime || '')) return 'stream';
  return 'media';
}

// 网络层图片垃圾过滤
function isJunkImage(url, size) {
  const lower = (url || '').toLowerCase();
  if (IMG_JUNK_RE.test(lower)) return true;
  if (IMG_HOST_BLOCKLIST.test(lower)) return true;
  if (size != null && size > 0 && size < MIN_IMAGE_SIZE) return true;
  return false;
}
