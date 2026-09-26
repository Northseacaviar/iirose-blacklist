# iirose 拉黑屏蔽插件（iirose-blacklist）

在 iirose（蔷薇花园）里拉黑某人后：**同一房间里看不到 TA 的头像和消息，私聊也收不到**，侧栏「信箱」里 TA 的点赞/关注/点踩通知不再产生（转账卡片不显示，钱照常到账）。

> **本项目是 vibecoding（AI 结对开发）的产物**
> - 人类作者（需求、方案拍板、真机验收）：**北海** —— GitHub [@Northseacaviar](https://github.com/Northseacaviar)
> - AI 助手（读规范、写代码、写测试、发版）：**Corvin Hermes**（中文名 *Hermes 玄翎*，基于 [Nous Research 的 Hermes Agent](https://hermes-agent.nousresearch.com/)）
> - 分工：人给需求并真机验收；AI 负责实现、自跑测试（Node 单测 + 浏览器联调 + 变异测试）与发布。

## 功能与行为口径

① 私聊屏蔽（无消息、无红点、无提示音）② 房间消息屏蔽（看不到 TA 的头像与发言）③ 信箱通知屏蔽（点赞/关注/点踩不产生、转账卡片不显示）④ 拉黑/解除随时可做，名单本地保存 ⑤ 拉黑时**默认连历史消息与点播卡片一起清掉**，可用面板开关改成「只拦新消息、旧记录留着」。

三条硬口径：

- **判据只按名字**（trim + 小写完全相等）：信箱帧与卡片里都没有 uid（条目 `getProfile([名字, 颜色, 头像, 性别, null])` 第 5 位即 `null`），只能按名字认人；**接受同名误伤**，不做严格模式。按头像判人已整块移除 —— 预置卡通头像（如 `cartoon/600264`）可能多用户共用，会连累无关路人。
- **转账永不丢帧**（钱优先）：被拉黑者的转账通知卡片隐藏，但帧原样透传 —— 金币加法、落盘、卡片渲染都不变。
- **站级房间公告一律不动**（3 字段、不带人名那种）。

信箱分两层：**协议层**对点赞/关注/点踩丢帧，`@` 帧逐记录判定，只丢「形状认得出 + 命中名单」的那条，认不出的字节原样保留；**界面层**把 `#leaveMsgHolder` 下 `.cardTag` 条目按名字 `display:none`（不删节点、记住原值可还原），历史卡片跟随「拉黑时保留他的历史消息」开关。其余帧（`%` 快照、`~`、`&1{...}` 媒体事件等）原样透传，非黑名单用户零影响。

默认口径 `keepHistory=false`（拉黑即清历史）：每次拉黑遍历聊天记录，清掉该 uid 的历史消息与点播卡片。「清除历史点播卡片」（默认开）单独控制卡片，它开着时即使「保留历史消息」也照清。

不做的：不隐藏房间成员列表里的头像（只处理聊天区与私聊）；不改站点代码、不上报服务端（纯本地效果）。

## 验收标准

| 编号 | 验收项 | 判定方式 |
|---|---|---|
| A1 / A3 | 拉黑后房间消息与私聊都收不到（含头像、未读红点、提示音） | 真机：让对方各发 2–3 条 |
| A2 / A2b | 拉黑瞬间清掉该 uid 的历史消息与点播卡片（默认口径）；「保留历史消息」开着时只留文字行、卡片仍清 | 真机 + 夹具 |
| A4 / A9d | 非黑名单用户零影响：帧字节级透传、他人卡片不隐藏 | 单测 / 联调 |
| A5 / A6 | 解除拉黑后立即恢复；刷新页面（F5）后名单仍生效 | 真机 |
| A7 / A8 | 控制台无异常、站点功能正常；与 iiroseForge 同时使用互不冲突 | 真机叠加测试 |
| A9 | 被拉黑者的信箱通知（点赞/关注/点踩）根本不产生：红点不亮、不弹、侧栏里没有这条 | 单测：`@` 帧该记录被剔除（只剩它则整帧丢） |
| A9b | 转账通知卡片在信箱里看不见，但转账照常到账（帧必须原样透传） | 真机：让 TA 转 1 钞 |
| A9c | 站级房间公告一律不动（名字故意撞上公告文本也不拦） | 单测 |
| A9e | 信箱卡片隐藏跟随「保留历史消息」开关：关=新旧一起隐；开=已渲染的留着、之后新来的隐 | 解除拉黑后卡片还原（只 `display:none`） |
| A10 | 悬浮球与面板都拖不出页面：贴边 4px、贴边仍可点击、松手记住的位置不越界、面板自己长高后回到界内 | `tests/drag-clamp.html`（21 项）+ 真机四方向各拖一次 |

## 协议与实现

协议级丢帧（借鉴 iiroseForge），不做事后删 DOM：站点把 socket 回调挂在 `window.socket._onmessage`。收包字符串按前缀分类：

- `"` → 房间消息：记录以 `<` 分隔、字段以 `>` 分隔，`[8]` = 用户标识
- `""` → 私聊消息：`[1]` = 发送者 uid
- `=` → 弹幕：`[7]` = uid
- `@` → **信箱通知帧**：从第 3 个字符起解析，3 字段 = 房间公告（一律不动）；用户通知**格子数不固定**（官方样本 7 格：`用户名>头像>性别>标记>背景>时间戳>颜色`，真机转账帧只有 6 格）。标记 `'^` 关注 / `'*` 点赞 / `'h` 点踩 / `'$` 转账
- 其余（`%` 快照、`~`、`&1{...}` 媒体事件等）原样透传

**形状判定按特征找、不认死下标**：名字 = 第 0 格；标记 = 第 1~5 格中第一个以 `'` 开头的格子；整条必须同时出现 9~11 位时间戳与 6 位 hex 颜色，格子数 4~9；凑不齐 = 形状不认识 → 放行。

界面层 DOM 清扫（兜底）+ MutationObserver 增量：uid 优先取头像上的 `data-uid`，`data-id` 只作兜底（含下划线时会切出假 uid）。点播卡片行没有 `data-id`、行内深处有 `data-uid`，且行内必有 `systemCardMediaShare*` 类名，两者相配即可按 uid 归属。被屏蔽者来信箱时用 600ms「静默闸」吞掉站点那三件事（弹面板 `panelAnimate(40,1)`、提示音、推未读），每窗最多吞一次。排障出口：`_diag.mailCards()` / `sweepMail()` / `mailSilence()` / `mailDiagText()`；大字诊断窗 `__IIROSE_BLACKLIST__.openDiag()`。

## 安装：给朋友用（一行地址）

在 iirose 页面注入（与点歌插件同一套：终端里 `js -s` 开开关 → `js` 粘贴地址，`extJs` 支持空格分隔多个）：

```
https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js
```

**推荐这一行（loader）**：它每次带时间戳去拉主脚本，**以后发新版你什么都不用做，刷新页面即最新**；CDN 拉不到会自动换 fastly / gcore 再试。loader 优先取 `@main` 分支 —— 无 ref 的地址解析的是「最新 tag 的快照」，没打 tag 就送不到用户手里。手机与电脑用同一行地址，注入方式完全相同。

直连主脚本（老用法，每次更新得自己动手）：

```
https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist@main/iirose-blacklist.js
```

注入成功后右下角出现 🚫 悬浮球，控制台打印 `[iirose 拉黑] vX.Y.Z 已加载`。

## 怎么更新到最新版

| 注入方式 | 更新动作 |
|---|---|
| **loader（推荐）** | 什么都不用做，刷新页面即最新版 |
| 直连 `iirose-blacklist.js` | ① 把地址里 `?v=` 数字改大；② 在站点自定义 JS 里**重新粘贴一次**（地址存在 `extJs` 里） |
| 本地调试（`start.bat`） | `Ctrl+F5`，本地不经 CDN |
| 想固定某版本 | 用 tag 地址 `...@v0.3.12/loader.js`（tag 不可变、首次请求必然回源） |

两道缓存坑：**浏览器对 loader 自己那个 URL 也会缓存 7 天**（jsdelivr 给 `max-age=604800`），CDN 上已是新版也照旧拿旧的用 → 要立刻换掉 loader 只能换地址（钉 tag，或在地址后加 `?v=2`）；**`@main`／无 ref 地址还可能被 CDN 缓存最多 12 小时**，`node tools/purge-cdn.js` 只管得了 CF + FY 两家主机（gcore 的 `@main` 陈旧且 purge 不覆盖）。确认更新成功：面板标题显示版本号，或控制台 `__IIROSE_BLACKLIST__.version`。

## 使用与自测

- 本地调试：双击 `start.bat`（起 127.0.0.1:8770），站点 console 里 `js` 粘贴 `http://127.0.0.1:8770/src/iirose-blacklist.js`
- 面板开关：**启用屏蔽 / 拉黑时保留他的历史消息 / 清除历史点播卡片 / 隐藏私聊会话条目 / 调试日志**。诊断的界面入口自 v0.3.11 起全部隐藏（代码保留），需要时用 `__IIROSE_BLACKLIST__.openDiag()` 开 760px 大字窗（可滚动、可复制全文）
- 自测：`node tests/core.test.js`（56 项）· `tests/harness.html`（54）· `mail-pop.html`（8）· `mail-fresh.html`（4，测面板首次出现的时序）· `official-mode.html`（23）· `migration.html`（7）· `drag-clamp.html`（21）· `loader-test.html`（6）· `loader-stub.html`（16，桩造四种选版组合）· `loader-cdn.html`（走真 CDN）· `probe3-selftest.html`（11）· `probe3-selftest-b.html`（6）
- 浏览器夹具用 `file://` 在**前台**标签里跑（后台标签被节流，表现是「一直卡在跑测试中」）；harness 会把结果写进 localStorage 键 `bl_harness_result`，掉线重开同源页可读回。自建静态服务前先 `netstat -ano | grep :端口` 确认只有一个 LISTENING。`official-mode.html` 若同浏览器先跑过 harness（它往 localStorage 写名单）会假失败，先 `localStorage.clear()` 或换无痕窗口
- 面板点不动的排障：`_diag.hitTest()`（是否被盖住 / 尺寸归零）、`_diag.watchClick()`（装点击探针看哪几层事件）、`sweep()` 全扫 / `debugSweep()` 逐行报告 DOM 清扫结果；`setEnabled/setDebug/setRightClick/setKeepHistory/setClearCards/setHideSession` 是不依赖鼠标的备用入口

## 手机（触屏）

注入方式与电脑一样（贴同一行地址）。四条已修的坑：① 一次点按只结算一次（指针事件后 80ms 内的鼠标事件视为同一次重复）；② 球与面板都拖不出页面（撞边即停，越位直接拉回默认右下角）；③ 不做长按/右键菜单（v0.2.4 起移除，拉黑只走面板）；④ 拖动改用指针事件（否则触屏完全拖不动）。

## 官方插件规范对齐

站长在论坛发了插件规范（用包壳登记元信息、不许私自写 localStorage）。代码已做成**双形态**，将来要提交不必重构：

- `packageName` = `Northseacaviar.iiroseBlacklist`；`PKG_META` 12 项齐全，`privacy` 公示「本地读取聊天/私聊内容用于比对黑名单，不修改、不上报、不转发」
- 有官方运行时 → 走 `instance.settings/removeSettings`（`#region STORAGE` 适配层）；没有才退回 localStorage，自检行写明「存储：本地注入（localStorage）」
- `VERSION` 与 `VERSION_CODE` 每次发布都要改；`outerLoad` 空串（单文件零依赖）；`runAt = allReady`；`device = *`；源码可读未压缩
- 验收：`tests/official-mode.html`（23 项断言，含「localStorage 里不出现名单」）
- 待验前提：官方运行时若把插件装到父页面、而 socket 在 `i.html` iframe 里，还需一步跨 frame 适配

## 目录

```
src/      插件源码（单文件 IIFE，即成品）
loader.js 给朋友的注入入口（并行取回候选地址、比出版本最高的那份再注入）
mobile-probe.js  手机端排障探针：页面顶部挂红条，直报上下文/视口/悬浮球位置/脚本报错
tests/    单测 + 浏览器夹具（harness / 官方形态 / loader / 信箱边界 / 拖动钳制等）
release/  发布件（推 GitHub、jsdelivr 用）
tools/    publish.js（发布件同步，--check 只校验）、purge-cdn.js（刷 jsdelivr 缓存并逐主机复核版本）
start.bat 本地托管 8770（自定义 JS 注入调试用）
```

过程产物（调研笔记、审查报告、复盘页、成本账、探针脚本）只留本机 `docs/`，**不入库**。

## 发布（改完代码怎么做）

1. `node tools/publish.js` —— 把 `src` 同步到 `release/` 与仓库根（jsdelivr 默认地址取的是仓库根那份；漏做一次就是「测试全过、朋友拿到旧版」）
2. `node tests/core.test.js` + 浏览器开 `tests/harness.html`，两边全绿（核心单测里已含「发布件必须等于源码」）
3. `git add -A && git commit && git push`
4. **打 tag**（必须先打 —— 无 ref 的默认地址解析的是「最新 tag 的快照」，不打 tag 默认地址就不动）：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`
5. `node tools/purge-cdn.js` 刷缓存并逐主机复核版本（落后即退出码 1）。手刷单条要带代理：`curl -x http://<你的代理地址:端口> "https://purge.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js"`
6. 复核三条（不能只看 curl 没报错）：无 ref 地址解析到哪个版本（`curl -sI <地址> | grep -i x-jsd-version`，打完 tag 有分钟级延迟）· 各地址 md5 与 `VERSION` 常量一致 · `node tools/publish.js --check` 通过

## 真机待验证项

- **A3 的私聊历史**：实时私聊帧已确认可丢；若站点打开私聊窗口时另用 HTTP/快照补历史消息，需要另补清扫路径（探针：`dumpDom()` 看 `ipNodes` / `msgs` 结构）
- **`[ip]` 选择器覆盖面**：若它也出现在成员列表上，「不隐藏成员列表头像」这句就与事实不符（探针：`dumpDom().ipNodes[].html`）
- **下行帧是否已转义分隔符**：面板勾「调试日志」后看「可疑帧」计数是否增长，配合 `rawStats()` 看帧前缀分布
- **与 iiroseForge 共存（A8）**：装 forge 后确认 `hooked === true`、`rawStats()` 持续增长、切房/重连后仍过滤
- **联调 W22 偶发失败**（单次红、重跑不复现，已定位不是插件问题）：该用例用固定 `sleep 6000` 去等 5 秒自检周期，本就卡在边界；下一步改成轮询 `hooked`

## 版本

`VERSION`（插件本体）与发布 tag 是两条线：只有 `src/` 改动才升 `VERSION` 与 `VERSION_CODE`（官方规范要求 versionCode 每次发布 +1）；loader 与文档改动不动插件版本。更早的历史见 `git tag`。

| tag | 内容 |
|---|---|
| `v0.3.12` | 插件 v0.3.11：诊断的界面入口全部隐藏，改用控制台 `openDiag()` 开大字窗 |
| `v0.3.11` | 插件 v0.3.10：诊断大字窗「关不掉」修复 —— 原来在捕获阶段 stopPropagation，把窗内「关闭/复制全文/刷新」一起掐死，改冒泡阶段拦 |
| `v0.3.10` | 插件 v0.3.9：修正 5 处边界问题（拖动/点击阈值统一、尺寸每帧现量 + 落盘前再钳、面板长高自愈、矮视口重算上限） |
| `v0.3.9` | 插件 v0.3.8：**悬浮窗拖不出页面**（实时钳到视口边界、撞边即停；越位直接拉回默认右下角） |
| `v0.3.8` | 插件 v0.3.7：形状守卫改成**按特征找、不认死下标**（真机转账帧只有 6 格、标记不在第 4 格） |
| `v0.3.7` | 插件 v0.3.6：诊断改 760px 大字窗（可滚动、可选中、可复制全文） |
| `v0.3.6` | 插件 v0.3.5：面板内置「信箱诊断」 |
| `v0.3.5` | 插件 v0.3.4：被屏蔽者来信箱不弹面板/不响铃/不推未读（600ms 静默闸，帧照旧透传） |
| `v0.3.4` | loader v2.0：并行取回候选地址、先比版本再注入（不再被 `@main` 的 12 小时缓存坑） |
| `v0.3.0`–`v0.3.3` | 屏蔽信箱通知上线；判据改为只按名字（头像判据整块移除）；发版流程补 `purge-cdn.js` |
| `v0.2.x` | 合规外壳（双形态存储）、loader 上线、拉黑即清历史、老配置迁移、拆掉右键/长按菜单 |
