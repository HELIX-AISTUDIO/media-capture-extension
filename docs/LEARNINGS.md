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

---

## 2026-09-09 · 流程沉淀：GitHub 个人资料 → 本地项目同步

**场景**：开发者更新 GitHub 个人资料（显示名 / 邮箱 / bio）后，需同步本地项目署名与 git 身份。

### 同步清单（按优先级）
| 位置 | 何时需要改 | 改法 |
|---|---|---|
| 仓库链接（README/PRIVACY/COMPLIANCE） | 仅当 **用户名** 变了 | `github.com/<用户名>/...` 全局替换 |
| LICENSE 版权行 | 显示名/姓名变化 | `Copyright (c) <年份> <新名字> (<用户名>)` |
| README「作者」章节 | 显示名/bio 变化 | 同步名字 + bio 摘要 + GitHub 链接 |
| `git config user.name / user.email` | 显示名/邮箱变化 | `git config user.name "新名字"`；noreply 邮箱 = `<用户名>@users.noreply.github.com`，用户名不变则邮箱不变 |
| 已打包的 Release zip | README/LICENSE 变化后 | 重新打包（`tar -a -c -f xx.zip --exclude=".git" --exclude="*.zip" <项目目录>`），保持包与仓库一致 |

### 步骤
1. **拉取公开资料（无需认证）**：`curl https://api.github.com/users/<用户名>`，取 `name` / `email`（默认隐藏，为 null）/ `bio` 字段。`updated_at` 可确认是否刚更新。
2. **先判断用户名变没变**：`git push` 仍成功 = 用户名没变，仓库链接全部无需改。
3. 按上表同步 LICENSE / README / git 身份。
4. 重新打包 zip 并交付。
5. commit + push（新 git 身份自动生效于新 commit）。

### 注意
- GitHub API 的 `email` 字段默认返回 null，公开邮箱需用户在 GitHub 设置中显式公开；本地 git 身份邮箱建议用 noreply 格式（避免真实邮箱泄露）。
- 改名后 `git config user.name` 只影响**新 commit**，历史 commit 署名不变（如需改历史用 `git filter-branch`/`rebase`，慎用）。


---

## 2026-09-10 · v0.3.0（猫抓优化清单落地：P0 + P1）

对应猫抓模块：过滤规则体系 / 请求头关联 / 存储与生命周期 / 下载回退 / 命令与右键菜单 / MAIN world 深搜

### 1. 过滤规则「数据驱动」：G.OptionLists 四表 → 本项目规则引擎
- **猫抓**：`init.js` 把 Ext/Type/Regex/blockUrl 四张表放在 `G.OptionLists`，`CheckType`/`CheckExtension`/`operatorCheck`
  统一校验，`storage.onChanged` 热更新重编译正则。
- **本项目落地**：`media-parser.js` 新增 `setUserRules/applyUserRules/operatorCheck/wildcardToRegex/isBlockedPageUrl`，
  存 `storage.sync` 并热更新。**关键差异**：猫抓四表是"唯一真相"（内置值即表内容），本项目采用
  **「空表 = 无意见 = 完全走内置逻辑」** 语义——保证未配置用户升级零影响，比直接表化更安全。
- **不照搬**：猫抓用 jQuery 渲染 options 表；本项目纯原生 JS。

### 2. 请求头关联：DIRECT_INCLUDE_HEADERS → 白名单捕获 + 多 id DNR
- **猫抓**：`background.js` 白名单捕获 referer/cookie/authorization/x-* 等，`function.js setHeaders()` 用 DNR 注入。
- **本项目落地**：新增 `requestAuthHeaders` Map（含熔断）+ `PERSIST_HEADERS_MAX_CHARS=4000` 体积护栏。
- **踩坑修正（猫抓方案的隐患，未照抄）**：猫抓用 `parseInt(requestId)` 作 DNR 规则 id，
  本项目原用固定 `PREVIEW_RULE_ID=1`——两者在并发预览/下载时都会互相覆盖。改为
  **按资源 URL hash 生成稳定 id（2~30000）+ activeRuleIds 集合管理**。

### 3. 存储与生命周期：猫抓的「接受必死 + 自愈」细化到 MV3
- 从猫抓 `save()` 的「每 tab 只持久化 99 条」得到启示，落地为 `PERSIST_MAX_PER_TAB=200` + 字段白名单瘦身。
- 从 `findMedia()` 的 `requestHeaders.size >= 10240` 熔断，落地为 referer / gen / authHeaders 三处 10000 熔断。
- 从 `SetIcon` 只在 debounce 的 `save()` 里调用，落地为「活跃 tab 缓存 + 100ms 节流」消除 IPC 风暴。

