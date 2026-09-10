/**
 * ============================================================
 * js/m3u8-parser.js
 * M3U8 解析器（被 background.js 通过 importScripts 引入）
 * ------------------------------------------------------------
 * 支持（参考猫抓 m3u8 解析器多年迭代经验）：
 *   1. 嵌套 m3u8（#EXT-X-STREAM-INF 多码率播放列表）
 *   2. 相对路径 / 分片 URI 转绝对 URL（baseUrl 拼接）
 *   3. 分片列表解析（#EXTINF + URI）
 *   4. EXT-X-BYTERANGE 子区间分片
 *   5. EXT-X-MAP 初始化段（fMP4）
 *   6. EXT-X-KEY 加密密钥（AES-128）识别
 *   7. 隐藏无效切片（空行/注释/纯空白）
 *   8. 分片去重
 *
 * 说明：仅做"解析"，不做 AES 解密与合并下载（本次明确不实现）。
 * ============================================================
 */

/**
 * 将相对 URL 解析为绝对 URL（基于 baseUrl）。
 */
function resolveUrl(baseUrl, ref) {
  try {
    if (/^https?:\/\//i.test(ref)) return ref;
    return new URL(ref, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * 解析 M3U8 文本。
 * @param {string} text  m3u8 文件内容
 * @param {string} baseUrl m3u8 文件自身的绝对 URL（用于相对路径拼接）
 * @returns {{ playlists:Array, segments:Array, keys:Array, map:string|null, mediaType:string|null }}
 */
function parseM3u8(text, baseUrl) {
  const result = {
    playlists: [],  // 嵌套的变体播放列表（多码率）
    segments: [],   // 媒体分片
    keys: [],       // 加密密钥
    map: null,      // EXT-X-MAP 初始化段
    mediaType: null // 主播放列表类型（'audio' | 'video' | null）
  };

  if (!text || typeof text !== 'string') return result;

  const lines = text.split(/\r?\n/);
  let i = 0;
  let pending = null; // 上一行的 #EXTINF 时长等信息

  const isMaster = /#EXT-X-STREAM-INF/i.test(text);

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;                 // 空行跳过
if (line.startsWith('#')) {
        // ---------- 注释/标签 ----------
        if (/^#EXT-X-STREAM-INF/i.test(line)) {
        // 变体播放列表：下一行是子 m3u8 URL
        const info = {
          bandwidth: 0,
          resolution: null,
          url: null
        };
        const bw = /BANDWIDTH=(\d+)/i.exec(line);
        if (bw) info.bandwidth = parseInt(bw[1], 10);
        const res = /RESOLUTION=(\d+x\d+)/i.exec(line);
        if (res) info.resolution = res[1];
        // 读下一行作为 URL，并消费它（i++ 跳过，避免重复解析）
        if (i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (next && !next.startsWith('#')) {
            const abs = resolveUrl(baseUrl, next);
            if (abs) {
              info.url = abs;
              result.playlists.push(info);
            }
            i++; // 跳过已消费的 URL 行
          }
        }
        pending = null;
        continue;
      }
      if (/^#EXTINF/i.test(line)) {
        // 分片时长：下一行是分片 URI
        // 兼容 BYTERANGE 在 EXTINF 之前出现的写法：保留上一个 pending.byterange
        const m = /([\d.]+)/.exec(line);
        pending = { duration: m ? parseFloat(m[1]) : 0, byterange: pending?.byterange };
        continue;
      }
      if (/^#EXT-X-BYTERANGE/i.test(line)) {
        // 子区间分片：记录 byte range
        // m3u8 标准语法是 BYTERANGE:（冒号），但部分实现写 BYTERANGE=（等号）以兼容；都接受
        const m = /BYTERANGE\s*[:=]\s*([\d@-]+)/i.exec(line);
        if (pending && m) pending.byterange = m[1];
        else if (m) pending = { duration: 0, byterange: m[1] };
        continue;
      }
      if (/^#EXT-X-KEY/i.test(line)) {
        // 加密密钥（AES-128 等）
        const m = /METHOD=([^,\s]+)/i.exec(line);
        const u = /URI="([^"]+)"/i.exec(line);
        if (m) {
          const key = {
            method: m[1].toUpperCase(),
            uri: u ? resolveUrl(baseUrl, u[1]) : null,
            iv: null
          };
          const iv = /IV=(0x[0-9a-fA-F]+)/i.exec(line);
          if (iv) key.iv = iv[1];
          result.keys.push(key);
        }
        continue;
      }
      if (/^#EXT-X-MAP/i.test(line)) {
        const u = /URI="([^"]+)"/i.exec(line);
        if (u) result.map = resolveUrl(baseUrl, u[1]);
        continue;
      }
      if (/^#EXT-X-MEDIA/i.test(line)) {
        // 音轨/字幕分组：TYPE=AUDIO 标识音频流
        const type = /TYPE=([^,\s]+)/i.exec(line);
        if (type && type[1].toUpperCase() === 'AUDIO') {
          result.mediaType = 'audio';
        }
        continue;
      }
      if (/^#EXT-X-INDEPENDENT-SEGMENTS|^#EXT-X-VERSION|^#EXT-X-TARGETDURATION|^#EXT-X-PLAYLIST-TYPE|^#EXT-X-MEDIA-SEQUENCE|^#EXT-X-ALLOW-CACHE|^#EXT-X-START/i.test(line)) {
        continue; // 其它标签忽略
      }
      // 其它未知标签：重置 pending
      pending = null;
      continue;
    } else {
      // ---------- 非 # 开头：分片 URI 或子 m3u8 URI ----------
      const abs = resolveUrl(baseUrl, line);
      if (!abs) continue;
      if (isMaster) {
        // 主播放列表里的 URI 是子 m3u8（若未被 STREAM-INF 处理）
        result.playlists.push({ bandwidth: 0, resolution: null, url: abs });
      } else {
        const seg = { url: abs, duration: pending ? pending.duration : 0 };
        if (pending && pending.byterange) seg.byterange = pending.byterange;
        result.segments.push(seg);
      }
      pending = null;
    }
  }

  // 分片去重（按 URL）
  const seen = new Set();
  result.segments = result.segments.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // 隐藏无效切片：空 URL 已在 resolveUrl 阶段剔除
  result.segments = result.segments.filter((s) => s.url);

  return result;
}
