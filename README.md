# 网页媒体抓取器（Media Catch）— Edge 扩展

一个适配 **Microsoft Edge** 的 **Manifest V3** 浏览器扩展：
网络抓包 + DOM 深度搜索 + 缓存捕捉三合一，自动识别并抓取页面中的
**视频 / 图片 / 音频 / 流媒体**（m3u8、mpd、mp4、webm、jpg、png、gif 等），
在弹窗中展示列表，支持筛选、排序、预览、复制、下载、批量复制，以及 m3u8 / DASH 解析。

---

## 主要功能

- **双捕获体系 + 缓存捕捉**：非阻塞 `webRequest` 网络抓包 + DOM 深度搜索 + `performance` 缓存捕捉，减少漏抓。
- **完整解析体系**：普通资源直列；M3U8 解析器（嵌套多码率 / 分片去重 / 密钥识别）；DASH/MPD 解析器（音视轨分类 / 分片提取）。
- **鉴权头支持**：捕获 Referer / Cookie / Authorization / `x-*` 等鉴权头，弹窗标注「🔒 鉴权」，可「复制为 curl」；下载与预览自动携带。
- **规则可配置（options 页）**：扩展名 / MIME / 自定义正则 / URL 黑白名单四张表，保存即生效。**全部留空 = 与默认行为完全一致**。
- **弹窗界面**：类型 / 关键词 / 大小区间表达式筛选，排序，预览大窗口（视频直接播放）。
- **抓取模式**：默认模式（过滤头像 / 图标 / svg / ico 等噪音）与深度搜索模式（全量抓取 + MAIN world 深搜）一键切换。
- **下载增强**：失败自动回退 Blob 通道重试；`saveAs` 默认关闭；文件名模板（`${title}`/`${date}` 等，支持子目录）；分片批量下载与 `.m3u8` / URL 列表导出（**不合并**）。
- **效率工具**：快捷键与右键菜单、按标签页自动下载（串行 + 上限 50 防护）、导出当前筛选结果、aria2 RPC 推送、对外只读接口。
- **面板形态**：弹窗 + **侧边栏**（常驻）；媒体查看器内置倍速 / 画中画 / 截图控制。
- **SW 生命周期健壮性**：`storage.session` 持久化 + `alarms` 定时唤醒 + `webNavigation` 导航唤醒 + `onConnect` 长连接保活，解决 Service Worker 休眠导致抓取中断。
- **多 Tab 状态管理**：按 tab 分桶存储，导航刷新自动清理，关闭 tab 自动回收，避免数据残留错乱。

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
| `storage` | `storage.session` 持久化资源列表 + `storage.sync` 存规则 + `storage.local` 存偏好 |
| `alarms` | 定时唤醒 SW，重新注册监听器 + 回收孤儿数据 |
| `webNavigation` | 导航事件唤醒 SW + 主框架导航时清理对应 tab 数据 |
| `declarativeNetRequest` | 会话规则注入 Referer / Cookie 等请求头（预览与下载防盗链） |
| `contextMenus` | 右键菜单（清空本页 / 切换深度模式 / 暂停抓取 / 下载此图片） |
| `scripting` | 仅深度搜索模式下注入 MAIN world 脚本（`js/injected-search.js`），用于发现动态拼接的媒体 URL |
| `sidePanel` | 侧边栏面板（与弹窗共用 `popup.html`，可从浏览器侧边栏常驻打开） |
| `tabCapture` | 标签页录制：把**已渲染的**标签页画面与声音录成 `.webm`（需用户主动点击开始；录制全程在本机完成，媒体数据不离开本机） |
| `host_permissions: <all_urls>` | 让 webRequest 观察到 CDN 等第三方域名媒体 |

> `minimum_chrome_version: 114`（`scripting.executeScript` 的 `world:'MAIN'` 需 111+，侧边栏需 114+）。

---

## 项目目录结构

