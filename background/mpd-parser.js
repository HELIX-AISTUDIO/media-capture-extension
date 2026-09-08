/**
 * ============================================================
 * background/mpd-parser.js
 * DASH / MPD 解析器（被 service-worker.js 通过 importScripts 引入）
 * ------------------------------------------------------------
 * 支持（参考猫抓 mpd 解析器经验）：
 *   1. 解析 Period / AdaptationSet / Representation 层级
 *   2. 提取视频轨与音频轨（contentType / mimeType 判断）
 *   3. BaseURL 相对路径拼接
 *   4. SegmentTemplate + SegmentBase + SegmentList 分片提取
 *   5. 提取 Initialization 段与媒体分片模板
 *
 * 说明：仅解析，不做音视频合并（本次明确不实现）。
 * ============================================================
 */

/**
 * 解析 MPD 文本。
 * @param {string} xmlText MPD 文件内容
 * @param {string} baseUrl MPD 文件自身的绝对 URL
 * @returns {{ representations:Array, segments:Array }}
 */
function parseMpd(xmlText, baseUrl) {
  const result = {
    representations: [], // 各码率音/视频轨
    segments: []         // 可下载的分片 URL（含 init 段）
  };

  if (!xmlText || typeof xmlText !== 'string') return result;

  // 用 DOMParser 解析（MV3 SW 中可用）
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch (e) {
    return result;
  }
  if (!doc || doc.getElementsByTagName('parsererror').length > 0) return result;

  // 全局 BaseURL（MPD 层级）
  const mpdBase = doc.getElementsByTagName('BaseURL')[0];
  const mpdBaseUrl = mpdBase ? resolveUrl(baseUrl, mpdBase.textContent.trim()) : baseUrl;

  // 遍历 Period
  const periods = doc.getElementsByTagName('Period');
  for (let p = 0; p < periods.length; p++) {
    const period = periods[p];
    const periodBase = period.getElementsByTagName('BaseURL')[0];
    const periodBaseUrl = periodBase ? resolveUrl(mpdBaseUrl, periodBase.textContent.trim()) : mpdBaseUrl;

    const adaptationSets = period.getElementsByTagName('AdaptationSet');
    for (let a = 0; a < adaptationSets.length; a++) {
      const as = adaptationSets[a];
      const contentType = as.getAttribute('contentType') || as.getAttribute('mimeType') || '';
      const kind = /audio/i.test(contentType) ? 'audio' : (/video/i.test(contentType) ? 'video' : 'video');

      const reps = as.getElementsByTagName('Representation');
      for (let r = 0; r < reps.length; r++) {
        const rep = reps[r];
        const id = rep.getAttribute('id') || '';
        const mimeType = rep.getAttribute('mimeType') || contentType;
        const codecs = rep.getAttribute('codecs') || '';
        const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
        const width = rep.getAttribute('width') || '';
        const height = rep.getAttribute('height') || '';

        // BaseURL（Representation 层级）
        let repBaseUrl = periodBaseUrl;
        const repBase = rep.getElementsByTagName('BaseURL')[0];
        if (repBase) repBaseUrl = resolveUrl(repBaseUrl, repBase.textContent.trim());

        // SegmentTemplate / SegmentBase / SegmentList
        const segTemplate = rep.getElementsByTagName('SegmentTemplate')[0];
        const segList = rep.getElementsByTagName('SegmentList')[0];

        const info = {
          id,
          kind,
          mimeType,
          codecs,
          bandwidth,
          width,
          height,
          resolution: width && height ? `${width}x${height}` : null,
          initUrl: null,
          mediaUrlTemplate: null,
          segmentCount: 0,
          segmentUrls: []
        };

        if (segTemplate) {
          const init = segTemplate.getAttribute('initialization');
          const media = segTemplate.getAttribute('media');
          const duration = parseInt(segTemplate.getAttribute('duration') || '0', 10);
          const timescale = parseInt(segTemplate.getAttribute('timescale') || '1', 10);
          const startNumber = parseInt(segTemplate.getAttribute('startNumber') || '1', 10);
          const segTimeline = segTemplate.getElementsByTagName('S');

          if (init) info.initUrl = resolveUrl(repBaseUrl, init);
          if (media) {
            info.mediaUrlTemplate = resolveUrl(repBaseUrl, media);
            // 生成分片 URL（使用 $Number$ 替换）
            let count = 0;
            if (segTimeline.length > 0) {
              // SegmentTimeline 模式：累加 S 的 r 属性
              for (let s = 0; s < segTimeline.length; s++) {
                const seg = segTimeline[s];
                const r = parseInt(seg.getAttribute('r') || '0', 10);
                count += r + 1;
              }
            } else if (duration && timescale) {
              // 简单 duration 模式：无法确知总数，只记录模板
              count = 0;
            }
            info.segmentCount = count;
            // 生成最多 500 个分片 URL（防无限）
            const maxGen = count > 0 ? Math.min(count, 500) : 0;
            for (let n = 0; n < maxGen; n++) {
              const num = startNumber + n;
              const url = info.mediaUrlTemplate.replace(/\$Number%05d\$/g, String(num).padStart(5, '0'))
                .replace(/\$Number\$/g, String(num))
                .replace(/\$RepresentationID\$/g, id)
                .replace(/\$Bandwidth\$/g, String(bandwidth));
              info.segmentUrls.push(url);
            }
          }
        } else if (segList) {
          const init = segList.getElementsByTagName('Initialization')[0];
          if (init) {
            const srcRange = init.getAttribute('sourceURL') || init.getAttribute('range');
            if (init.getAttribute('sourceURL')) info.initUrl = resolveUrl(repBaseUrl, init.getAttribute('sourceURL'));
          }
          const segmentUrls = segList.getElementsByTagName('SegmentURL');
          for (let s = 0; s < segmentUrls.length; s++) {
            const mediaAttr = segmentUrls[s].getAttribute('media');
            if (mediaAttr) info.segmentUrls.push(resolveUrl(repBaseUrl, mediaAttr));
          }
        }

        result.representations.push(info);
        // 汇总所有可下载分片
        if (info.initUrl) result.segments.push({ url: info.initUrl, kind: info.kind, init: true });
        info.segmentUrls.forEach((u) => result.segments.push({ url: u, kind: info.kind, init: false }));
      }
    }
  }

  return result;
}
