# 更新日志

> 本文件所有版本按时间**倒序**排列，最新版本永远写在最上方。
> 分类按版本内容使用 ✨ 新增、🔧 优化、🐛 修复、📝 更新等标签。
> 每次发布时，请保证：`CHANGELOG.md 版本号 = git tag 版本号 = manifest.json version`。

## v0.3.3 2026-09-10

✨ 新增
- **国际化 i18n**：支持 `zh_CN`（默认）与 `en` 两种语言，共 **223 条**界面文案
  - 新增 `_locales/zh_CN/messages.json` + `_locales/en/messages.json`，manifest 增加 `default_locale`，`name`/`description` 改用 `__MSG_*__`
  - 新增 `js/i18n.js` 本地化器：提供 `t(key, fallback)` 与 `localizeDom()`，支持 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-html` 四种绑定
  - 语言自动跟随浏览器界面语言；添加新语言只需在 `_locales/` 下新增一个 `messages.json`
- **标签页录制**（对应猫抓 recorder 能力，独立实现）：把**已渲染的标签页画面与声音**录成 `.webm`
  - 新增 `recorder.html` + `js/recorder.js`；弹窗工具栏新增「录制」入口
  - 技术路径：`chrome.tabCapture.getMediaStreamId` → `getUserMedia(tab)` → **音频回放接回 AudioContext**（否则录制期间听不到声音）→ `MediaRecorder`（vp9→vp8→webm 降级链）→ Blob → `downloads`
  - 安全护栏：单次最长 **60 分钟**、最大 **2GB** 自动停止；页面关闭时释放 stream 与 AudioContext；`track.ended` 自动停止
  - 两条获取 streamId 的路径（扩展页直取 + 后台兜底），失败时给出可操作指引
  - ⚠️ 受版权保护的加密（DRM）内容会录成黑屏，属浏览器限制
- **嗅探总开关**（对应猫抓 issue #1056）：右键扩展图标可快速「暂停 / 恢复嗅探」
  - 右键菜单拆为**两项并按状态切换显示**（「暂停嗅探」/「恢复嗅探」，互斥可见）
  - 暂停时**图标置灰**（`img/gray*.png`），SW 重启后自动重新应用，图标与实际状态始终一致
  - **真停止**：`onBeforeRequest` / `onSendHeaders` / `onResponseStarted` 三处早退（不再空转）；内容脚本同步停扫（轮询 / Mutation / Intersection / 深搜 / MAIN world 桥接全部早退）
  - 弹窗顶部新增**常驻总开关**（状态显示 + 控制），与右键菜单、快捷键状态实时同步；暂停时额外显示横幅说明「新资源不会被记录、已有列表保留」
  - 状态持久化到 `storage.local`，浏览器重启后保持；默认运行
  - 实现取舍：**不注销监听器**（MV3 下 SW 重启会在顶层重新注册，注销状态会丢），改用标志位早退；**不断开观察器**（重连易错），同样用标志位

🔧 优化（安全设计）
- **「中文原文即兜底」**：HTML 保留中文原文、JS 用 `t(key,'中文')` 双参调用；**任何 key 缺失时回退到中文原文**，最坏情况只显示中文，**绝不会出现空白或裸 key**
  - 实测：真实 Chromium 无头渲染四个页面，裸 key 数 = 0、文案丢失 = 0、空元素 = 0
- **暂停期间打开新页面不会漏出资源**：内容脚本的首次扫描延后到状态同步之后执行（否则会抢在状态到达前把整页资源上报，使暂停形同虚设）；恢复时补扫暂停期间新增的资源，**不丢**
- **`addDomResources` 刻意不加暂停早退**：内容脚本在发送前即标记去重集合，若后台静默丢弃会导致该 URL 永久不再上报（永久丢资源），故只允许「暂停瞬间少量在途消息落地」
- HTML 的 id/class/style/结构与 JS 逻辑均未改动（QA 用 git diff 逐行核对：非 i18n 改动行数 = 0）

🐛 修复（独立代码审查 + 三轮 QA 复验发现）
- **`m3u8`/`mpd` 资源在列表里完全不可见（核心功能不可达）**：v0.2.4 精简界面时删掉了「m3u8/mpd」与「全部」两个筛选标签，而 `classify()` 对 `.m3u8/.mpd` 返回 `stream` —— 该类型匹配不上「视频/图片/音频」任何标签，导致 **M3U8/DASH 解析、导出 .m3u8、分片批量下载、aria2 推送整条链路全部不可达**。现补回「流媒体」筛选标签恢复可达性
- **解析 m3u8/mpd 不带 Referer → 防盗链站点必然 403**：`handleParseM3u8/Mpd` 的 fetch 未注入 Referer（而页面 URL 参数早已传递、只是没被使用）。现解析前注入 `purpose='download'` 的会话规则，结束后释放（成功/失败都释放）
- **页面黑白名单对 DOM 上报路径不生效**：网络路径有 `isBlockedPageUrl` 判断，DOM 路径（`addDomResources`）没有 → 加入黑名单的站点仍会从 DOM/缓存入库。现已对齐
- **SW 冷启动 × 弹窗首帧可能显示空列表且不自愈**：`restoreFromStorage` 是异步的，弹窗首次 `getResources` 可能抢在恢复回调前返回。现空列表时自动补拉一次
- **暂停态下打开新页面可能漏出首扫**：内容脚本的首次扫描原为「状态同步超时即乐观执行」，在「已暂停 + SW 冷启动 >300ms」时会先按运行态上报整页资源。现改为超时只告警、由状态回调决定（回调最终一定会到达，不影响正确性）
- **录制快速双击会并发起两条流**：`recording` 守卫在取流之后才置位。现引入「连接中」锁覆盖该窗口，并逐个检查所有退出路径确保解锁
- 清理死代码：`bumpEpoch` / `removeResource`（background）、`isMediaUrl` / `isStreamUrl` / `isMediaMime` / `getUserRules` / `MEDIA_EXT_RE`（media-parser）—— 经全仓库 grep 确认零调用

📝 更新
- 版本号 0.3.2 → 0.3.3
- **权限变更**：新增 `tabCapture`（标签页录制所需）；其余权限、`minimum_chrome_version`、`side_panel`、`options_ui`、`commands` **逐字节未动**
- **文档与实现对齐**：`PRIVACY.md` 权限表补齐为 10 项、补充「鉴权头在本地捕获且仅用于本地请求头注入、绝不上传」与三类存储（local/sync/session）说明、新增录制功能隐私说明；`README.md` 补 `tabCapture` 行、删除与项目红线冲突的迭代项（在线 ffmpeg 合并＝永不采用）；`docs/PROJECT_ARCH.md` 目录树补齐
- 新增暂停态图标 `img/gray16/48/128.png`；`js/utils/generate_icons.py` 改为同时生成运行态与暂停态图标（并修正其目录路径，此前脚本因目录重构会写到错误位置）
- 说明：`js/options.js` 的 aria2 保存异常由「静默忽略」改为「显示保存失败提示」；`js/viewer.js` 倍速按钮新增初始化文案（中文下等价）。两处均为提示增强，不影响功能

## v0.3.2 2026-09-10

🐛 修复（独立 QA 全量复验发现的 3 个 bug + 3 个边界问题）
- **预览的防盗链规则会被「无关下载完成」误清**（功能回归）：预览与下载原本共用一个规则集合，任意下载结束都会清空全部规则 → 正在预览的防盗链资源突然 403。现改为**按用途分账**（预览 / 下载两个独立集合），各清各的账
- **自动下载失败时规则残留**：下载未发起（瞬时错误）时直接返回，规则无人清理且无兜底定时器。现改为精确释放该资源的规则
- **规则重复写入失败产生「幽灵规则」**：同一资源重复触发预览/下载时，若第二次写入失败，会留下「浏览器侧有规则、但扩展不再追踪」的残留（谁都清不掉，直到会话结束）。失败回滚改为**幂等**——只回滚本次新增的持有
- **DNR 规则 id 空间过小**：原 30000 空间在 50 个并发资源时碰撞率约 3.9%（碰撞会导致后者覆盖前者的规则）。id 空间扩至 10^9，实测 10000 个 URL 碰撞数归零
- **文件名模板多段拼接可超 Windows MAX_PATH**：多段模板（如 `${title}/${host}/${fileName}.${ext}`）拼接后可达数百字符导致下载失败。新增总长 240 防护，超限时逐级丢弃靠前的目录段（保留最贴近文件名的部分）
- 三处「注释与实现不符」已对齐（size 未知时按放行处理 / 正则匹配完整 URL / 白名单空列表不生效），**行为未变**——这三处实现本身是「宁可多留、不误删」的安全取向

📝 更新
- 版本号 0.3.1 → 0.3.2（**无新增权限、无接口变化**）

🔍 已知限制（有意接受的取舍）
- **预览页被强制关闭**（未触发 unload）时，其规则会保留到浏览器会话结束。**不做基于时间的清扫**——避免误清长视频预览中途的规则导致播放突然 403；残留影响仅为继续注入「页面自己的 Referer」（与页面正常播放同值），随会话结束消失
- 同一资源在极窄的并发窗口内被重复触发、且后一次规则写入瞬时失败时，理论上可能少记一条内部追踪记录（该集合仅作镜像、不参与任何决策，**无功能影响**）；彻底消除需改为引用计数，评估后认为改动风险高于缺陷本身，暂不实施

## v0.3.1 2026-09-10

✨ 新增
- **文件名模板**（options 页「下载设置」）：支持 `${title}` 页面标题 / `${ext}` 扩展名 / `${date}` / `${time}` / `${fileName}` / `${host}` / `${type}`，可写子目录（自动建文件夹）；**留空 = 保持原文件名**
  - 安全网：模板结果若缺扩展名会自动补上，避免下载出无扩展名的文件
- **侧边栏支持**：注册 `side_panel`（`sidePanel` 权限），可从浏览器侧边栏打开同一面板（常驻不随失焦关闭）；**点扩展图标仍开弹窗，行为不变**
- **媒体查看器控制条**：倍速循环切换（0.5×～3×）/ 画中画 / 截图（跨域视频受浏览器安全限制时会友好提示失败）
- **aria2 集成**：预览面板新增「发送到 aria2」按钮，JSON-RPC `aria2.addUri` 透传 Referer 与已捕获的鉴权头；RPC 地址与密钥在 options 页配置
- **对外只读接口**：`onMessageExternal` 支持其他扩展/脚本以 `{action:'getData', tabId}` 读取资源列表（**刻意不返回鉴权头与 Cookie**，也不接受任何写操作）

🔧 优化
- **导出当前筛选结果**：工具栏新增「导出」按钮，把当前筛选/排序后的列表导出为 `.txt`（每行一条 URL）
- **按需补全缺失大小**：打开预览时对 `size` 未知的资源探测一次 `HEAD`（优先 `content-range` 取分片真实总大小）+ 3 秒超时 + LRU 缓存；🔴 只在后台按需探测，不在 content script 内探测、不批量
- **弹窗筛选增强**：关键词支持 `/正则/flags` 语法（非法正则自动降级为包含匹配）；按时间排序时插入时间分组分隔线

📝 更新
- **权限变更**：新增 `sidePanel`；`minimum_chrome_version` 由 111 提升至 **114**（侧边栏所需）
- 新增 options 页「下载设置」扩展：文件名模板、aria2 RPC 地址
- 原有嗅探、过滤、下载、预览、解析、按 tabId 隔离与页面生命周期清理逻辑保持不变

## v0.3.0 2026-09-10

✨ 新增
- **用户可配置规则体系（options 页）**：四张规则表——扩展名（Ext）/ MIME 类型（Type）/ 自定义正则（Regex）/ URL 黑白名单（blockUrl），支持增删改、启停、正则测试框；规则存 `storage.sync` 并热更新，保存即生效
  - 🔴 安全承诺：**四张表全部留空 = 与旧版行为完全一致**（空表返回"无意见"，完全走内置逻辑），未配置用户升级零影响
- **鉴权头白名单捕获**：除 Referer 外，额外捕获 `cookie / origin / authorization / x-*` 等鉴权头，用于需要登录态的 CDN
  - 弹窗新增「🔒 鉴权」标记 + 预览面板显示鉴权头名称（不显示值）+ **「复制为 curl」**按钮
  - DNR 注入改为**按资源 URL 生成稳定规则 id**，并发预览/下载不再互相覆盖规则
  - 持久化带 4000 字符护栏：超长 cookie 只保留 referer 并告警，防止撑爆 storage
- **下载失败自动回退**：直连下载遇 CDN 拒绝类错误（403/401/网络错误等）时，自动改用「查看器 Blob 通道」重试（同一 URL 仅回退一次，且以非焦点标签打开不打扰）
- **快捷键 + 右键菜单**：`清空本页资源 / 切换深度搜索模式 / 暂停恢复抓取` 三条命令（在 `edge://extensions/shortcuts` 绑定）+ 右键菜单（含「用媒体抓取器下载此图片」）
- **按标签页自动下载**：开关与本页绑定，新抓到的资源自动入队下载；三道护栏——串行 300ms 间隔、单标签页上限 50、标签页关闭即清空
- **分片批量下载与导出**：解析面板新增「导出为 .m3u8 / 导出 URL 列表 / 下载全部分片」；🔴 仅下载与导出，**不做任何合并**（合并请用本地 ffmpeg / N_m3u8DL）
- **深度搜索增强（MAIN world）**：新增 `js/injected-search.js`，仅在深度搜索模式下注入，钩住 `fetch` / `XMLHttpRequest` 从响应体中发现媒体 URL（覆盖「JS 动态拼接的 m3u8」「URL 藏在 JSON 响应里」等静态扫描抓不到的场景）；钩子**只观察、绝不改写**响应

