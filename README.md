# iirose 拉黑屏蔽插件（iirose-blacklist）

在 iirose（蔷薇花园）里拉黑某人后：**同一房间里看不到 TA 的头像和消息，私聊消息也不再收到**。

## 需求（2026-09-25 北海提出）

要做的：
1. 屏蔽对方**私聊**消息（不进客户端：无消息、无未读红点、无提示音）
2. 屏蔽对方**群聊/房间**消息 —— 在同一房间里看不到 TA 的**头像**和**发出的消息**
3. 需要能随时拉黑/解除，名单本地保存
4. **（2026-09-25 增补）拉黑只拦新消息，不删已有记录** —— 房间/私聊里对方的历史消息都留着

不做的（v1 范围外）：
- 不隐藏房间成员列表里的头像（只处理聊天区与私聊）
- 不拦截对方进入房间的系统提示（进房公告）—— 待确认是否要加
- 不改动站点自身代码、不上报服务端；纯本地效果，别人看不见你在拉黑谁

## 验收标准（做到什么程度算做完）

| 编号 | 验收项 | 判定方式 |
|------|--------|----------|
| A1 | 拉黑后，对方在房间发的消息**完全不出现**（含头像） | 真机：让对方发 3 条，聊天区 0 条出现 |
| A2 | 拉黑**不删已有记录**：房间/私聊里对方的旧消息都留着，只有新消息进不来 | 真机：拉黑瞬间聊天区旧消息**仍在**；关掉「保留聊天记录」开关才清 |
| A3 | 拉黑后，对方私聊你**收不到**（无消息、无红点、无声音） | 真机：让对方私聊 2 条 |
| A4 | 非黑名单用户的消息**零影响**（内容、顺序、颜色不变） | 单测：帧字节级透传 |
| A5 | 解除拉黑后立即恢复正常 | 真机：解除后再发消息可见 |
| A6 | 名单持久化：刷新页面后仍生效 | 真机：F5 后仍屏蔽 |
| A7 | 不改动站点、不报错：控制台无异常，站点功能正常 | 真机看 console |
| A8 | 有其他插件（如 iiroseForge）同时在用时互不冲突 | 装了 forge 时叠加测试 |

## 技术路线（已调研确认）

协议级丢帧（借鉴 iiroseForge），而非事后删 DOM：

- 站点把 socket 的回调挂在 `window.socket._onmessage`（iiroseForge 的注入代码依赖这一点，已在生产验证）
- 收包字符串按前缀分类：
  - `"`  → 房间消息帧，记录以 `<` 分隔，字段以 `>` 分隔，`[8]` = 用户唯一标识
  - `""` → 私聊消息帧，`[1]` = 发送者 uid
  - `=`  → 弹幕帧，`[7]` = uid
  - 其余（`%` 快照、`~`、`&1{...}` 媒体事件等）原样透传
- 命中黑名单的记录整条剔除；剔除后帧为空则整帧丢弃 → 客户端根本收不到

兜底：DOM 清扫 + MutationObserver，参照 iiroseForge `enableBlacklist()` 的 `.msgholderBox` / `.msg` / `dataset.id = uid_消息id` 结构。**v0.1.11 起它默认只用来隐藏私聊会话条目** —— 已渲染的历史消息不再被删（`keepHistory` 默认开）；关掉该开关才恢复“拉黑瞬间清掉旧消息”的旧行为。uid 优先取头像上的 `data-uid`，`data-id` 只作兜底（它含下划线时会切出假 uid，审查 2026-09-25 实测）。

## 目录

```
src/      插件源码（单文件 IIFE，即成品）
loader.js **给朋友的注入入口**：相对自身目录拉主脚本 + 时间戳绕缓存 + 备用域名兜底（改它才需要重新粘地址）
tests/    子测试：Node 单测（提取 #region CORE / #region STORAGE）+ 浏览器假 socket 联调 harness
          + official-mode.html（官方插件形态：假 Ext.Service，验合规与存储）
          + loader-test.html（loader 本地路径 6 项）+ loader-cdn.html（loader 走 CDN 实链 = 朋友路径）
docs/     调研笔记、审查报告
release/  发布件（推 GitHub / jsdelivr 用）
tools/    发布件同步脚本（node tools/publish.js，--check 只校验）
start.bat 本地托管（自定义 JS 注入调试用）
```

