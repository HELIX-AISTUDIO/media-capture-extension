# YouTube 等加密流媒体「页面解析旁路」知识备份 · yt-dlp-bypass

> **状态：📦 仅知识备份，尚未开发、未启用，不影响现有任何运行逻辑。**
> 用途：记录对 Ghost-Downloader-3（下称 GD3）下载机制的源码级学习结论，沉淀「为什么扩展抓不到
> YouTube / 为什么要换一种范式 / 未来怎么以最小侵入接入」的完整方案，供后续大版本更新时直接取用。
> 建立日期：2026-09-10 · **🎯 目标版本：V2.0**（锚点基线：扩展 **v0.3.3**）· 对照 GD3：桌面端 v4.3.5 / 浏览器扩展 v2.2.0。
>
> 本套文档是 **V2.0 大更新**的施工地图：所有代码锚点以 v0.3.3 为基线校准（2026-09-10 grep 复核），
> 行号只作辅助，**以"可搜索的代码特征"为准**。V2.0 开工前请先在 02 文档 §0.2 重跑锚点复核。

---

## 0. 一句话结论

YouTube 这类站点**靠"网络嗅探抓媒体请求"这条路在原理上走不通**；GD3 的做法是**换一条并行通道**：
不抓媒体地址，而是把**当前页面 URL** 交给本地的 **yt-dlp** 去解析、解密、下载、合并。

这条"页面解析旁路"与本项目现有的"请求嗅探主链路"**互不重叠、可以并联**，未来接入时全部是**加法**，
不需要重写现有 webRequest / 解析器 / 下载逻辑。唯一不可省的外部依赖是一个**本地小进程**
（浏览器扩展沙箱内跑不了 yt-dlp / ffmpeg）。

---

## 1. 痛点：为什么本项目现在抓不到 YouTube

本项目是"**媒体请求驱动**"：靠 `chrome.webRequest` 抓到真实媒体文件/分片地址再下载。
这对普通直链 mp4、标准 HLS(m3u8)、DASH(mpd) 有效，但对 YouTube 失效，根因有四：

1. **MSE / SABR 喂流**：YouTube 播放器用 Media Source Extensions，把视频切成小分片通过 XHR/fetch
   喂进 `blob:`/`SourceBuffer` 播放，**页面上不存在一个可直接下载的 .mp4**。能抓到的只有
   `*.googlevideo.com/videoplayback?...&itag=...` 的临时分片地址。
2. **音视频分离（自适应流）**：每个 `itag` 要么是纯视频、要么是纯音频，抓到任意一条都得不到成片，
   必须分别下载视频流和音频流再用 **ffmpeg 合并**。
3. **地址会过期 + 签名限速**：URL 带 `expire` 参数很快失效；`n` 参数是 YouTube 的节流签名，
   **不解密会被限速到约 50 KB/s**。
4. **解密需要执行 YouTube 的混淆 JS**：yt-dlp 要内置/外挂一个 JS 运行时去跑 YouTube 播放器 JS
   才能解出签名与去节流，且 YouTube 持续改版，是长期对抗——不适合、也不可能在扩展里手写维护。

> 此外 MV3 沙箱本身跑不了 Python(yt-dlp)、起不了子进程(ffmpeg)、Service Worker 会休眠，
> 无法承载这种重解析与合并。这与本项目 `docs/LEARNINGS.md` 里"不做在线 ffmpeg.wasm"的结论一致。

GD3 官方扩展对此有一句定性注释（源码 `browser_extension/.../strategies/youtube.ts`）：

> *"YouTube's media URLs are SABR/cipher-gated and not re-downloadable, so we delegate the page
> URL to the desktop's yt-dlp and ignore captured URLs."*
> （YouTube 媒体地址被 SABR/签名门控、不可再下载，因此忽略抓到的 URL，改把页面 URL 交给桌面端 yt-dlp。）

---

## 2. GD3 是怎么做的（双范式并存）

GD3 是**双进程**系统，且内部同时存在两种"拿到任务"的范式：

| 范式 | 触发输入 | 适用 | 在 GD3 中的落点 |
| --- | --- | --- | --- |
| **A. 媒体请求驱动**（=本项目现状） | 抓到的媒体 URL + 请求头快照 | 直链 / m3u8 / dash | http_pack、m3u8_pack 等 |
| **B. 页面 URL 驱动**（YouTube 走这条） | 当前标签页**页面地址** | YouTube 等需要逆向解析的站点 | `yt_dlp_pack` |

- 浏览器扩展只负责"抓 + 遥控"，通过本地 WebSocket(token) 或 **aria2 兼容 JSON-RPC** 把任务发给桌面端。
- 桌面端按 URL 域名路由：命中 `youtube.com / youtu.be` 就交给 `yt_dlp_pack`，由 **yt-dlp 解析出真实
  格式直链** → 选出最佳"纯视频 + 纯音频" → 自带多线程下载器分别下载 → **ffmpeg 合并为 mp4**。
- 私密/年龄/会员/地区受限视频，靠扩展把**当前登录 Cookie** 一并转发给 yt-dlp。

完整源码逐文件拆解见 **[01-GD3源码机制拆解.md](./01-GD3源码机制拆解.md)**。

---

## 3. 未来落地方案：两条可选路线（扩展侧是同一套加法）

未来真正开发时，**扩展侧改动完全相同**，区别只在"本地跑什么引擎"：