🔧 优化
- **存储与生命周期健壮性**（4 项）：
  - 修复 `requestReferer` / `requestGen` 在提前 return 分支的**内存泄漏**（改为「取完即删」并加 10000 条熔断）
  - 修复 SW 冷启动 `restoreFromStorage` 的**覆盖竞态**（改为合并语义：内存新数据优先，快照只补缺失 key）
  - 修复**徽章 `tabs.query` 风暴**（抓 300 条 = 300 次 IPC → 改为缓存活跃 tab + 100ms 节流）
  - 持久化字段瘦身 + 单标签页上限 200 条 + 配额失败告警
- **修复「页面代数」二次导航起失效的存量 bug**：`clearTabData` 会删除 `pageEpoch` 导致代数恒为 1，第 2 次导航起旧页面残留请求会混入新列表；改为清理前后保留递增代数（1→2→3 单调递增）
- 冷启动徽章竞态收尾：`restoreFinished` 标志确保 store 回填完成后才补刷徽章
- `saveAs` 默认改为 **false**（直接下载到默认目录，不再每次弹「另存为」）；options 页可开启

📝 更新
- **权限变更**：新增 `contextMenus`（右键菜单）与 `scripting`（MAIN world 注入，深搜增强用）；`minimum_chrome_version` 由 104 提升至 **111**（`world:'MAIN'` 所需）
- 新增 `options.html` / `js/options.js`（规则设置页）、`js/injected-search.js`（MAIN world 深搜脚本）
- 弹窗工具栏新增「设置」「自动下载」两个按钮；暂停抓取时显示黄色提示横幅
- 原有嗅探、过滤（默认路径）、下载、预览、M3U8/DASH 解析、按 tabId 隔离与页面生命周期清理逻辑保持不变