## 发布（改完代码怎么做）

1. `node tools/publish.js` —— 把 `src/iirose-blacklist.js` 同步到 `release/` 与仓库根目录
   （jsdelivr 默认地址取的是仓库根那个文件；以前靠手工复制，忘一次就是"测试全过、朋友拿到旧版"）
2. `node tests/core.test.js` + 浏览器开 `tests/harness.html`，两边全绿（核心单测里已加"发布件必须等于源码"这条，会兜住上面第 1 步忘做）
3. `git add -A && git commit && git push`，然后 `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`
4. 刷 jsdelivr 缓存（分支地址有小时级缓存，tag 地址不用刷）：
   `curl "https://purge.jsdelivr.net/gh/Northseacaviar/iirose-blacklist@main/iirose-blacklist.js"`
5. 复核：拉默认地址与 `@vX.Y.Z` 地址，比对 md5 与 `VERSION` 常量

## 官方插件规范对齐（2026-09-25 站长发布）

站长在论坛发了插件规范（模板即 `Ext.Service.install` 那套；核心两条：**用包壳登记元信息**、**不许私自写 localStorage**）。
现状：**站点没有插件市场，站长明确暂不开放**（怕出事拖累平台）。因此本插件仍以「自定义 JS 注入」为主，但代码已按规范做成**双形态**，将来要提交时不必重构。

| 规范要求 | 本插件的做法 |
|---|---|
| `packageName` = 作者名.应用名（英文数字下划线） | `Northseacaviar.iiroseBlacklist` |
| `package` 元信息 | 全 12 项都提供（源码 `PKG_META`）；其中 `privacy` 公示：**在本地读取聊天/私聊消息内容用于比对黑名单，不修改、不上报、不转发** |
| **不许私自写 localStorage** | 检测到官方运行时 → 走 `instance.settings/removeSettings`（`#region STORAGE` 适配层）；没有运行时 → 才退回 localStorage，且自检行写明「存储：本地注入（localStorage）」 |
| `versionName` + `versionCode`（数字，每次发布递增 1） | `VERSION`（字符串）与 `VERSION_CODE`（数字，当前 15）—— **发版两处都要改** |
| `outerLoad` 公示外部引用 | 空串（单文件、零依赖，不引任何外部 js/css/html） |
| `runAt` | `allReady`（规范推荐默认；收包钩子有 5 秒自愈，晚挂上也不漏） |
| `device` | `*` |
| 不得混淆加密 | 源码可读、未压缩、无打包 |
| `icon` / `cover` / `poster` | **待补**（提交前补 1:1 与 16:9 直链） |

验收方式：`tests/official-mode.html`（用假 `Ext.Service` 专页跑 23 项断言：包名格式、元信息字段齐、存储走 settings、**localStorage 里不出现名单**）。

**已知前提（待站长真开通道时要验）**：官方运行时若把插件装到父页面、而 socket 在 `i.html` iframe 里，还需要一步跨 frame 适配；当前代码假设「插件与其操作的 socket 在同一上下文」。

## 给朋友用（一行地址）

在 iirose 页面里注入（和你注入点歌插件同一套：终端里 `js` 粘贴地址，`extJs` 支持空格分隔多个）：

```
https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js
```

**推荐用这一行（loader）**：它每次都用带时间戳的地址去拉主脚本，所以**以后我发新版，你什么都不用做，刷新页面就是最新版** —— 不用重新粘贴、不用改 `?v=` 数字、不用手动刷 CDN。CDN 拉不到时会自动换备用域名（fastly / gcore）再试一次。

直连主脚本（老用法，仍然可用，但每次更新都要手动绕缓存）：

```
https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/iirose-blacklist.js
```

