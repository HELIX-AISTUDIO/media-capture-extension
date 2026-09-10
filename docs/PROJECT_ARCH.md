# 项目架构与目录结构 · PROJECT_ARCH

> 本文档记录 `edge_media_catch_ext` 的目录布局与模块职责，随目录重构同步更新。

---

## 设计原则

1. **短目录命名**：参考猫抓 cat-catch 风格，顶层目录使用 `css` / `js` / `img` / `lib` / `docs` 等短命名，避免长文件夹名。
2. **页面入口扁平化**：所有 HTML 页面（`popup.html` / `viewer.html` 等）直接放在根目录，脚本/样式按类型归入 `js/` / `css/`。
3. **docs 只放文档**：`docs/` 仅存放项目知识库文档，不包含任何业务代码。
4. **lib 预留给第三方库**：`lib/` 当前为空，供后续按需引入第三方库。
5. **业务逻辑不动**：目录整理仅做文件移动、重命名与引用路径修正，不修改嗅探/过滤/媒体抓取业务逻辑。

---

## 目录结构

```
edge_media_catch_ext/
├── manifest.json                 # 扩展清单（MV3，权限最小化）
├── popup.html                    # 弹窗页面入口（同时作为 side_panel）
├── viewer.html                   # 媒体查看器页面入口
├── recorder.html                 # 标签页录制页面入口
├── options.html                  # 规则设置页（四张规则表）
├── _locales/                     # 国际化语言包（Chrome i18n）
│   ├── zh_CN/messages.json       # 简体中文（default_locale）
│   └── en/messages.json          # 英文
├── css/                          # 样式文件
│   └── popup.css                 # 弹窗样式
├── js/                           # 业务脚本
│   ├── background.js             # Service Worker：非阻塞 webRequest + storage 持久化 + 消息路由
│   ├── media-parser.js           # 媒体正则库 + 分类 + 去重 + 安全文件名
│   ├── m3u8-parser.js            # M3U8 解析器
│   ├── mpd-parser.js             # DASH/MPD 解析器
│   ├── content.js                # 内容脚本：DOM 扫描 + 深度搜索 + 缓存捕捉
│   ├── injected-search.js        # 深度模式注入脚本（MAIN world）：钩 fetch/XHR 发现媒体 URL
│   ├── i18n.js                   # 轻量本地化器：t() / localizeDom()（中文原文即兜底）
│   ├── popup.js                  # 弹窗逻辑：筛选/排序/预览/解析/批量复制
│   ├── options.js                # 规则设置页逻辑
│   ├── viewer.js                 # 查看器逻辑：Referer 注入 + 内嵌播放 + Blob 下载通道
│   ├── recorder.js               # 标签页录制逻辑（tabCapture → MediaRecorder → .webm）
│   └── utils/                    # 工具脚本子目录
│       └── generate_icons.py     # 图标生成脚本（纯 Python 标准库）
├── img/                          # 扩展图标
│   ├── icon16.png / icon48.png / icon128.png      # 默认图标
│   └── gray16.png / gray48.png / gray128.png      # 置灰态图标
├── lib/                          # 第三方库目录（当前为空，供后续按需引入）
├── docs/                         # 项目知识库文档（仅文档，无业务代码）
│   ├── LEARNINGS.md              # 猫抓源码学习沉淀
│   └── PROJECT_ARCH.md           # 本文件：目录结构与架构说明
├── CHANGELOG.md                  # 更新日志
├── PRIVACY.md                    # 隐私政策
└── README.md                     # 项目说明
```

---

## 模块职责

### `manifest.json`
- MV3 清单：声明权限、后台 Service Worker、弹窗页面、图标、内容脚本注入。
- 关键路径：
  - `background.service_worker`: `js/background.js`
  - `action.default_popup`: `popup.html`
  - `content_scripts[0].js`: `js/content.js`
  - 图标路径：`img/icon*.png`

