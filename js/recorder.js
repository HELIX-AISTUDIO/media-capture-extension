/**
 * ============================================================
 * js/recorder.js
 * 标签页录制（P2-6）：把「已渲染的标签页画面与声音」录成 .webm
 * ------------------------------------------------------------
 * 为什么用 tabCapture 而非 <video>.captureStream()：
 *   captureStream 对跨域 CDN 视频会因 CORS 污染拿到黑屏，而跨域 CDN
 *   正是本扩展的主场景；tabCapture 捕获的是已渲染输出，不受 CORS 限制。
 *
 * 完整链路（MV3 官方推荐）：
 *   1) chrome.tabCapture.getMediaStreamId({ targetTabId }) → streamId
 *   2) navigator.mediaDevices.getUserMedia({ audio/video: { mandatory:
 *        { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } })
 *   3) 回放捕获到的音频（tabCapture 会“接管”标签页音频，必须回放，
 *      否则录制期间用户听不到声音）
 *   4) new MediaRecorder(stream, { mimeType }) 收集 chunks
 *   5) onstop → Blob → chrome.downloads.download(blob URL)
 *
 * 安全护栏：单次最长 60 分钟、单次最大 2GB，超限自动停止；
 *          页面关闭/刷新时停止录制并释放 stream / AudioContext。
 * ------------------------------------------------------------
 * 说明：本文件顶部为**纯逻辑函数**（无 DOM / chrome 依赖），便于在 Node
 *      里做单元断言；DOM 引导逻辑在 bootRecorder() 内，仅浏览器执行。
 * ============================================================
 */

'use strict';

