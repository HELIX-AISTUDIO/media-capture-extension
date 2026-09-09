# 更新日志

> 本文件所有版本按时间**倒序**排列，最新版本永远写在最上方。
> 分类按版本内容使用 ✨ 新增、🔧 优化、🐛 修复、📝 更新等标签。
> 每次发布时，请保证：`CHANGELOG.md 版本号 = git tag 版本号 = manifest.json version`。

## v0.2.4 2026-09-09

✨ 新增
- 弹窗图片「装饰」标记：深度搜索模式下显示的图标/头像/logo 小图，卡片上标注灰色「装饰」标签，明确其默认模式已被自动过滤

🔧 优化
- 弹窗界面精简：删除「m3u8/mpd」「全部」两个分类标签，仅保留【视频｜图片｜音频】3 个分类；删除「批量复制」按钮，仅保留「刷新」「清空」，布局与卡片渲染逻辑不变
- 图片智能过滤（默认模式生效，深度搜索模式关闭）：短边 < 180px 的图片按默认过滤（DOM 图片按自然尺寸，由 120px 上调），优先保留正文内容大图
- 头像/logo 识别：URL 段命中 avatar/logo/icon/head/profile 等装饰片段（按 `./_-` 边界匹配，避免误伤正文图），或命中 gravatar 等头像专用域名，默认模式过滤

📝 更新
- DASH 视频流提示优化：预览卡片明确提示「DASH 视频流无音轨（音视频已分离），请用本地 ffmpeg 合并音视频」
- 在线 ffmpeg.wasm 合并评估结论：**放弃**在扩展内在线合并 DASH 音视频（内存占用 >250MB、扩展页无法提供 COOP/COEP 跨域隔离、需捆绑 ~30MB wasm、易拖垮稳定下载链路），下载/打开底层逻辑保持不变，仅做提示文字优化
- 原有数据模型、webRequest 监听、content script 扫描、下载/打开/复制、按 tabId 隔离与页面生命周期清理、去重逻辑均保持不变

## v0.2.3 2026-09-09

✨ 新增
- 按 Tab 页面生命周期清理：页面刷新、URL 跳转、前进后退、tab 重载（`webNavigation.onCommitted` 主框架导航），以及 SPA 单页路由切换（content script 检测 `pushState`/`replaceState`/`popstate`/`hashchange`），自动清空上一个页面已捕获的全部资源，只保留当前活跃页面本次会话的资源
- 「页面代数」机制：每个 tab 维护 `pageEpoch`，请求在 `onBeforeRequest` 记录发起时的代数、响应时校验，旧页面残留的延迟返回请求被丢弃，不再混入新页面列表
- 白名单优先过滤：默认模式只保留明确属于「视频 / 音频 / 图片 / 流媒体播放列表」的资源，未知类型（扩展名与 content-type 都不明确）默认丢弃，仅深度搜索模式保留
- 「媒体查看器」全屏页面（`viewer/`）：视频/音频点「打开」跳转到扩展查看器内嵌播放（自动注入 Referer），不再打开必 403 的原始地址，交互对齐图片类的「打开即看」；popup 预览失败/跳过卡片新增「在新页面查看」入口
- 防盗链下载通道：视频/音频的「下载」改用「查看器 `fetch`（受 DNR Referer 注入保护）→ Blob → blob URL 另存」，带百分比进度；下载按「原始页面 Referer → 站点主页 Referer → 无 Referer」逐级重试，并内容嗅探防止把 403 错误页存成 .htm

