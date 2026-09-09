/**
 * ============================================================
 * js/media-parser.js
 * 媒体资源解析基础库（被 background.js 通过 importScripts 引入）
 * ------------------------------------------------------------
 * 提供：
 *   1. 媒体扩展名「白名单」分类（视频/音频/图片/流媒体）
 *   2. 非媒体扩展名「黑名单」（css/html/json/字体/脚本/文档等）
 *   3. content-type 校验（明确非媒体的响应头直接过滤）
 *   4. 资源类型分类 classify()（返回 video/audio/image/stream/unknown）
 *   5. 默认模式统一过滤闸门 shouldKeepResource()（白名单优先）
 *   6. 追踪/日志接口识别 isTrackingUrl()
 *   7. 垃圾图片/水印片段过滤 isJunkImage()
 *   8. 安全文件名 safeFilename()、URL 去重 normalizeUrl()
 *
 * v0.2.3 过滤原则（对标猫抓"干净列表"）：
 *   - 白名单优先：只允许明确的 视频/音频/图片/流媒体 进入列表；
 *   - 黑名单补刀：css/html/json/xml/字体/脚本/文档 等直接过滤；
 *   - content-type + 后缀 双重校验；图片 <50KB 默认隐藏；
 *   - 「未知」类型（扩展名/mime 都不明确）默认丢弃，仅深度模式保留。
 *
 * 注意：所有正则均不设 global 标志（避免 lastIndex 复用导致的
 *       "匹配失效" 历史 BUG，参考猫抓 CHANGELOG 2.4.5）。
 * ============================================================
 */