- loader 自身也有浏览器缓存，但它是稳定文件、基本不需要改动；万一要改，我会顺手 purge。
- 主脚本拉不到时会 console 报 `[拉黑/loader] 加载失败：<地址>` 并依次试备用域名，最后给出可临时直连的地址。
- 注入成功后右下角出现 🚫 悬浮球，控制台打印 `[iirose 拉黑] vX.Y.Z 已加载`；悬浮球可拖动，点击开面板。

## 怎么更新到最新版

| 你的注入方式 | 更新动作 |
|---|---|
| **loader（推荐）** | 什么都不用做，**刷新页面**即最新版（F5；手机下拉刷新/切页也行） |
| 直连 `iirose-blacklist.js` | ① 把地址里 `?v=` 的数字改大（新数字=新 URL，浏览器必须重新下载，CDN 忽略查询串照常返回最新文件）② 在站点的自定义 JS 里**重新粘贴一次**（地址存在 `extJs` 里，不重粘永远只认旧地址） |
| 本地调试（`start.bat`） | 直接 `Ctrl+F5`，本地不经 CDN，没有 7 天缓存 |
| 想固定某个版本 | 用 tag 地址：`.../iirose-blacklist@v0.2.0/iirose-blacklist.js` |

为什么会有"缓存"这回事：浏览器把 jsdelivr 的分支地址缓存 **7 天**（地址一样就不去请求）。loader 用 `?t=时间戳` 让每次 URL 都不同，所以永远拿到新的。

确认更新成功：面板标题显示版本号；或控制台 `__IIROSE_BLACKLIST__.version`；面板自检行还会写明「存储：官方 settings / 本地注入（localStorage）」。

## 使用

1. 本地调试：双击 `start.bat`（起 127.0.0.1:8770），站点内 console → `js -s` 开启 → `js` 粘贴
   `http://127.0.0.1:8770/src/iirose-blacklist.js`
   （`extJs` 支持空格分隔多个地址，可与点歌插件同时注入）
2. 朋友用：注入 jsdelivr 地址（发布后填）
3. 界面：右下角悬浮球 🚫 → 面板；右键房间消息头像 → 直接拉黑
4. 自测：`node tests/core.test.js`（核心逻辑 39 项）、浏览器打开 `tests/harness.html`（联调 43 项）、`tests/official-mode.html`（官方形态 23 项）、`tests/loader-test.html`（loader 本地 6 项）与 `tests/loader-cdn.html`（loader 走 CDN = 朋友路径）
5. 面板点不动时的排障：`__IIROSE_BLACKLIST__._diag.hitTest()` 看控件是否被盖住/尺寸归零；`__IIROSE_BLACKLIST__._diag.watchClick()` 装点击探针，再点一下开关，看控制台打出哪几层事件；`setEnabled/setDebug/setRightClick/setKeepHistory/setHideSession` 是不依赖鼠标的备用入口（非布尔入参一律忽略，绝不会误切到会删记录的方向）；`sweep()` 可手动触发一次全扫，`debugSweep()` 逐行报告 DOM 清扫的判断结果

## 手机（触屏）怎么用

1. **注入**：手机浏览器里用站点终端（`js`）粘地址，或把下面这段存成书签、进站后点一下（书签在触屏上没有右键，长按书签→编辑可以改地址）：

   ```
   javascript:(function(){var f=document.getElementById('mainFrame'),d=f&&f.contentDocument;if(!d){alert('没找到 #mainFrame');return}var s=d.createElement('script');s.src='https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/iirose-blacklist.js';d.body.appendChild(s)})()
   ```
2. **悬浮球**：默认落在视口内（窄屏自动改大小 52px 并靠右下）；可拖动，拖过的位置会记住；视口变化后如果它被挤出屏幕，会自己拉回来。
3. **拉黑**：长按某人头像约 0.55 秒 = 右键菜单（触屏没有右键）；也可以点悬浮球开面板，在「见过的人」里点拉黑。面板里的开关（启用屏蔽 / 调试日志 / 右键菜单 / 保留聊天记录 / 隐藏私聊会话条目）在触屏上点一次即生效。
4. **排查手机端「不显示悬浮窗」**：注入 `mobile-probe.js`（同目录），它会在页面顶部挂一条红色横幅，直接写出：脚本跑在哪个上下文、视口多大、插件有没有落地、悬浮球在哪/被谁盖住、有没有脚本报错、`extJs` 里有没有地址。
   ```
   https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/mobile-probe.js
   ```