🔧 优化
- 建立非媒体扩展名黑名单（css/html/htm/json/xml/txt/md/pdf/doc/xls/ppt/ttf/otf/woff/woff2/eot/js/ts/jsx 等）与非媒体 content-type 黑名单（text/html、application/json、font/* 等），双重校验
- 图片默认过滤 `.ico`/`.svg` 图标，尺寸阈值由 8KB 上调至 50KB（小于 50KB 的图片默认隐藏）
- `.ts` 歧义消解：按 content-type 区分「视频分片(video/mp2t)」与「TypeScript 源码」
- 新增 `pls`、`tiff` 到流媒体/图片白名单
- 主捕获点由 `onCompleted` 改为 `onResponseStarted`（更早拿到响应头，贴合猫抓捕获时机）
- 移除宽泛的「CDN 域名一律视为媒体」逻辑（此前是「未知素材」过多的主因），改为「扩展名 + content-type + resourceType」综合判定
- 列表读取时二次过滤（双保险）+ 存储版本标记 `storeVersion`：旧版本残留数据自动作废，读取时按当前规则重算类型并修正误标（如封面图 video → image）
- DNR Referer 规则由「精确子域」放宽为「主域匹配」，覆盖 `upos-*` → `mirror-*` 等 CDN 重定向子域

🐛 修复
- 跳转瞬间请求延迟返回、旧页面残留请求混入新页面列表的边界 bug（tabId 隔离 + 页面代数双重防护）
- B 站日志接口（`data.bilibili.com/log/web?...`）混入列表：其查询串内嵌 `.m4s?` 等字样导致缓存捕捉误报，现只对路径（pathname）匹配，并给 DOM 上报路径补上追踪域名黑名单
- 封面图（如 `...-video-rcmd-cover.avif`）因 URL 含 `-video-` 被误判为视频：图片扩展名判定优先于关键字
- `.m4s` 预览被一律跳过、无画面：m4s 是完整 fMP4 轨道可直接播放，改为尝试播放并在失败时降级提示
- 防盗链 CDN（bilivideo.com）预览与下载必 403：MV3 的 `<video>`/`chrome.downloads` 均无法携带 Referer，现用 `declarativeNetRequest` 会话规则注入「抓取时记录的原始 Referer」
- 权限名错误：此前误用 Firefox 的 `declarativeNetRequestWithHostPermissions`（Edge 报 "Permission is unknown" 导致 DNR 从未授权），已改为 Chrome/Edge 通用的 `declarativeNetRequest`
- 下载变成 .htm 且提示"没有权限"：Chromium 已知限制——DNR 对 `chrome.downloads.download` 的请求不生效，改用 Blob 下载通道；另存时 Blob 带正确 MIME，避免扩展名被嗅探改成 .txt/.htm
- 查看器空指针崩溃 `Cannot set properties of null`：autodl 视图无下载按钮时未判空，现已统一判空并在无按钮时自动创建进度状态行
- B 站音频流（DASH 分离的 m4s，标「音频流」）混入「视频」分类：现在只出现在「音频」分类

📝 更新
- 多标签数据互相隔离：清理只作用于当前 tab，绝不全局清空，不影响其他标签页的抓取记录
- popup 类型标签新增「未知」分类（仅深度模式出现），默认模式文案更新为「仅保留视频/音频/图片/流媒体」
- 仅使用 Manifest V3 非阻塞 `webRequest` 观察与 `declarativeNetRequest` 会话规则，未使用任何废弃 MV2 接口

## v0.2.2 2026-09-08

✨ 新增
- SW 生命周期健壮性：`chrome.alarms` 定时唤醒 + `webNavigation` 导航唤醒 + `onConnect` 长连接保活，解决 SW 休眠后 webRequest 监听失效、抓取中断的问题（参考猫抓对抗 MV3 休眠的"接受必死 + 自愈 + 按需保活"思想，独立实现）
- `onSendHeaders` 捕获 Referer 请求头，为防盗链资源识别与下载兜底打基础（参考猫抓 onSendHeaders 关联请求头的做法）
- 从 `content-disposition` 响应头解析附件文件名，修复"URL 无文件名"时的资源命名边界场景

🔧 优化
- 资源去重归一化：`normalizeUrl` 增加 Range/分片参数（bytestart/byterange/range/seg 等）截断，让同一资源的分片/带缓存串请求收敛成一条，减少重复（参考猫抓对 bytestart 分片的归一化思路）
- 多 Tab 状态管理：`webNavigation.onCommitted` 主框架导航即清理该 tab 数据（解决页面刷新/跳转后数据残留错乱），启动时 `tabs.query` 快照回收已关闭 tab 的孤儿数据（参考猫抓 clearRedundant 思想）
- 默认模式过滤强化：显式过滤 `.svg` / `.ico` 矢量图标、tracking/beacon/1x1 像素图等噪音资源
- `webRequest` 增加 `onErrorOccurred` 清理 Referer 暂存，防内存泄漏

🐛 修复
- `resourceType` 兜底：URL 无媒体扩展名、MIME 不明确但浏览器判定为 media/video/audio 的资源，此前漏抓，现正确归类（参考猫抓"后缀 → MIME → 附件名 + resourceType 兜底"四路判定）
- 修复个别 Edge/Chrome 环境 Service Worker 注册失败（`Status code: 15`）：所有顶层 `chrome.*` 监听器注册统一改用安全包装（`safeOn`），单个 API 缺失时仅告警不崩溃，确保核心抓取能力不因某一 API 不可用而整体失效
- 修复扩展重载瞬间 content script 抛出 `Invalid context` 报错：`chrome.runtime.sendMessage` / `onMessage` 增加 try/catch 兜底，避免污染控制台

## v0.2.1 2026-09-08

🐛 修复：防盗链CDN资源弹窗预览播放失败问题，跳过预览播放器，保留下载/打开功能
🐛 修复：顶部刷新按钮失效，点击可清空列表并重新扫描页面媒体
✨ 新增：抓取模式切换【默认模式 / 深度搜索模式】，默认模式过滤头像、ico、svg等垃圾小资源
📝 更新README：移除猫抓相关外部文档链接，补充完整免责声明

## v0.2.0

✨ 新增
- 新增媒体解析库 `media-parser.js`：媒体正则库、类型分类、URL 去重、安全文件名清洗
- 新增 M3U8 解析器 `m3u8-parser.js`：嵌套多码率、相对路径转绝对、分片去重、BYTERANGE、EXT-X-MAP、EXT-X-KEY 密钥识别
- 新增 DASH/MPD 解析器 `mpd-parser.js`：Period/AdaptationSet/Representation、音视轨分类、SegmentTemplate 分片提取
- 弹窗新增筛选系统：类型（视频 / 图片 / 音频 / m3u8-mpd / 全部）、关键词、大小区间表达式（如 `>100KB`、`500-1000MB`）
- 弹窗新增排序（最新 / 最旧 / 按大小）与批量复制全部链接
- 弹窗新增 m3u8 / mpd「解析」面板，可查看分片列表并逐个复制
- 后台新增 `chrome.storage.session` 持久化，解决 Service Worker 休眠导致资源列表丢失
- 内容脚本新增缓存捕捉（`performance` 资源时间线）与 `<script>` 文本深度搜索
- 预览面板升级为居中大窗口：视频直接播放、图片大图、音频播放

🔧 优化
- 图片垃圾过滤：关键词黑名单 + 尺寸阈值 + 平台域名黑名单（抖音 / YouTube / 统计装饰图）
- 屏蔽抖音图片、过滤抖音直播流（`.flv`）与水印预览片段
- B 站 m4s 大小读取 `Content-Range` 响应头，显示真实文件总大小
- 抖音 / B 站 DASH 音轨视轨正确分类（识别 `media-audio` / `media-video` 关键字）
- 网络层限制每标签页资源数量上限 + 轮询节流，避免死循环与高 CPU 占用
- 界面去掉「全部」标签，默认选中「视频」

🐛 修复
- 修复 M3U8 主播放列表 `#EXT-X-STREAM-INF` 下一行 URL 被重复 push 的问题
- 修复 MV3 注入 Referer 头触发 "Unsafe request header name" 报错、导致扩展无法启动的问题
- 修复超长 / 特殊字符文件名（`/` `|` `~` 控制字符）导致下载失败的问题
- 修复重复资源与内存占用过高的问题

---

## v0.1.0

✨ 新增
- 基于 Manifest V3 的 Edge 浏览器扩展框架（`manifest.json`）
- 非阻塞 `chrome.webRequest` 网络请求观察，自动识别视频 / 图片 / 音频资源
- 内容脚本扫描 `<video>` / `<audio>` / `<source>` / `<img>` DOM 资源
- 弹窗资源列表：类型标签、文件大小格式化、URL 展示
- 复制链接 / 触发下载按钮
- 图标生成脚本（纯 Python 标准库，无第三方依赖）
- README 使用说明

---

## 关于版本号

- 初始版本 `v0.1.0`：基础可用版本（网络抓包 + DOM 扫描 + 弹窗列表）。
- 升级版本 `v0.2.0`：对齐猫抓架构（双捕获 + 缓存捕捉 + M3U8/MPD 解析 + 完整筛选预览）。