## v0.2.5 2026-09-09

🔧 优化（目录结构重构，参考猫抓 cat-catch 的短目录风格）
- 精简顶层目录，全部源码归入短命名文件夹：
  - `background/service-worker.js` → `js/background.js`（同时去掉 `service-worker` 长文件名）
  - `background/media-parser.js` / `m3u8-parser.js` / `mpd-parser.js` → `js/` 下同级
  - `content/content.js` → `js/content.js`
  - `popup/popup.html` → 根目录 `popup.html`；`popup/popup.css` → `css/popup.css`；`popup/popup.js` → `js/popup.js`
  - `viewer/viewer.html` → 根目录 `viewer.html`；`viewer/viewer.js` → `js/viewer.js`
  - `icons/` → `img/`
  - `tools/generate_icons.py` → `js/utils/generate_icons.py`
- 新增 `lib/` 目录（用于放置第三方库，当前为空）
- `docs/` 仅存放项目知识库文档：`LEARNINGS.md` + 新增 `PROJECT_ARCH.md`
- 同步修正所有资源引用路径：`manifest.json`、`popup.html`、`viewer.html`、`js/popup.js`、`README.md`
- **业务源码零改动**：媒体嗅探、过滤规则、资源抓取、M3U8/DASH 解析、下载/预览逻辑全部保持原样

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