## 真机待验证项（README 随代码更新）

- **A3 的私聊历史**：实时私聊帧已确认可丢；若站点在打开私聊窗口时另用 HTTP/快照补历史消息，需要另补清扫路径。
  探针：在真机 console 执行 `__IIROSE_BLACKLIST__.dumpDom()` 看 `ipNodes` / `msgs` 的实际结构。
- **`[ip]` 选择器覆盖面**：若它同时也出现在房间在线成员列表上，则"不隐藏成员列表头像"这句与事实不符（会一起隐藏）。
  探针：`dumpDom().ipNodes[].html` 看这些节点的实际归属。
- **下行帧是否已转义分隔符**：面板勾「调试日志」后观察「可疑帧」计数是否增长；配合 `rawStats()` 看帧前缀分布。
- **与 iiroseForge 共存（A8）**：装 forge 后确认 `__IIROSE_BLACKLIST__.hooked === true`、`rawStats()` 持续增长、切房/重连后仍过滤。

## 版本

- loader v1（2026-09-25，独立于插件版本）：新增 `loader.js` 注入入口 —— 相对自身目录取主脚本、`?t=时间戳` 绕开 jsdelivr 分支地址 7 天缓存、失败自动换 fastly/gcore 域名，重复注入不重复拉。配套 `tests/loader-test.html`（本地 6 项）与 `tests/loader-cdn.html`（CDN 实链 4 项）。**用 loader 的用户以后不需要任何更新动作**。
- v0.2.0（2026-09-25）：**按站长插件规范做合规外壳（双形态）**。新增 `#region STORAGE`：检测 `Ext.Service` 存在就用 `instance.settings` 存取并登记包信息（包名 `Northseacaviar.iiroseBlacklist`、12 项元信息、`privacy` 公示"本地读取消息内容用于过滤、不上报"、`versionCode` 数字递增、`outerLoad` 空串、`runAt: allReady`），不存在（当前注入形态）才退回 localStorage，并在**自检行**显示「存储：官方 settings / 本地注入（localStorage）」。新增 API `storage()` / `pkg()`。测试：核心 39 项（+4 条存储双形态）、联调 43 项（+W43）、新增 `tests/official-mode.html` 23 项（假 Ext.Service，验"官方形态下 localStorage 里不出现名单"）。图片（icon/cover/poster）与跨上下文适配按用户决定暂缓 —— 等站长开放提交通道再补。
- v0.1.13（2026-09-25）：**修两个真机反馈的 bug**（北海实测报回；修完**真机验收通过**）:
  ① **已拉黑名单显示不出来、点不到「解除」**：面板内容比视口高时（聊天 iframe 矮，实测 1280×420 与 390×340 都触发 —— 见 `maxHeight` 计算），两个名单是唯一可被 flex 压缩的子项，被挤成 0 高（按钮还在 DOM 里，只是被裁掉）。修法：面板本体改为**自身可滚动**（`overflowY:auto`）+ 两个名单 `min-height:46px` 且 `flex-shrink:0` → 内容再高也能滚到、名单永远可读。
  ② **点标题栏的 × 关不掉面板**（只能点悬浮球）：标题栏同时是拖动把手，按住 × 时把手 `setPointerCapture` 把 `pointerup` 截走 → × 收不到抬手；紧随其后的 mouseup/click 又被 v0.1.10 加的"触屏兼容鼠标去重"（80ms）掐掉 → × 永远不触发。修法：把手内的可点控件（`[data-bl-nodrag]`）不启动拖动、不捕获指针；× 的点击区从 16px 字号无内边距放大到 34×30 起（触屏点得中）；另加 **Esc 关闭**作非鼠标退路。
  - 测试盲区同批补上：新增 W41（**忠实模拟指针捕获**的手势顺序：pointerdown 在 × 上、其后事件按真浏览器规则重定向到捕获元素 —— 夹具为此新增 `setPointerCapture` 拦截模型）、W42（矮面板布局回归）。回归核心 35/35、联调 **42/42**；另用 CDP **真实鼠标点击**复核：× 真点击能关（修前实测"仍开着"）、矮视口下列表高 46px（修前 0）。
  - 教训（已写进技能）：**合成 mouse 事件的夹具永远看不见指针捕获类 bug** —— 这类 bug 只有真实 pointer 序列或真机才能暴露