// ---------- 视频扩展名白名单 ----------
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|avi|mov|mkv|flv|wmv|m4s|ogv|mpg|mpeg|3gp|f4v|asf|rmvb|mts|m2ts|vob)(\?|#|$)/i;

// ---------- 音频扩展名白名单 ----------
const AUDIO_EXT_RE = /\.(mp3|wav|flac|aac|ogg|m4a|wma|opus|ac3|ape|mka)(\?|#|$)/i;

// ---------- 图片扩展名白名单（不含 ico/svg，二者默认过滤） ----------
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|bmp|webp|tiff?|avif|apng|heic)(\?|#|$)/i;

// ---------- 流媒体播放列表（m3u8/mpd/pls） ----------
const STREAM_EXT_RE = /\.(m3u8|mpd|pls)(\?|#|$)/i;

// ---------- 任意媒体扩展名（供"是否媒体 URL"粗判，含 ico/svg） ----------
const MEDIA_EXT_RE = /\.(m3u8|mpd|pls|mp4|webm|m4v|avi|mov|mkv|flv|wmv|m4s|ogv|mpg|mpeg|3gp|f4v|asf|rmvb|mts|m2ts|vob|mp3|wav|flac|aac|ogg|m4a|wma|opus|ac3|ape|mka|jpe?g|png|gif|bmp|webp|tiff?|avif|apng|heic|svg|ico)(\?|#|$)/i;

// ---------- 明确非媒体扩展名黑名单（命中即过滤） ----------
// 注意：不包含 .ts —— .ts 既是视频分片(M2TS)又是 TypeScript 源码，
//       由 classify() 结合 content-type 单独消歧。
const NON_MEDIA_EXT_RE = /\.(css|html?|json|xml|txt|md|markdown|pdf|docx?|xlsx?|pptx?|ttf|otf|woff2?|eot|js|mjs|jsx|tsx|wasm|map|csv|zip|rar|7z|tar|gzip|gz|swf|dat|db|sqlite|log|ya?ml|toml|ini)(\?|#|$)/i;

// ---------- 明确非媒体的 content-type（命中即过滤，即使 URL 带媒体后缀） ----------
const NON_MEDIA_MIME_RE = /^(?:text\/(?:html|css|javascript|plain|xml)|application\/(?:json|xml|javascript|x-www-form-urlencoded|pdf|xhtml\+xml|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.ms-fontobject|font-(?:woff2?|ttf|otf))|font\/|image\/svg\+xml|image\/x-icon|image\/vnd\.microsoft\.icon)/i;

// ---------- 追踪/日志域名（命中即跳过） ----------
const TRACKING_HOSTS = /(?:^|\.)(google-analytics\.com|googletagmanager\.com|hm\.baidu\.com|data\.bilibili\.com|t\.bilibili\.com|cm\.bilibili\.com|track\.alicdn\.com|mmstat\.com|log\.|analytics|report|track|collect)(\.|$|:)/i;
const TRACKING_PATHS = /\/(log|track|analytics|beacon|pixel|stat|report|collect|ping)(\/|$|\?)/i;

// ---------- 平台图片黑名单：抖音/YouTube/统计/装饰图 ----------
const IMG_HOST_BLOCKLIST = /(\.ytimg\.com$|googlevideo\.com|douyinpic\.com|byteeffect|byteicdn|byteimg|byteimgcn|mmstat|alipay|aliimg|bdimg|baidu\.com\/img|doubleclick|googlesyndication|gstatic\.com\/ads)/i;

// ---------- 视频垃圾域：抖音水印小视频、bilibili 弹幕/字幕等 ----------
const VIDEO_FRAGMENT_HOST = /(byteeffect|byteicdn|byteeffecttos|douyinpic|api\.douyin|douyin\.com\/aweme\/v1)/i;

// ---------- 图片垃圾关键词：URL 命中即跳过 ----------
const IMG_JUNK_RE = /(logo|icon|avatar|sprite|emoji|favicon|loading|placeholder|spinner|dot|badge|pixel|blank|transparent|tracking|beacon|spacer|1x1|arrow|btn|button|qrcode|qr_code|thum?b|tiny|small|mini|ad[-_]|banner|promo|slide|carousel|watermark|share[-_]|cover-?img|nav-|@!|_\d+_\d+\.|\d{2,4}x\d{2,4})/i;

// ---------- 图片装饰/头像/logo 片段（按 URL 段匹配，避免误伤正文图） ----------
// 仅当 avatar/logo/icon/head/profile 等作为独立片段（被 ./_- 或起止包围）出现才判为装饰，
// 避免 "headline.jpg" 这类正文图被误杀（对应任务3：来源标记过滤）。
const IMG_DECORATIVE_RE = /(?:^|[/._-])(avatar|logo|icon|head|profile|portrait|headshot|userpic|face)(?:[/._-]|$)/i;

// ---------- 头像/logo 专用域名（命中即视为装饰小图） ----------
const AVATAR_HOST_RE = /(gravatar\.com|libravatar|\.avatars?\.|\.avatar\.|profileimages|usercache|secure\.gravatar)/i;

// ---------- 图片短边阈值（默认模式，DOM 图片按自然尺寸过滤） ----------
// 短边 < 180px 视为图标/头像/装饰小图（对应任务3：尺寸过滤）。
const IMG_SHORT_EDGE_MIN = 180;

// ---------- 体积阈值 ----------
// 参考猫抓 CheckType() + G.Type 配置表的「按类型设最小尺寸闸门」设计：
// 猫抓把每种 MIME 的开关(state)与最小尺寸(size)放在一张表里统一校验，避免散落的 if-else。
// 本项目用分散常量实现同样思路（视频/音频/图片各自阈值），后续可收敛为一张 TYPE_LIMITS 表；
// 图片阈值 IMG_SHORT_EDGE_MIN=180 则对应猫抓「按自然尺寸过滤小图」的 DOM 侧判定。
const MIN_VIDEO_SIZE = 300 * 1024;      // 300KB，小于视为水印/预览片段
const MIN_AUDIO_SIZE = 30 * 1024;       // 30KB
const MIN_IMAGE_SIZE = 50 * 1024;       // 50KB，小于视为图标/占位/小图（v0.2.3 由 8KB 上调）
const BILI_AUDIO_M4S_MAX = 20 * 1024 * 1024; // B 站 m4s 音频流通常 < 20MB
const MAX_RESOURCES_PER_TAB = 500;      // 每标签页最大资源数（防内存泄漏，对齐猫抓 tabFingerprints 上限）

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

// 粗判：URL 是否带媒体扩展名（含 ico/svg，供"快速跳过非媒体"用）
function isMediaUrl(url) {
  try {
    return MEDIA_EXT_RE.test(new URL(url).pathname);
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

// 明确非媒体的扩展名黑名单（css/html/json/字体/脚本/文档等）
function isNonMediaUrl(url) {
  try {
    return NON_MEDIA_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// 明确非媒体的 content-type
function isNonMediaMime(mime) {
  return NON_MEDIA_MIME_RE.test(mime || '');
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
 * 以及 DASH/分片 Range 参数（bytestart/byterange 等，让同一资源的分片收敛成一条）。
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
    // 去掉 Range/分片参数（参考猫抓对 bytestart 分片的归一化处理）
    const fragDrop = ['bytestart', 'byterange', 'range', 'start', 'end', 'seg', 'segment', 'part'];
    for (const k of fragDrop) {
      if (u.searchParams.has(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 从 content-disposition 响应头解析附件文件名。
 * 修复"URL 无文件名 + 服务端通过 attachment 头下发文件名"的边界场景。
 */
function parseContentDisposition(headers) {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'content-disposition') {
      const v = h.value || '';
      // 优先 RFC 5987：filename*=UTF-8''xxx
      let m = /filename\*=UTF-8''([^;]+)/i.exec(v);
      if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
      // 回退 filename="xxx"
      m = /filename="?([^";]+)"?/i.exec(v);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

/**
 * 资源类型分类。
 * 白名单优先：先按 URL 关键字/扩展名精确归类，再按 MIME 兜底；
 * 两者都不匹配则返回 'unknown'（默认模式过滤，深度模式保留）。
 */
function classify(url, mime) {
  const lower = (url || '').toLowerCase();
  // 流媒体播放列表
  if (STREAM_EXT_RE.test(lower)) return 'stream';
  // 图片扩展名优先于关键字判断：避免 ".../video-rcmd-cover.avif" 这类封面图
  // 因 URL 含 "-video-" 字样被误判为视频（修复垃圾分类）
  if (IMAGE_EXT_RE.test(lower) || /\.(svg|ico)(\?|#|$)/i.test(lower)) return 'image';
  // DASH 音/视轨关键字（media-audio / media-video）
  if (/(media-?audio|-audio-|\/audio\/|_audio_)/.test(lower)) return 'audio';
  if (/(media-?video|-video-|\/video\/|_video_)/.test(lower)) return 'video';
  // 视频扩展名
  if (VIDEO_EXT_RE.test(lower)) return 'video';
  // .ts 歧义消解：mime 明确为视频流（或未知）才视为视频分片；
  // 否则（text/javascript / application/typescript 等）视为脚本 → unknown
  if (/\.ts(\?|#|$)/.test(lower)) {
    if (mime == null) return 'video';
    if (/^video\//i.test(mime)) return 'video';
    return 'unknown';
  }
  // 音频扩展名
  if (AUDIO_EXT_RE.test(lower)) return 'audio';
  // 图片扩展名（含 ico/svg；默认模式下由 isJunkImage 再过滤）
  if (IMAGE_EXT_RE.test(lower) || /\.(svg|ico)(\?|#|$)/i.test(lower)) return 'image';
  // MIME 兜底
  if (/^video\//i.test(mime || '')) return 'video';
  if (/^audio\//i.test(mime || '')) return 'audio';
  if (/^image\//i.test(mime || '')) return 'image';
  if (/(mpegurl|dash\+xml)/i.test(mime || '')) return 'stream';
  return 'unknown';
}

// 网络层图片垃圾过滤（默认模式）
function isJunkImage(url, size) {
  const lower = (url || '').toLowerCase();
  // 显式过滤矢量图标/网站图标文件（svg/ico 基本不是"主要内容图"）
  if (/\.(svg|ico)(\?|#|$)/i.test(lower)) return true;
  if (IMG_JUNK_RE.test(lower)) return true;
  // 头像/logo/icon/head 等装饰片段（按 URL 段匹配，避免误伤正文图）
  if (IMG_DECORATIVE_RE.test(lower)) return true;
  // 头像/logo 专用域名（gravatar 等）
  if (AVATAR_HOST_RE.test(lower)) return true;
  if (IMG_HOST_BLOCKLIST.test(lower)) return true;
  if (size != null && size > 0 && size < MIN_IMAGE_SIZE) return true;
  return false;
}

/**
 * 默认模式统一过滤闸门（白名单优先 + 黑名单补刀 + content-type + 尺寸）。
 * @param {string} type  classify() 结果
 * @param {string} url   资源 URL
 * @param {string} mime  content-type（可为 null）
 * @param {number} size  字节大小（可为 null）
 * @param {string} mode  'default' | 'deep'
 * @returns {boolean} true=保留，false=过滤
 */
function shouldKeepResource(type, url, mime, size, mode) {
  // 深度搜索模式：不过滤（追踪接口在调用方单独过滤）
  if (mode === 'deep') return true;
  // 1) 白名单：类型必须明确为 视频/音频/图片/流媒体，未知类型默认丢弃
  if (type !== 'video' && type !== 'audio' && type !== 'image' && type !== 'stream') return false;
  // 2) 黑名单：明确非媒体扩展名（css/html/json/字体/脚本/文档）
  if (isNonMediaUrl(url)) return false;
  // 3) content-type 校验：响应头明确非媒体（即使 URL 带媒体后缀）
  if (isNonMediaMime(mime)) return false;
  // 4) 图片专用：ico/svg、垃圾关键词、平台黑名单、过小（<50KB）
  if (type === 'image' && isJunkImage(url, size)) return false;
  // 5) 视频/音频片段过滤（过小视为水印/预览片段）
  if (type === 'video') {
    if (size != null && size < MIN_VIDEO_SIZE) return false;
    if (VIDEO_FRAGMENT_HOST.test(url || '')) return false;
  }
  if (type === 'audio' && size != null && size < MIN_AUDIO_SIZE) return false;
  return true;
}