### `js/background.js`
- 后台 Service Worker（由 `service-worker.js` 重命名而来）。
- 核心职责：
  - 非阻塞 `chrome.webRequest` 观察（`onBeforeRequest` / `onSendHeaders` / `onResponseStarted` / `onErrorOccurred`）。
  - 资源按 `tabId` 隔离，持久化到 `chrome.storage.session`。
  - 页面导航/SPA 路由切换时清理本 tab 旧资源（`pageEpoch` 页面代数机制）。
  - 消息路由：取列表、清空、下载、批量复制、DOM 上报、解析、模式切换、Referer 规则注入。
  - m3u8 / MPD 解析调度（调用 `js/m3u8-parser.js`、`js/mpd-parser.js`）。

### `js/media-parser.js`
- 媒体解析基础库，被 `background.js` 通过 `importScripts` 引入。
- 提供：扩展名白名单/黑名单、content-type 校验、资源分类 `classify()`、统一过滤闸门 `shouldKeepResource()`、URL 归一化 `normalizeUrl()`、安全文件名 `safeFilename()`、追踪接口识别等。

### `js/m3u8-parser.js` / `js/mpd-parser.js`
- M3U8 与 DASH/MPD 解析器，同样被 `background.js` 引入。
- 负责从播放列表文本中提取多码率、分片、密钥、Representation、SegmentTemplate 等信息。

### `js/content.js`
- 内容脚本，注入到所有页面（含 iframe）。
- 职责：劫持 `HTMLMediaElement.prototype.src`、扫描 `<video>` / `<audio>` / `<img>`、缓存捕捉（`performance.getEntriesByType('resource')`）、深度搜索（`<script>` 文本中的媒体 URL）、SPA 路由切换检测。

### `popup.html` + `css/popup.css` + `js/popup.js`
- 扩展弹窗：资源列表展示、类型/关键词/大小区间筛选、排序、复制、下载、打开、预览、m3u8/mpd 解析。

### `viewer.html` + `js/viewer.js`
- 媒体查看器全屏页面：视频/音频/图片内嵌播放、DNR Referer 注入、Blob 下载通道。

### `js/i18n.js`
- 轻量本地化器：提供全局 `t(key, fallback, subs)` 与 `localizeDom()`，被 `popup.html` / `viewer.html` / `options.html` / `recorder.html` 引入。
- 采用「中文原文即兜底」：HTML 保留中文原文并附加 `data-i18n*` 属性；取不到翻译时回退原文，绝不出现空白或裸 key。

### `js/options.js` + `options.html`
- 规则设置页逻辑：扩展名 / MIME / 自定义正则 / URL 黑白名单四张表的增删改与保存（`storage.sync.userRules`）。**四张表全部留空 = 与默认行为完全一致**。

### `js/recorder.js` + `recorder.html`
- 标签页录制：`chrome.tabCapture.getMediaStreamId` → `getUserMedia`（tab 捕获）→ `AudioContext` 回放音频 → `MediaRecorder` → `downloads` 保存为 `.webm`。
- 纯逻辑函数（时长/体积格式化、文件名生成、mimeType 降级链、自动停止判定）置于文件顶部，便于单元测试。

### `js/injected-search.js`
- 仅在深度搜索模式下注入 MAIN world，钩住 `fetch` / `XMLHttpRequest` 从响应体中被动发现媒体 URL（只观察、不改写响应）。

### `js/utils/generate_icons.py`
- 图标生成脚本，纯 Python 标准库，无第三方依赖。

---

## 关键约束（红线）

- 严格 Manifest V3：非阻塞 `webRequest`，不使用 MV2 废弃接口。
- 不修改嗅探、过滤、媒体抓取业务逻辑；目录整理只做文件移动与路径修正。
- DASH m4s 音视频分离流不做在线 ffmpeg.wasm 合并，仅提示文案。
- 已永久否决方案：在线 ffmpeg 合并、图片网格面板。