- v0.1.12（2026-09-25）：**按独立审查意见加固**（报告与逐条复核见 `docs/审查报告-2026-09-25-v0111.md`）。修 4 处：
  ① 解除拉黑的文案与新默认行为矛盾（原写"旧消息已删，不会恢复"，默认已不删）→ 按当前模式分两种说法；
  ② API `setEnabled/setDebug/setRightClick/setKeepHistory/setHideSession` 传非布尔值（0/undefined/'yes'）不再被 truthy 强转 —— 原来 `setKeepHistory(0)` 会**静默推进"不可逆删除"模式**，现在非布尔一律忽略并返回当前值；
  ③ uid 提取改为优先信头像上的 `data-uid`，`data-id` 只作兜底（`data-id` 是 `uid_消息id` 拼串，uid 含下划线时会切出假 uid 导致漏删，既有问题）；
  ④ 面板 `maxHeight` 随视口收缩（矮视口下不再顶着 540px 越界）。
  测试补两个**真实盲区**（审查用变异测试证明原套件锁不住这次改动最关键的两行）：新增 W37（两个新开关真的点得动+方框同步+落盘）、W40（逐行行为门的确定性用例，不靠 5 秒定时）；core 新增"发布件必须等于源码"；`tests/真机自测.js` 新增 `__T.retained()` 验 A2。
  我自己复跑变异测试：行为门失效 → W33+W40 抓到；会话隐藏门失效 → W35 抓到；开关回调接错字段 → W37 抓到。审查提的"475 行早退未被锁住"经复验属**不可观测**（保留历史时它只是性能捷径，真正的行为门是 464 行，已有两道用例守住）。
- v0.1.11（2026-09-25）：**拉黑不再删除已有记录**（用户需求变更，原 A2 由"清掉旧消息"改为"保留旧消息"）。新增两个面板开关：
  「保留聊天记录（不删历史消息）」默认**开** —— 拉黑只拦新消息，房间/私聊里的旧消息都不再被删；关掉即回到 v0.1.10 及以前的"拉黑瞬间清掉旧消息"（不可逆）。
  「隐藏私聊会话条目」默认**开** —— 关掉则被拉黑者仍留在私聊会话列表里，可点开。
  实现：`sweepNode()` 默认只记诊断不删节点、`sweepMessages()` 保留历史时整段跳过、`hideSessionNodes()` 受开关控制（关掉开关会顺带把之前隐藏的会话条目恢复）；新增 API `setKeepHistory/setHideSession`。另修文案：收包过滤未挂载的警告不再宣称"历史清扫生效"（保留历史时它等于没生效）。回归：核心 34/34、浏览器联调 35/35（新增 W33 默认保留、W34 关掉即回旧行为、W35 会话条目开关双向），面板实拍确认 5 行开关排版正常