### 方案 1 · 自研轻量本地助手（推荐作为最终形态）
- 新增一个极薄本地进程（推荐 Node，仅用内置模块、零 npm 依赖；或 Python/Go）。
- 它在 `127.0.0.1` 起一个小 HTTP 服务，扩展 POST 页面 URL，它去调随包分发的
  **`yt-dlp.exe`（解析+解密+下载）+ `ffmpeg.exe`（合并）**，并回传进度。
- 优点：轻、可控、品牌/下载目录都是自己的；yt-dlp 上游跟进 YouTube 改版，只需定期替换 exe。
- 官方 `yt-dlp.exe` 自带 JS 解释器，开箱即可解 n 参数限速，**无需像 GD3 那样额外带 QuickJS**。

### 方案 2 · 直接借 GD3 当本地引擎（最快验证，零引擎开发）
- GD3 内置 **aria2 兼容 RPC 服务**（源码默认端口 **16800**、默认关闭、可设 token）。
- 本项目**已经实现了 `sendToAria2`**（background.js），未来只要把 **YouTube 页面 URL**（不是
  googlevideo 链接）按 `aria2.addUri` 发给 GD3，它会自动路由到 yt_dlp_pack。
- 适合半天跑通、先验证"页面 URL + Cookie"整条链路；缺点是依赖完整 GD3（Python+PySide，较重）。

> 建议顺序：**先用方案 2 验证链路 → 再用方案 1 替换为自有引擎**，扩展侧用一个 `mode` 开关切换即可。

---

## 4. 为什么是"加法/旁路"，不会动到现有逻辑（设计原则）

未来接入时严格遵守，避免把两套范式搅在一起：

1. **新增独立模块** `site-resolver.js`（站点命中表 + URL 规整），不写进 media-parser / 各 parser。
2. **新增独立消息分支** `resolvePage`，与现有 `getResources / download / sendToAria2 / parseM3u8…`
   在 `onMessage` 的 switch 里**平级**，不修改既有 case。
3. **popup 只加一张条件卡片**：命中站点表才显示"解析本页"，否则完全是现在的资源列表，UI 互不影响。
4. **顶层一个 if 分流**：命中解析站点 → 走旁路 B；否则 → 走现有嗅探 A。捕获/解析/下载主链路零改动。
5. YouTube 页面即便抓到 googlevideo 链接，也默认隐藏/置后，避免用户误下到"无声单流 / 被限速单流"。

精确到"改哪个文件的哪一段、当前代码长什么样、未来插什么"的**接入点地图**见
**[02-未来接入点与预留设计.md](./02-未来接入点与预留设计.md)**（含 **V2.0 目标**、v0.3.3 基线
**锚点校准对照表**、防漂移的代码特征，以及 V2.0 新增的四条约束：i18n 双语言包补 key、
DNR `purpose` 用途分账、嗅探总开关与旁路联动、弹窗按钮排布与 stream 标签 TBD）。

可直接取用的**全部参考实现代码**（site-resolver、background 分支、popup 卡片、Node 助手、启动脚本）
以代码块形式备份在 **[03-参考实现备份代码.md](./03-参考实现备份代码.md)**（纯文本备份，未放入任何可执行文件，
符合本项目"docs 只放文档"原则）。

---

## 5. 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-GD3源码机制拆解.md](./01-GD3源码机制拆解.md) | GD3 双进程架构、FeaturePack 机制、yt_dlp_pack 五步流程、aria2 兼容服务、扩展侧 external 下发，逐文件源码地图 |
| [02-未来接入点与预留设计.md](./02-未来接入点与预留设计.md) | **V2.0 施工地图**：精确锚点（文件/校准后行号/代码特征/现状代码/插入点）、锚点校准对照表、V2.0 新增约束（i18n/DNR/暂停开关/按钮排布）、数据流、权限、施工顺序、现在即可保持的"预留习惯" |
| [03-参考实现备份代码.md](./03-参考实现备份代码.md) | 方案1/方案2 的完整可粘贴代码（站点判定、background 分支、popup、Node 助手、启动 bat、自测命令） |

---

## 6. 关键事实速查（避免未来重新调研）

- GD3 aria2 兼容 RPC：默认**关闭**，默认端口 **16800**，方法仅 `aria2.addUri` / `aria2.getVersion`，
  token 走 `params[0]="token:xxx"` 或本项目自定义的 `?token=` 解析；`addUri` 支持
  `options.header[] / referer / user-agent / out / dir`，并按 URL 域名自动路由到对应 pack。
- yt-dlp 选格式核心参数：`-f "bv*+ba/b" --merge-output-format mp4`（最佳视频+最佳音频，兜底合并流，最终 mp4）。
- yt-dlp 传 Cookie：`--add-header "Cookie: k=v; k2=v2"`（最简单）或 Netscape `cookies.txt`。
- yt-dlp 解 n 签名/去节流依赖 JS 运行时：**官方 exe 自带**；GD3 因把 yt_dlp 当库 import 才额外带 QuickJS。
- YouTube 输出是音视频分离流，**没有 ffmpeg 无法得到成片**；这是必须带本地进程/二进制的根本原因。
- 本地通信优先 **127.0.0.1 HTTP（轮询进度）**，要双向实时再上 WebSocket；不建议 Native Messaging
  （需写注册表清单、逐机安装，更重，GD3 也因此选了 WebSocket）。
- 扩展连 `127.0.0.1`、读 `tab.url`：本项目已有 `<all_urls>` host 权限，**无需新增 host 权限**；
  读登录 Cookie 才需要补一个 `"cookies"` 权限（公开视频可不要）。