// ---------- 纯逻辑函数（可在 Node 中直接测试） ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 时长格式化：< 1 小时 → MM:SS；>= 1 小时 → H:MM:SS
function formatDuration(sec) {
  let s = Number(sec);
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${pad2(m)}:${pad2(ss)}`;
}

// 字节数格式化（英文单位，随录制体积显示）
function formatBytes(bytes) {
  const b = Number(bytes);
  if (!isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// mimeType 降级链：vp9,opus → vp8,opus → webm
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

// 逐个测试支持性，返回首个受支持的 mimeType；都不支持返回 ''（交由浏览器默认）
function pickMimeType(isSupported) {
  const fn = (typeof isSupported === 'function') ? isSupported : null;
  for (let i = 0; i < MIME_CANDIDATES.length; i++) {
    const m = MIME_CANDIDATES[i];
    if (!fn) return m;
    try { if (fn(m)) return m; } catch (e) { /* 忽略单个候选的异常，继续 */ }
  }
  return '';
}

// 文件名清洗（与 viewer.js 的 safeName 风格一致）
function safeName(s) {
  return String(s || 'recording')
    .replace(/[\\/:*?"<>|~\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'recording';
}

// 时间戳：YYYYMMDD-HHMMSS
function stamp(date) {
  const d = (date instanceof Date) ? date : new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// 默认文件名：<标题清洗后>_录制_<YYYYMMDD-HHMMSS>.webm
// 注：中缀「录制」为产品规定的固定格式（非界面文案，不做 i18n）。
function buildFileName(title, date) {
  return safeName(title || 'recording') + '_录制_' + stamp(date) + '.webm';
}

// 自动停止阈值
const MAX_MS = 60 * 60 * 1000;                    // 60 分钟
const MAX_BYTES = 2 * 1024 * 1024 * 1024;         // 2GB

// 判断是否应自动停止：返回 'time' | 'size' | null
function shouldAutoStop(elapsedMs, bytes) {
  if (Number(elapsedMs) >= MAX_MS) return 'time';
  if (Number(bytes) >= MAX_BYTES) return 'size';
  return null;
}

// 统计音视频轨道数量，返回如 "video: 1, audio: 1"
function describeTracks(stream) {
  const tracks = (stream && typeof stream.getTracks === 'function') ? stream.getTracks() : [];
  let v = 0, a = 0;
  tracks.forEach((tr) => {
    if (tr && tr.kind === 'video') v++;
    else if (tr && tr.kind === 'audio') a++;
  });
  return 'video: ' + v + ', audio: ' + a;
}

// ---------- DOM 引导（仅浏览器执行） ----------

function bootRecorder() {
  const qs = new URLSearchParams(location.search);
  const tabIdRaw = qs.get('tabId');
  const tabId = (tabIdRaw != null) ? parseInt(tabIdRaw, 10) : NaN;

  const elTabTitle = document.getElementById('tabTitle');
  const elStart = document.getElementById('startBtn');
  const elStop = document.getElementById('stopBtn');
  const elStatus = document.getElementById('status');
  const elTrackInfo = document.getElementById('trackInfo');

  let tabTitle = '';
  let recorder = null;
  let stream = null;
  let audioCtx = null;
  let chunks = [];
  let capturedBytes = 0;
  let timer = null;
  let startTs = 0;
  let mimeType = '';
  let recording = false;
  // 「连接中」锁：recording 要等媒体流就绪后才置位，连接阶段按钮仍可点击，
  // 快速双击会并发起两条流（QA 实测）。用 starting 覆盖「已发起、尚未开始录制」这段窗口。
  let starting = false;
  let finalized = false;
  let stopNote = '';

  function setStatus(text, isError) {
    if (!elStatus) return;
    elStatus.textContent = text;
    if (isError) elStatus.classList.add('error');
    else elStatus.classList.remove('error');
  }

  function setButtons() {
    // 开始按钮：录制中或连接中都禁用（连接中禁用正是防双击并发的关键）
    if (elStart) elStart.disabled = recording || starting;
    if (elStop) elStop.disabled = !recording;
  }

  // 释放媒体流与音频上下文（幂等）
  function stopTracks() {
    if (stream) {
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* ignore */ }
      stream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) { /* ignore */ }
      audioCtx = null;
    }
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // tabId 校验：拿不到则明确报错并禁用开始
  if (!Number.isInteger(tabId) || tabId <= 0) {
    setStatus(t('recorder_err_no_tab', '未指定目标标签页（缺少 tabId 参数）。'), true);
    if (elStart) elStart.disabled = true;
    return;
  }

  // 读取目标标签页标题（用于界面显示与默认文件名；失败要能降级）
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        if (elTabTitle) elTabTitle.textContent = t('recorder_tab_unknown', '（无法读取标签页信息）');
        return;
      }
      tabTitle = tab.title || '';
      if (elTabTitle) elTabTitle.textContent = tabTitle || t('recorder_tab_untitled', '（无标题）');
    });
  } catch (e) {
    if (elTabTitle) elTabTitle.textContent = t('recorder_tab_unknown', '（无法读取标签页信息）');
  }

  // 1) 取 streamId（两级降级链）
  //   ① 优先在扩展页直接调 chrome.tabCapture.getMediaStreamId —— 正常情况下可用且最快；
  //   ② 失败/拿不到则交给后台 SW 再取一次（某些 Chrome 版本要求调用发生在 SW 侧）。
  //   中间失败只 console.warn，不打断用户；两条都失败才 reject。
  function getStreamIdViaSelf(tid) {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tid }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!id) reject(new Error('empty streamId'));
          else resolve(id);
        });
      } catch (e) { reject(e); }
    });
  }

  function getStreamIdViaBackground(tid) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action: 'getTabStreamId', tabId: tid }, (resp) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (resp && resp.ok && resp.streamId) { resolve(resp.streamId); return; }
          reject(new Error((resp && (resp.message || resp.error)) || 'no streamId from background'));
        });
      } catch (e) { reject(e); }
    });
  }

  async function getStreamId(tid) {
    try {
      return await getStreamIdViaSelf(tid);
    } catch (e1) {
      // ① 失败：仅告警，继续走后台兜底
      console.warn('[recorder] 扩展页直取 streamId 失败，改由后台兜底：', String(e1 && e1.message || e1));
    }
    return getStreamIdViaBackground(tid);
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      const elapsed = Date.now() - startTs;
      setStatus(t('recorder_status_recording', '录制中 · 已录 $1 · 已捕获 $2',
        [formatDuration(elapsed / 1000), formatBytes(capturedBytes)]), false);
      const reason = shouldAutoStop(elapsed, capturedBytes);
      if (reason === 'time') {
        stopNote = t('recorder_autostop_time', '已达 60 分钟上限，自动停止录制。');
        stopRecording();
      } else if (reason === 'size') {
        stopNote = t('recorder_autostop_size', '已达 2GB 上限，自动停止录制。');
        stopRecording();
      }
    }, 1000);
  }

  // 收尾：生成 Blob 并保存（幂等，仅执行一次）
  function finalize() {
    if (finalized) return;
    finalized = true;
    const type = (recorder && recorder.mimeType) || mimeType || 'video/webm';
    if (!chunks.length) {
      setStatus(stopNote || t('recorder_err_empty', '未捕获到任何数据，录制失败（可能该标签页无音视频输出）。'), true);
      stopTracks();
      return;
    }
    const blob = new Blob(chunks, { type });
    const url = URL.createObjectURL(blob);
    const filename = buildFileName(tabTitle || 'recording', new Date());
    try {
      chrome.downloads.download({ url, filename, saveAs: false }, () => {
        void chrome.runtime.lastError; // 下载面板被关闭等场景属正常
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      });
      const savedMsg = t('recorder_status_saved', '已保存：$1', [filename]);
      setStatus(stopNote ? (stopNote + ' ' + savedMsg) : savedMsg, false);
    } catch (e) {
      setStatus(t('recorder_err_save', '保存失败：$1', [String(e && e.message || e)]), true);
    }
    stopTracks();
  }

  function stopRecording() {
    if (!recording || !recorder) return;
    recording = false;
    stopTimer();
    try {
      if (recorder.state !== 'inactive') recorder.stop(); // 触发 onstop → finalize
      else finalize();
    } catch (e) {
      finalize();
    }
    setButtons();
  }

  async function startRecording() {
    // 守卫：录制中、或上一次「连接中」尚未结束 → 直接忽略（防双击并发取流）
    if (recording || starting) return;
    starting = true;
    setButtons();
    finalized = false;
    stopNote = '';
    chunks = [];
    capturedBytes = 0;
    setStatus(t('recorder_status_connecting', '正在获取标签页媒体流…'), false);
    setButtons();

    // 1) 取 streamId（两级降级：扩展页直取 → 后台 SW 兜底）
    let streamId;
    try {
      streamId = await getStreamId(tabId);
    } catch (e) {
      // 两条路径都失败：报具体原因 + 操作指引（用户多半是没在目标页激活过扩展）
      setStatus(t('recorder_err_streamid', '获取媒体流 ID 失败：$1', [String(e && e.message || e)]) +
        ' ' + t('recorder_streamid_guide', '请先点击扩展图标（或在弹窗里操作一次）后再试；若仍失败，可能是当前页面不支持捕获。'), true);
      starting = false;   // 退出路径①：解锁，允许重试
      setButtons();
      return;
    }

    // 2) getUserMedia（tab 捕获）
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      });
    } catch (e) {
      setStatus(t('recorder_err_getusermedia', '获取标签页媒体流失败：$1。请确认该标签页仍在播放/渲染内容。', [String(e && e.message || e)]), true);
      stopTracks();
      starting = false;   // 退出路径②：解锁，允许重试
      setButtons();
      return;
    }

    // 3) 回放捕获到的音频（否则录制期间用户听不到声音）；失败不致命
    try {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
    } catch (e) { /* ignore */ }

    // 音视频轨道信息行
    if (elTrackInfo) elTrackInfo.textContent = describeTracks(stream);

    // 4) MediaRecorder + mimeType 降级链
    mimeType = pickMimeType((m) => {
      try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m); }
      catch (e) { return false; }
    });
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e1) {
      try { recorder = new MediaRecorder(stream); mimeType = ''; }
      catch (e2) {
        setStatus(t('recorder_err_recorder', '创建录制器失败：$1', [String(e2 && e2.message || e2)]), true);
        stopTracks();
        starting = false;   // 退出路径③：解锁，允许重试
        setButtons();
        return;
      }
    }

    recorder.ondataavailable = (ev) => {
      if (ev && ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
        capturedBytes += ev.data.size;
      }
    };
    recorder.onerror = (ev) => {
      const msg = (ev && ev.error && ev.error.message) || 'recorder error';
      setStatus(t('recorder_err_unknown', '录制失败：$1', [msg]), true);
      recording = false;
      starting = false;   // 兜底解锁：避免任何异常时序让 starting 卡住导致开始按钮永久禁用
      stopTimer();
      stopTracks();
      setButtons();
    };
    recorder.onstop = () => { finalize(); };

    // 捕获流轨道若被外部结束（例如用户停止共享），自动收尾
    try {
      stream.getTracks().forEach((tr) => tr.addEventListener('ended', () => { if (recording) stopRecording(); }));
    } catch (e) { /* ignore */ }

    try {
      recorder.start(1000); // 每秒一个分片：体积可实时显示，也减少内存峰值
    } catch (e) {
      setStatus(t('recorder_err_recorder', '创建录制器失败：$1', [String(e && e.message || e)]), true);
      stopTracks();
      starting = false;   // 退出路径④：解锁，允许重试
      setButtons();
      return;
    }

    // 成功进入录制：连接结束（starting 交棒给 recording），按钮态由 setButtons 统一刷新
    recording = true;
    starting = false;
    startTs = Date.now();
    setButtons();
    startTimer();
    setStatus(t('recorder_status_recording', '录制中 · 已录 $1 · 已捕获 $2',
      [formatDuration(0), formatBytes(0)]), false);
  }

  if (elStart) elStart.addEventListener('click', () => { void startRecording(); });
  if (elStop) elStop.addEventListener('click', stopRecording);

  // 页面关闭 / 刷新：停止录制并释放 stream / AudioContext，避免泄漏
  window.addEventListener('beforeunload', () => {
    stopTimer();
    try { if (recording && recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* ignore */ }
    recording = false;
    stopTracks();
  });

  setButtons();
}

// ---------- 导出（供 Node 单元测试）与引导 ----------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pad2, formatDuration, formatBytes, MIME_CANDIDATES, pickMimeType,
    safeName, stamp, buildFileName, MAX_MS, MAX_BYTES, shouldAutoStop,
    describeTracks, bootRecorder
  };
}

if (typeof document !== 'undefined') {
  // 页面内引导：i18n.js 的 DOMContentLoaded 本地化监听先注册，本函数后执行，
  // 确保本地化先行、随后再由 JS 写入真实数据，避免相互覆盖。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootRecorder);
  } else {
    bootRecorder();
  }
}