- v0.1.10（2026-09-25）：**修手机触屏「开关点不动」**。真机复现：触屏一次点按会同时产生 pointerdown/up 与紧随其后的"兼容鼠标" mousedown/up/click，两条路各触发一次处理器 → 开关被连翻两下，看起来就是没反应。修法：指针事件后 80ms 内的鼠标事件视为同一条重复线，直接忽略（鼠标用户与测试夹具只发 mouse 事件，不受影响）。顺带修两处触屏问题：① 长按弹出的拉黑菜单会被抬手时的兼容 mousedown 立刻关掉（现在 350ms 内忽略触屏兼容事件）；② 手势探针补上 pointercancel / touchstart / touchend，手机排障能看清事件到底走到哪一步。回归：核心 33/33、浏览器联调 32/32；另用 CDP 派发**真实触摸与真实鼠标**验证：触屏点开关单次翻转、鼠标连点两次都生效、长按头像 0.9s 出菜单并成功拉黑（该用户消息立刻消失、非黑名单用户不受影响）
- v0.1.9（2026-09-25）：**手机（触屏）适配** —— 悬浮球默认位置改成"钳进视口"，视口一矮（手机地址栏/键盘、聊天区被塞进较矮的 iframe）不再跑到屏幕外；视口变化/旋转后自动自愈。拖动改用指针事件（触屏原来根本拖不动），并给触屏加了**长按头像 0.55 秒 = 右键拉黑菜单**。回归：核心 33/33、浏览器联调 32/32；另在真实 Chrome 的 390×844 / 390×240 / 1280×720 三种视口下核对过悬浮球与面板都在视口内
- v0.1.8（2026-09-25）：**真机验收通过**（房间/私聊屏蔽、历史清扫、开关可用、刷新后仍生效）。此版把"覆盖检查"搬进面板自检行：默认位置若被别的元素盖住，面板会自己点名并自动避开
- v0.1.7（2026-09-25）：修「面板看得见、点不动」。真机根因是**位置**：面板原来待的那块区域有别的元素（父页面层或别的注入插件留下的透明层）把点击接走了 —— 渲染不受影响，所以面板看得见；而插件所在 iframe 自己的命中检测（elementFromPoint）看不见 iframe 外面的东西，所以自检一直报"命中正常"。修法：① 打开面板时自动检查该位置能不能点到（把坐标映射到父页面，看最上层元素是不是本 iframe），点不到就依次试「记住的位置 → 悬浮球左右上下 → 左上/右上角」，挑第一个点得到的；② 面板位置可拖动并持久化（`conf.panel`）；③ 自检行显示最终选择。新增 `_diag.whoCovers(x, y)`、`tests/frame-cover.html`（父页面覆盖层复现页，已用它验证过修复）。回归：核心 33/33、浏览器联调 32/32，另用 CDP 可信鼠标事件在覆盖层场景下真点击验证
- v0.1.4（2026-09-25）：面板加常驻自检行（打开面板 1 秒后自动跑，直接把结论写在面板上，不靠控制台）+ 分层手势探针 `_diag.gestures()`（window/document/面板三层分别记录，看事件走到哪一层断掉）+ 开关的备用通道（右键开关行、Tab+空格、`setEnabled/setDebug/setRightClick`）+ 按下高亮（按住时行背景变亮 = mousedown 确实到了这一行）
- v0.1.3：手势探针雏形、自检、备用通道（并入 v0.1.4）
- v0.1.2（2026-09-25）：修「面板里三个开关点不动」。真机实测根因：站点在 document 捕获阶段对 `click` 调 `preventDefault()`，把**原生控件的默认动作**取消了（事件本身照常传给我的处理器，所以按钮/右键菜单都正常，只有原生 checkbox 的勾选动作被吃掉）。修法：三个开关改成自绘方框 + 按下即触发（mouseup 与 click 双路 + 本次手势去重），不再依赖浏览器默认动作，也不再依赖原生控件渲染；整行可点、支持键盘。附带 `_diag.hitTest()` / `_diag.watchClick()` 两个排障探针与 `setEnabled/setDebug/setRightClick` 三个非鼠标入口。回归：核心 32/32、浏览器联调 27/27（本次新增 3 条覆盖"站点式拦截下仍可切换"），另用 CDP 可信鼠标事件逐行真点击验证
- v0.1.1（2026-09-25）：独立审查后的加固 —— 分隔符错位不再漏拦也不再回拼畸形帧、重连自愈、落盘兜底、异常可见、原型污染、右键菜单开关、重复注入幂等。详见 `docs/审查报告-2026-09-25.md`
- v0.1.0：MVP（协议级丢帧 + DOM 兜底 + 面板/右键入口）