参考猫抓 [cat-catch](https://github.com/xifangczy/cat-catch) 的短目录风格整理：

```
edge_media_catch_ext/
├── manifest.json                 # 扩展清单（MV3，权限最小化）
├── popup.html                    # 弹窗页面（同时作为侧边栏 side_panel）
├── viewer.html                   # 媒体查看器页面
├── recorder.html                 # 标签页录制页面
├── options.html                  # 规则设置页（四张规则表）
├── _locales/                     # 国际化语言包（zh_CN 默认 / en）
├── css/
│   └── popup.css                 # 弹窗样式
├── js/
│   ├── background.js             # 后台 Service Worker：非阻塞 webRequest + storage 持久化 + 消息路由
│   ├── media-parser.js           # 媒体正则库 + 分类 + 去重 + 安全文件名 + 用户规则引擎
│   ├── m3u8-parser.js            # M3U8 解析器
│   ├── mpd-parser.js             # DASH/MPD 解析器
│   ├── content.js                # 内容脚本：DOM 扫描 + 深度搜索 + 缓存捕捉 + MAIN world 桥接
│   ├── injected-search.js        # 深度模式注入脚本（MAIN world）：钩 fetch/XHR 发现媒体 URL
│   ├── i18n.js                   # 轻量本地化器（中文原文即兜底）
│   ├── popup.js                  # 弹窗逻辑：筛选/排序/预览/解析/导出/批量下载
│   ├── options.js                # 规则设置页逻辑
│   ├── viewer.js                 # 查看器逻辑：鉴权头注入 + 内嵌播放 + Blob 下载通道
│   ├── recorder.js               # 标签页录制逻辑（tabCapture → MediaRecorder → .webm）
│   └── utils/
│       └── generate_icons.py     # 图标生成脚本（纯 Python 标准库）
├── img/                          # 扩展图标 icon16/48/128.png + gray16/48/128.png
├── lib/                          # 第三方库目录（当前为空，供后续按需引入）
├── docs/
│   ├── LEARNINGS.md              # 猫抓源码学习沉淀
│   ├── PROJECT_ARCH.md           # 项目目录结构与架构说明
│   └── yt-dlp-bypass/            # 【知识备份·未启用】YouTube 页面解析旁路方案（见该目录 README）
├── CHANGELOG.md                  # 更新日志（最新版本在最上方）
└── README.md
```

---

## 下一版本迭代清单

1. 接入 `m3u8dl://` 自定义协议，唤起本地下载工具（N_m3u8DL-CLI）。
2. DevTools 面板深度捕获。
3. 资源导出 JSON / CSV。
4. 深色模式。

> 🔴 红线（**永不采用**）：在线 ffmpeg / ffmpeg.wasm 分片合并；图片网格面板。
>
> 已完成并移出本清单：自定义域名 / 扩展名 / 正则规则与屏蔽列表（v0.2.6 起由 options 页提供）；请求头透传（Referer / Cookie，v0.3.x 起由 DNR 注入实现）。

---

## 版权与合规声明

**本扩展仅嗅探并保存网页中公开可访问、未加密的媒体资源。**

- 不解析加密流（DRM / Widevine / EME 加密视频无法抓取）；
- 不绕过任何技术保护措施（防盗链、加密、鉴权）；
- 不提供任何"破解""去版权""绕过付费"能力。

**使用条款：**

1. 本扩展抓取的对象仅限于网页中**公开可访问且未加密**的媒体资源；
2. 下载内容仅供**个人学习与研究**使用；
3. 用户须自行确保对下载内容的使用符合《中华人民共和国著作权法》及所在司法管辖区的法律规定；
4. 因用户使用下载内容产生的任何版权纠纷，由用户自行承担全部法律责任，与开发者及本扩展无关；
5. 禁止将本扩展用于任何商业分发、盗版传播或其他侵权用途；
6. 本项目仅为个人学习开发（MIT License），不保证持续可用，不承担任何因使用产生的间接损失。

**隐私政策：** 本扩展不收集、不传输、不上传任何个人数据，详见 [PRIVACY.md](./PRIVACY.md)。

---

## 反馈与贡献

欢迎使用并反馈问题，你的建议是项目优化的动力：

- **🐛 Bug 反馈**：前往 [Issues](https://github.com/HELIX-AISTUDIO/media-capture-extension/issues) 选择「Bug 反馈」模板提交，请附浏览器版本、扩展版本与复现步骤。
- **💡 功能建议**：前往 [Issues](https://github.com/HELIX-AISTUDIO/media-capture-extension/issues) 选择「功能建议」模板提交，描述使用场景与期望效果。
- **📦 最新版本**：在 [Releases](https://github.com/HELIX-AISTUDIO/media-capture-extension/releases) 下载 zip 包，解压后按上方「手动安装步骤」加载。

> 提交前建议先浏览已有 Issues，避免重复；反馈时尽量附截图或控制台报错，能显著加快定位。

---

## 作者

**HELIX AI STUDIO**（[@HELIX-AISTUDIO](https://github.com/HELIX-AISTUDIO)）

AI Studio · AIGC 短剧与动画创作者 · 全栈开发者
探索 AI 视频生成、提示词工程与自定义工具开发。

- GitHub：<https://github.com/HELIX-AISTUDIO>
- 项目仓库：<https://github.com/HELIX-AISTUDIO/media-capture-extension>