### 4. 下载失败回退：errorList → Blob 通道重试
- **猫抓**：下载错误码落在 `errorList` 内则改走自带下载器。
- **本项目落地**：`RETRY_ERROR_CODES` 白名单（只回退 CDN/网络拒绝类，用户取消不回退）+
  `retriedUrls` 同 URL 只回退一次（防「下载风暴」）+ `active:false` 不抢焦点。

### 5. 命令与右键菜单：runCommands 单函数双入口
- **猫抓**：`runCommands(command, data)` 同时被 `commands.onCommand` 与 `contextMenus.onClicked` 调用，维护成本减半。
- **本项目落地**：完全采用该设计。**MV3 差异**：commands 必须写死在 manifest（不能动态注册），
  且未设默认快捷键（避免冲突），用户需在 `edge://extensions/shortcuts` 自行绑定。

### 6. MAIN world 深搜：search.js 的钩子思路（只取 URL 发现子集）
- **猫抓**：`catch-script/search.js`（world:MAIN）hook XHR/fetch/JSON.parse/TextDecoder 等，从运行时数据流捞 URL。
- **本项目落地**：`js/injected-search.js` 只做 **fetch + XHR** 两个钩子，只观察不改写（clone 后读）、
  文本类 + 体积双重护栏、仅深度模式按需注入（`chrome.scripting` + `world:'MAIN'`，需 Chrome/Edge 111+）。
- **🔴 明确不迁移**：猫抓 search.js 里的密钥（isKey）转发、MediaSource/MSE 缓冲拦截、WebRTC 等逻辑一律不做
  （只做 URL 发现，不碰解密/DRM）。

---

## 2026-09-10 · v0.3.2（DNR 规则生命周期：从「单集合」到「按用途分账」）

本节的教训来自独立 QA 用 175 条断言复验后挖出的一个**功能回归**，值得长期记住。

### 问题：一个「看似合理」的清理，把 A 功能的规则清掉了
- 现象：viewer 正在预览防盗链资源时，用户在别处**完成任意一个下载** → 预览的 Referer 规则被一并清除 → 正在预览的资源突然 403。
- 根因：预览与下载**共用一个规则集合**（`activeRuleIds`），而「下载全部结束」的清理动作执行的是「清空全部」。
- 本质：**清理动作的作用域（scope）大于它真正拥有的资源**。一个功能在释放自己的资源时，误删了另一个功能的资源。

### 修法：按用途分账（purpose-scoped accounting）
```
activeRuleIds        // 总集（镜像记录，仅写入；决策不以它为准）
previewRuleIds       // 预览用途持有
downloadRuleIds      // 下载用途持有
```
- `setPreviewRefererRule(url, headers, purpose)` 第三参数标明用途（缺省 `'preview'`）
- 清理时**求差集**：只移除「另一方没在用」的 id —— 同一 id 被两边同时持有（同 URL 既预览又下载）时不能删
- 每个功能的清理函数各清各的：`clearPreviewRefererRule()` / `clearDownloadRules()`
- 单资源失败路径用 `releaseRule(url, purpose)` 精确释放，不误伤同域其它资源

### 另一个坑：失败回滚必须「幂等」
DNR 写入失败时若无条件删除持有记录，会在「同一资源二次写入失败」场景下制造**幽灵规则**——
浏览器侧规则还在，但扩展已不再追踪它，于是任何清理都删不掉它（残留到会话结束）。
修法：发起写入**之前**记录 `alreadyOwned = ownSet.has(id)`，失败时只回滚「本次新增的持有」。

### 未采纳的加固（有意接受，记录以免后人重复踩）
- **不做基于时间的规则清扫**：viewer 放长视频时规则只在 init 设一次，时间清扫会在播放中途清掉规则 → 突然 403。残留窗口（预览被强杀）远比误清更可接受。
- **不改 `requestDomains` 为精确子域**：主域匹配是为了覆盖 CDN 重定向（`upos-sz-mirror` → `mirror-coldetc`），精确子域会让重定向后的请求失去注入而 403。
- **不为极窄并发窗口引入引用计数**：受影响集合只写不读、不参与决策，无功能影响；改动风险高于缺陷本身。

### 一句话总结
> **清理动作的作用域必须等于它真正拥有的资源范围。** 共享一个集合 = 迟早误删；按用途分账 + 失败回滚幂等，是这类「生命周期 + 并发」问题的通用解法。
