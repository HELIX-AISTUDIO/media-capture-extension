# 网页媒体抓取器（Media Catch）— Edge 扩展

一个适配 **Microsoft Edge** 的 **Manifest V3** 浏览器扩展，参考开源项目
[猫抓 cat-catch](https://github.com/xifangczy/cat-catch) 的成熟架构**重新工程化实现**：
网络抓包 + DOM 深度搜索 + 缓存捕捉三合一，自动识别并抓取页面中的
**视频 / 图片 / 音频 / 流媒体**（m3u8、mpd、mp4、webm、jpg、png、gif 等），
在弹窗中展示列表，支持筛选、排序、预览、复制、下载、批量复制，以及 m3u8 / DASH 解析。

> 本项目为**重新实现**，只借鉴架构与多年迭代踩坑经验，未复制猫抓完整源码。

---

## 主要功能

- **双捕获体系 + 缓存捕捉**：非阻塞 `webRequest` 网络抓包 + DOM 深度搜索 + `performance` 缓存捕捉，减少漏抓。
- **完整解析体系**：普通资源直列；M3U8 解析器（嵌套多码率 / 分片去重 / 密钥识别）；DASH/MPD 解析器（音视轨分类 / 分片提取）。
- **弹窗界面**：类型 / 关键词 / 大小区间表达式筛选，排序，批量复制，预览大窗口（视频直接播放）。
- **持久化**：`chrome.storage.session` 存储，解决 Service Worker 休眠丢数据。

---

## Edge 手动安装步骤（开发者模式）

1. 地址栏输入并回车：`edge://extensions`
2. 打开右上角（或左下角）**「开发人员模式」** 开关
3. 点击 **「加载解压缩的扩展」** → 选中本项目根目录（含 `manifest.json` 的那一层）
4. 加载成功后工具栏出现扩展图标
5. 打开含视频 / 图片的网页 → 点击工具栏图标查看资源列表

> 修改代码后，回到 `edge://extensions` 点扩展卡片上的「重新加载」(↻) 生效。

---

## 已知限制

1. **DRM 加密视频无法抓取**：Netflix / Disney+ 等 EME/Widevine 流无法获取明文，本扩展不做解密。
2. **m3u8 / DASH 不合并**：解析器只列出分片，不做 ffmpeg 合并下载。
3. **DASH 分离流**：视频流（`.m4s`）本身无音轨，需合并音频流才是完整成片。
4. **CORS / Referer 防盗链**：下载可能失败，可用「打开」按钮在新标签页右键另存兜底。
5. **直播流**：`.flv` / RTMP 拉流不可下载，已过滤。
6. **版权与合规**：仅用于学习与个人合法用途，使用者自负法律责任。

---

## 权限说明（最小化原则）

| 权限 | 用途 |
| --- | --- |
| `webRequest` | 非阻塞观察网络请求（MV3 下唯一合规的「收集资源列表」路径） |
| `downloads` | 触发浏览器下载 |
| `storage` | `chrome.storage.session` 持久化资源列表 |
| `host_permissions: <all_urls>` | 让 webRequest 观察到 CDN 等第三方域名媒体 |

---

## 项目目录结构

```
edge_media_catch_ext/
├── manifest.json                 # 扩展清单（MV3，权限最小化）
├── background/
│   ├── service-worker.js         # 后台 SW：非阻塞 webRequest + storage 持久化 + 消息路由
│   ├── media-parser.js           # 媒体正则库 + 分类 + 去重 + 安全文件名
│   ├── m3u8-parser.js            # M3U8 解析器
│   └── mpd-parser.js             # DASH/MPD 解析器
├── content/
│   └── content.js                # 内容脚本：DOM 扫描 + 深度搜索 + 缓存捕捉
├── popup/
│   ├── popup.html                # 弹窗结构
│   ├── popup.css                 # 弹窗样式
│   └── popup.js                  # 弹窗逻辑：筛选/排序/预览/解析/批量复制
├── icons/                        # icon16/48/128.png
├── tools/
│   └── generate_icons.py         # 图标生成脚本（纯 Python 标准库）
├── CHANGELOG.md                  # 更新日志（最新版本在最上方）
└── README.md
```

---

## 文档链接

- 猫抓官方文档：<https://cat-catch.94cat.com/docs/install>
- 猫抓源码仓库：<https://github.com/xifangczy/cat-catch>
- 猫抓更新日志（本项目的 CHANGELOG 格式参考）：<https://github.com/xifangczy/cat-catch/blob/master/CHANGELOG.md>
- 本项目更新日志：[CHANGELOG.md](./CHANGELOG.md)

---

## 与猫抓对比 + 下一版本迭代清单

| 能力 | 猫抓 | 本扩展 |
| --- | --- | --- |
| 网络拦截 | webRequest + DevTools + debugger | 非阻塞 webRequest |
| 深度搜索 | 完整（密钥/一次性URL/playlist） | 精简版（script 文本扫描） |
| 缓存捕捉 | 完整（从头捕获） | performance 资源时间线 |
| m3u8/mpd 解析 | 完整 + 合并下载 | 解析分片（不合并） |
| 自定义规则 / DevTools | 支持 | 未实现 |
| SW 持久化 | storage.session | storage.session ✅ |

**下一版本迭代清单**：
1. 接入 `m3u8dl://` 自定义协议，唤起本地下载工具（N_m3u8DL-CLI）。
2. 在线 ffmpeg 分片合并（可选后端）。
3. DevTools 面板深度捕获。
4. 自定义域名 / 扩展名 / 正则规则与屏蔽列表。
5. 请求头透传（Referer/Cookie）以解决更多防盗链。
6. 资源导出 JSON/CSV。
7. 深色模式。
