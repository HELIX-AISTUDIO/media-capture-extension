# 项目架构与目录结构 · PROJECT_ARCH

> 本文档记录 `edge_media_catch_ext` 的目录布局与模块职责，随目录重构同步更新。

---

## 设计原则

1. **短目录命名**：参考猫抓 cat-catch 风格，顶层目录使用 `css` / `js` / `img` / `lib` / `docs` 等短命名，避免长文件夹名。
2. **页面入口扁平化**：所有 HTML 页面（`popup.html` / `viewer.html` 等）直接放在根目录，脚本/样式按类型归入 `js/` / `css/`。
3. **docs 只放文档**：`docs/` 仅存放项目知识库文档，不包含任何业务代码。
4. **lib 预留给第三方库**：`lib/` 用于放置 hls.js、mux.js 等第三方库（当前为空，按需引入）。
5. **业务逻辑不动**：目录整理仅做文件移动、重命名与引用路径修正，不修改嗅探/过滤/媒体抓取业务逻辑。

---

## 目录结构

```
edge_media_catch_ext/
├── manifest.json                 # 扩展清单（MV3，权限最小化）
├── popup.html                    # 弹窗页面入口
├── viewer.html                   # 媒体查看器页面入口
├── css/                          # 样式文件
│   └── popup.css                 # 弹窗样式
├── js/                           # 业务脚本
│   ├── background.js             # Service Worker：非阻塞 webRequest + storage 持久化 + 消息路由
│   ├── media-parser.js           # 媒体正则库 + 分类 + 去重 + 安全文件名
│   ├── m3u8-parser.js            # M3U8 解析器
│   ├── mpd-parser.js             # DASH/MPD 解析器
│   ├── content.js                # 内容脚本：DOM 扫描 + 深度搜索 + 缓存捕捉
│   ├── popup.js                  # 弹窗逻辑：筛选/排序/预览/解析/批量复制
│   ├── viewer.js                 # 查看器逻辑：Referer 注入 + 内嵌播放 + Blob 下载通道
│   └── utils/                    # 工具脚本子目录
│       └── generate_icons.py     # 图标生成脚本（纯 Python 标准库）
├── img/                          # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/                          # 第三方库目录（当前为空）
├── docs/                         # 项目知识库文档（仅文档，无业务代码）
│   ├── LEARNINGS.md              # 猫抓源码学习沉淀
│   └── PROJECT_ARCH.md           # 本文件：目录结构与架构说明
├── CHANGELOG.md                  # 更新日志
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

### `js/utils/generate_icons.py`
- 图标生成脚本，纯 Python 标准库，无第三方依赖。

---

## 关键约束（红线）

- 严格 Manifest V3：非阻塞 `webRequest`，不使用 MV2 废弃接口。
- 不修改嗅探、过滤、媒体抓取业务逻辑；目录整理只做文件移动与路径修正。
- DASH m4s 音视频分离流不做在线 ffmpeg.wasm 合并，仅提示文案。
- 已永久否决方案：在线 ffmpeg 合并、图片网格面板。
