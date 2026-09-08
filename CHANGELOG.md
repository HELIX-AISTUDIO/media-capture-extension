# 更新日志

> 本文件所有版本按时间**倒序**排列，最新版本永远写在最上方。
> 分类固定为三类：✨ 新增、🔧 优化、🐛 修复。
> 每次发布时，请保证：`CHANGELOG.md 版本号 = git tag 版本号 = manifest.json version`。

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
