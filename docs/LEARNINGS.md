# 猫抓（cat-catch）源码学习沉淀 · LEARNINGS

> 用途：每轮优化任务后，把从猫抓学到的**可迁移设计**按模块沉淀，供本项目长期复用。
> 写法：每条记「猫抓怎么设计 / 解决什么问题 / 哪些可迁移、哪些受 MV3 限制不能照搬」。
> 注意：猫抓是 **MV2**（阻塞式 webRequest + content-script 内 XHR 探测），本项目的可照搬项必须能在 **MV3** 下成立。

---

## 2026-09-09 · v0.2.4（UI 精简 + 图片智能过滤 + 去重护栏）

对应猫抓模块：资源识别与过滤 / 面板 UI 交互 / 去重与存储 / 边界处理（多 tab 并发）

### 1. 按类型设最小尺寸闸门：CheckType + G.Type 配置表
- **猫抓怎么设计**：`CheckType(dataType, dataSize)` 查 `G.Type` 表（每种 MIME → `{state, size}`），
  用 `operatorCheck(size, Obj)` 比对；扩展名走 `CheckExtension(ext, size)`。过滤阈值集中在
  一张配置表里，而非散落 if-else。还支持字符串单位（KB/MB）解析。
- **解决什么**：数据驱动、阈值可配置、过滤逻辑集中易维护；新增类型只改配置不动流程。
- **可迁移（MV3 无限制）**：本项目 `media-parser.js` 用分散常量（`MIN_VIDEO_SIZE` /
  `MIN_IMAGE_SIZE` / `IMG_SHORT_EDGE_MIN`）实现同样思路，已加「参考猫抓 CheckType」注释。
  后续可收敛为一张 `TYPE_LIMITS` 表（按 MIME 分类存最小尺寸 + 开关）。
- **不照搬**：猫抓 G.Type 用字符串单位解析，非关键，可保持本项目「字节常量」写法更直观。

### 2. DOM 图片按自然尺寸过滤小图（naturalWidth / naturalHeight）
- **猫抓怎么设计**：content-script 扫描 `<img>` 时结合自然尺寸、类名/位置判定是否为「内容图」，
  小图/装饰图（logo、头像、1x1 占位）不进列表。
- **解决什么**：反向防垃圾——避免 logo/头像/占位图污染列表（与「防漏抓」同等重要）。
- **可迁移（MV3 可用）**：本项目 v0.2.4 用「短边 < 180px 过滤 DOM 图片」（`IMG_SHORT_EDGE_MIN`）
  + 头像/logo URL 段识别（`IMG_DECORATIVE_RE` 按 `./_-` 边界匹配，避免误伤 `headline` 正文图）
  + 头像专用域名（`AVATAR_HOST_RE`：gravatar 等）。
- **不照搬**：猫抓 MV2 能在 content-script 内用 XHR 主动探测未知图片尺寸；本项目**不改 content
  扫描逻辑**，直接用 DOM 已就绪的 `naturalWidth/Height`（无需 XHR），且尺寸过滤放在 SW 的
  `addDomResources` 分支——更简单、零额外请求、不触碰扫描核心。

### 3. 单 tab 资源上限 + 孤儿回收：tabFingerprints / clearRedundant
- **猫抓怎么设计**：`tabFingerprints` 每 tab 上限 500；`clearRedundant()` 按「当前存活 tab 集合」
  清理已关闭 tab 的残留数据，防止 storage 无限增长。
- **解决什么**：多 tab 并发下内存/CPU 不失控，孤儿数据不泄漏。
- **可迁移（MV3 更关键）**：本项目 `MAX_RESOURCES_PER_TAB=500`（与猫抓一致）+ `sweepOrphanTabs()`
  + `clearTabData()`，已加注释对齐。MV3 下 SW 会休眠/重启，`storage.session` 自愈更依赖此护栏。
- **不照搬**：猫抓用全局 `G` 状态对象；本项目改用 `Map` + `pageEpoch` 页面代数——额外防「跳转瞬间
  延迟请求混入新页面」（猫抓 MV2 无此问题，是本项目的 MV3 增量防护）。

### 4. URL 归一化去重：bytestart / range / seg 截断
- **猫抓怎么设计**：同一资源的不同分片 / 带缓存串的 URL 归一化为同一 key，避免重复条目。
- **解决什么**：DASH/分片流、CDN 签名串变化但主体相同的资源只显示一条。
- **可迁移（MV3 无限制）**：本项目 `normalizeUrl()` 已截断 `bytestart/byterange/range/start/end/
  seg/segment/part` 及缓存参数（v0.2.2 即参考猫抓 bytestart 归一化）。本轮未改动，仍是去重核心。

### 5. 面板卡片来源徽章（DOM / NET）+ 装饰标记
- **猫抓怎么设计**：popup 列表项标注资源来源（页面元素 vs 网络请求），便于判断能否直接下载/预览。
- **可迁移（MV3 可用）**：本项目 popup 已有 `DOM`/`NET` 来源徽章；本轮新增灰色「装饰」徽章——
  深度搜索模式下显示的头像/logo 小图带此标记，明确其「默认模式已自动过滤」。对应猫抓
  「被过滤项仅在全量模式可见」的交互约定。
- **不照搬**：猫抓面板用 jQuery 渲染；本项目纯原生 JS，保持零依赖。

---

## MV3 红线速查（来自猫抓对照，勿照搬）
- 阻塞式 `webRequest`（`<all_urls>` + `onBeforeRequest` 同步改请求/拦响应）：MV3 不可用 → 改用
  `onResponseStarted`/`onSendHeaders` 非阻塞观察 + `declarativeNetRequest` 注入头（防盗链 Referer）。
- content-script 内 `XMLHttpRequest` 主动探测资源：MV3 仍可，但本项目坚持「不主动探测、只读 DOM
  已就绪数据」，避免额外请求与扫描核心改动。
- `chrome.debugger` 协议（猫抓抓某些加密流用）：MV3 扩展页面受限、且违反合规 → 本项目不实现，
  仅提示用户用本地 ffmpeg 合并 DASH 音视频。
