# 更新日志

> 本文件所有版本按时间**倒序**排列，最新版本永远写在最上方。
> 分类按版本内容使用 ✨ 新增、🔧 优化、🐛 修复、📝 更新等标签。
> 每次发布时，请保证：`CHANGELOG.md 版本号 = git tag 版本号 = manifest.json version`。

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
