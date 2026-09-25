/*!
 * iirose 拉黑屏蔽 · iirose-blacklist v0.1.1
 * 作者：Corvin Hermes（为北海做）
 *
 * 作用：在 iirose（蔷薇花园）里拉黑某人后 ——
 *   1) 同一房间里看不到 TA 的头像和消息
 *   2) 收不到 TA 的私聊（无消息、无未读红点、无提示音）
 *
 * 原理：在 WebSocket 收包层（window.socket._onmessage）把黑名单用户的记录整条剔除，
 *       消息根本不进客户端；再对已渲染的历史消息做 DOM 清扫兜底。
 *       帧格式依据官方文档 XCWQW1/iirose-docs（markdown/event/event_message.md）。
 *
 * 注入：iirose 页面 console → `js -s` 开启自定义 JS → `js` 粘贴本文件 URL。
 * 调试探针：window.__IIROSE_BLACKLIST__  （见文件末尾导出的 API）
 */
(function () {
  'use strict';

  const VERSION = '0.1.7';
  try { window.__IIROSE_BLACKLIST_VERSION__ = VERSION; } catch (e) { }

  const STORE_KEY = 'iirose_blacklist_v1';
  const TAG = '[拉黑]';

  /* ==========================================================================
   * CORE：纯数据层（不碰 DOM / window，可被 tests/core.test.js 单独 extract 跑）
   * ========================================================================== */
  // #region CORE
  const MAX_SEEN = 300;

  function defaultStore() {
    return {
      v: 1,
      enabled: true,
      // 用 null 原型：uid 恰好是 '__proto__'/'constructor' 时才会真的成为 own 键（普通对象会写到原型上，静默失效）
      uids: Object.create(null),      // uid -> { name, ts }  黑名单
      seen: Object.create(null),      // uid -> { name, ts }  最近见过的人（用于面板里按名字拉黑）
      counters: { room: 0, priv: 0, danmaku: 0, dom: 0, abnormal: 0, err: 0 },
      conf: { rightClick: true, debug: false, panel: null },   // panel: 用户拖到的面板位置（null=自动摆放）
    };
  }

  function normalizeStore(raw) {
    const s = defaultStore();
    if (!raw || typeof raw !== 'object') return s;
    if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
    for (const k in (raw.uids || {})) {
      if (!k) continue;
      const it = raw.uids[k] || {};
      s.uids[k] = { name: it.name ? String(it.name) : '', ts: Number(it.ts) || Date.now() };
    }
    for (const k in (raw.seen || {})) {
      if (!k) continue;
      const it = raw.seen[k] || {};
      s.seen[k] = { name: it.name ? String(it.name) : '', ts: Number(it.ts) || 0 };
    }
    for (const k in s.counters) if (typeof raw.counters?.[k] === 'number') s.counters[k] = raw.counters[k];
    if (raw.conf && typeof raw.conf === 'object') {
      if (typeof raw.conf.rightClick === 'boolean') s.conf.rightClick = raw.conf.rightClick;
      if (typeof raw.conf.debug === 'boolean') s.conf.debug = raw.conf.debug;
      if (raw.conf.panel && typeof raw.conf.panel.left === 'number' && typeof raw.conf.panel.top === 'number') {
        s.conf.panel = { left: raw.conf.panel.left, top: raw.conf.panel.top };
      }
    }
    return s;
  }

  function hasUid(obj, uid) {
    return !!(uid && obj && Object.prototype.hasOwnProperty.call(obj, uid));
  }

  // 注意签名是两参 (store, uid)；运行时请用下方的单参包装 isBlocked(uid)——
  // 写成 isBlockedIn(uid) 会把 uid 当 store，条件恒为假且不报错（踩过这个坑，静默失效）
  function isBlockedIn(store, uid) {
    return hasUid(store.uids, uid);
  }

  // 帧里的名字是 HTML 转义的；这里只做显示用还原（不 innerHTML，不会注入）
  function unescapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  function recordSeen(store, uid, name) {
    if (!uid) return;
    const old = store.seen[uid];
    store.seen[uid] = { name: name || (old && old.name) || '', ts: Date.now() };
    const keys = Object.keys(store.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => (store.seen[a].ts || 0) - (store.seen[b].ts || 0));
      for (let i = 0; i < keys.length - MAX_SEEN; i++) delete store.seen[keys[i]];
    }
  }

  // uid 形态校验：只有长得像 uid 才当作 uid 用，避免误判别人消息里的字段
  function looksLikeUid(u) {
    return typeof u === 'string' && u.length >= 5 && u.length <= 40 && /^[0-9a-zA-Z_@-]+$/.test(u);
  }

  // 记录形状校验：用来判断 '<' 切分出来的片段到底是不是一条完整记录。
  // 只靠"字段数够不够放 uid"不够——私聊帧 uid 在下标 1，残片照样有 2 个以上字段。
  // 所以用两条硬特征：记录以数字消息id 开头；uid 位置（房间 [8] / 私聊 [1]）是 uid 形态。
  // 残片（如 "b>339f88>>…"、"3 is true>040b02>…"）必然过不了这两条。
  function isRecordShaped(f, kind) {
    if (kind === 'danmaku') return true;                 // 弹幕单条，不参与 '<' 切分
    if (!/^\d{6,}$/.test(f[0] || '')) return false;      // 消息 id 必须是数字
    return looksLikeUid(f[kind === 'room' ? 8 : 1]);     // uid 位置必须是 uid 形态
  }

  /**
   * 帧结构（官方文档 + iiroseForge 生产验证）：
   *   房间消息 `"`  + rec1<rec2<…   rec 字段：0 消息id | 1 头像 | 2 用户名 | 3 内容 | 4 颜色 | 5 颜色 | 6 | 7 | 8 uid | 9 头衔 | 10 随机数
   *   私聊     `""` + rec1<rec2<…   rec 字段：0 消息id | 1 发送者uid | 2 用户名 | 3 头像 | 4 内容 | 5 颜色 | 6 | 7 颜色 | 8 | 9 背景图 | 10 随机数
   *   弹幕     `=`  + 单条记录      字段：0 用户名 | 1 内容 | 2 颜色 | 3 颜色 | 4 | 5 头像 | 6 消息id | 7 uid | 8 头衔 | …
   *
   * 分隔符风险：`<` 是记录分隔符、`>` 是字段分隔符，两者若出现在字段内容里，切分就会错位。
   * 官方 note_escape_character.md 给出上行转义表（" & < >），但下行帧是否一定已转义无法保证
   * （第三方客户端/机器人可以发原始字符）。所以这里做两件事：
   *   1) 每个片段做形状校验（isRecordShaped），任一片段不合格 → 本帧切分不可信（suspect）；
   *   2) 切分不可信时**绝不回拼**（回拼会把半截畸形记录交给站点解析器）：命中即整帧丢弃；
   *      按下标没命中时再用「令牌级」复查，命中同样整帧丢弃 —— 宁可丢这一帧也不放行被拉黑者。
   * 返回 { data, changed, blocked[], abnormal }；data 为 null 表示整帧丢弃。
   */
  function filterFrame(data, store, hooks) {
    const out = { data: data, changed: false, blocked: [], kind: null, abnormal: false };
    if (typeof data !== 'string' || data.length < 2) return out;

    let head, kind, uidIdx, nameIdx, multi = true;
    if (data.charCodeAt(0) === 0x22) {            // "
      if (data.charCodeAt(1) === 0x22) { head = '""'; kind = 'priv'; uidIdx = 1; nameIdx = 2; }
      else { head = '"'; kind = 'room'; uidIdx = 8; nameIdx = 2; }
    } else if (data.charCodeAt(0) === 0x3d) {     // =
      head = '='; kind = 'danmaku'; uidIdx = 7; nameIdx = 0; multi = false;
    } else {
      return out;                                 // 快照 / 媒体事件 / 其它帧：原样透传
    }
    out.kind = kind;

    const body = data.slice(head.length);
    const recs = multi ? body.split('<') : [body];
    const kept = [];
    let suspect = false;
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const f = rec.split('>');
      if (multi && !isRecordShaped(f, kind)) suspect = true;
      const uid = f[uidIdx];
      if (looksLikeUid(uid)) {
        const name = unescapeHtml(f[nameIdx]);
        if (hooks && hooks.onSeen) hooks.onSeen(uid, name, kind);
        if (store.enabled && isBlockedIn(store, uid)) {
          out.blocked.push({ uid: uid, name: name, kind: kind });
          if (hooks && hooks.onBlock) hooks.onBlock(uid, kind);
          continue;                               // 丢掉这条记录
        }
      }
      kept.push(rec);
    }

    if (out.blocked.length) {
      out.changed = true;
      if (suspect) {
        out.abnormal = true;
        out.data = null;                          // 切分不可信：整帧丢弃，不回拼半截
      } else {
        // 整帧丢弃：房间/私聊帧里只剩空记录时也别发给客户端
        out.data = kept.some(r => r.length) ? (head + kept.join('<')) : null;
      }
    } else if (suspect) {
      out.abnormal = true;
      const tok = store.enabled ? findBlockedToken(body, store) : null;
      if (tok) {                                  // 没按下标命中，但帧里确实出现了被拉黑者的 uid
        out.changed = true;
        out.data = null;
        out.blocked.push({ uid: tok, name: '', kind: kind });
        if (hooks && hooks.onBlock) hooks.onBlock(tok, kind);
      }
    }
    return out;
  }

  // 令牌级复查：把帧内容按 '<' '>' 全切开逐个比对黑名单（只在切分可疑时用）
  function findBlockedToken(body, store) {
    const tokens = String(body).split(/[<>]/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (looksLikeUid(t) && isBlockedIn(store, t)) return t;
    }
    return null;
  }

  // 面板里按名字找 uid：优先最近出现、完全匹配的
  function findUidByName(store, name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return { uid: null, hits: [] };
    const hits = Object.keys(store.seen)
      .filter(u => String(store.seen[u].name || '').toLowerCase() === key)
      .sort((a, b) => (store.seen[b].ts || 0) - (store.seen[a].ts || 0));
    return { uid: hits[0] || null, hits: hits };
  }
  // #endregion

  /* ==========================================================================
   * 运行时：存储
   * ========================================================================== */
  let store = defaultStore();
  let saveTimer = null;

  // 运行时一律用这个单参包装，避免把 isBlockedIn(store, uid) 写成单参调用（踩过：静默失效）
  function isBlocked(uid) { return isBlockedIn(store, uid); }

  // 内部异常的可见通道：计数 + 首次无条件告警。静默降级最难排查，宁可刷一条 warn
  let saveFailed = false;
  const noteError = (function () {
    let warned = false;
    return function (where, e) {
      try { store.counters.err = (store.counters.err || 0) + 1; } catch (_) { }
      if (!warned) {
        warned = true;
        try { console.warn(TAG, '内部异常（首次，后续只计数）：' + where, (e && e.message) || e); } catch (_) { }
      }
      if (ui && ui.refreshStats) { try { ui.refreshStats(); } catch (_) { } }
    };
  })();

  function writeStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      saveFailed = false;
    } catch (e) {
      saveFailed = true;             // 配额/隐私模式/存储分区：不落盘，但要让用户看得见
      noteError('名单落盘失败（本次会话内仍生效）', e);
    }
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeStore();
  }

  function loadStore() {
    let rawText = null;
    try { rawText = localStorage.getItem(STORE_KEY); } catch (e) { noteError('读取 localStorage', e); }
    let raw = null;
    try {
      raw = JSON.parse(rawText || 'null');
    } catch (e) {
      // 原值先备份再回落默认值，避免"解析失败→空名单→下次保存覆盖原始数据"的不可恢复
      try { if (rawText) { localStorage.setItem(STORE_KEY + '_corrupt', rawText); console.warn(TAG, '名单解析失败，原值已备份到 ' + STORE_KEY + '_corrupt'); } } catch (_) { }
      raw = null;
    }
    if (raw && typeof raw === 'object' && raw.v !== 1) {
      try { console.warn(TAG, '名单版本不是 1（读到 ' + raw.v + '），按当前结构尽力读取'); } catch (_) { }
    }
    store = normalizeStore(raw);
  }

  function saveStore() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeStore(); }, 200);
  }

  function log() {
    if (!store.conf.debug) return;
    try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) { }
  }

  function myUid() {
    try { return window.uid || null; } catch (e) { return null; }
  }

  function addCounter(key, n) {
    store.counters[key] = (store.counters[key] || 0) + (n || 1);
  }

  /* ==========================================================================
   * 协议层：包装 socket 收包
   * ========================================================================== */
  let rawStats = Object.create(null);   // 调试用：各前缀帧计数

  function blockTick(uid, kind) {
    if (kind === 'room') store.counters.room++;
    else if (kind === 'priv') store.counters.priv++;
    else if (kind === 'danmaku') store.counters.danmaku++;
    saveStore();
    if (store.conf.debug) log('已屏蔽', kind, uid, '累计', JSON.stringify(store.counters));
    if (ui && ui.refreshStats) ui.refreshStats();
  }

  const hookCbs = {
    onSeen: (uid, name, kind) => {
      if (myUid() && uid === myUid()) return;               // 自己不进"最近出现"
      const old = store.seen[uid];
      if (old && old.name === name && Date.now() - (old.ts || 0) < 30000) return; // 降噪
      recordSeen(store, uid, name);
      saveStore();
      if (ui && ui.refreshSeen) ui.refreshSeen();
    },
    onBlock: blockTick,
  };

  // 实时判定是否仍挂载：socket 被站点重建/重新赋值后 _onmessage 会换新，标记随之消失
  function isHooked() {
    try {
      const s = window.socket;
      return !!(s && typeof s._onmessage === 'function' && s._onmessage.__blWrapped === true);
    } catch (e) { return false; }
  }

  let warnedAbnormal = false;

  function tryHookSocket() {
    const sock = window.socket;
    if (!sock || typeof sock._onmessage !== 'function') return false;
    if (sock._onmessage.__blWrapped === true) return true;     // 已经是我们这层

    const orig = sock._onmessage;
    const wrapped = function () {
      const args = arguments;
      try {
        if (typeof args[0] === 'string' && args[0].length) {
          const p = args[0].charAt(0);
          rawStats[p] = (rawStats[p] || 0) + 1;
          const r = filterFrame(args[0], store, hookCbs);
          if (r.abnormal) {
            addCounter('abnormal');
            if (!warnedAbnormal) {
              warnedAbnormal = true;
              try { console.warn(TAG, '帧切分可疑（字段里出现分隔符），已按整帧丢弃以防畸形帧进入客户端'); } catch (_) { }
            }
          }
          if (r.changed) {
            if (r.data === null) return;                    // 整帧丢弃
            args[0] = r.data;
          }
        }
      } catch (e) {
        noteError('收包过滤异常（该帧已放行）', e);
      }
      return orig.apply(this, args);
    };
    wrapped.__blWrapped = true;
    sock._onmessage = wrapped;
    log('已挂载收包过滤');
    if (ui && ui.refreshStats) ui.refreshStats();
    return true;
  }

  function waitSocket() {
    if (tryHookSocket()) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (tryHookSocket()) { clearInterval(t); return; }
      if (n === 20) {    // 10 秒还没挂上：无条件提示一次（默认不开调试也要看得见）
        try { console.warn(TAG, '还没找到 window.socket（未登录？）——收包过滤尚未挂载，面板会持续显示未挂载'); } catch (_) { }
        if (ui && ui.refreshStats) ui.refreshStats();
      }
      if (n > 600) { clearInterval(t); try { console.warn(TAG, '300 秒仍未挂上收包过滤，已放弃自动重试（面板每 5 秒仍会自检重挂）'); } catch (_) { } }
    }, 500);
  }

  // 自检重挂：站点重连/重建 socket 后，5 秒内自动把过滤装回新 socket
  function rehookCheck() {
    if (!isHooked()) { if (tryHookSocket()) log('检测到收包过滤丢失，已重新挂载'); }
  }

  /* ==========================================================================
   * DOM 兜底：清掉已渲染的历史消息 / 私聊会话项
   * ========================================================================== */
  // 站点把消息节点的 data-id 记作 "uid_消息id"（iiroseForge 依赖同一约定）。
  // 但不能盲切：万一 uid 形态变了导致切出来的不是 uid，就返回 null 交给 data-uid 兜底。
  function uidFromId(id) {
    if (!id) return null;
    const s = String(id);
    const i = s.indexOf('_');
    const head = i > 0 ? s.slice(0, i) : s;
    return looksLikeUid(head) ? head : null;
  }

  function uidOfMessageNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const ds = node.dataset || {};
    const byId = uidFromId(ds.id);
    if (byId) return byId;
    if (looksLikeUid(ds.uid)) return ds.uid;
    const av = node.querySelector && node.querySelector('[data-uid]');
    if (av && av.dataset && looksLikeUid(av.dataset.uid)) return av.dataset.uid;
    return null;
  }

  // 找到"该删哪一行"：正常消息是 .msg；系统消息（pubMsgSystem 等）没有 .msg 祖先，
  // 就向上找 msgholderBox 的直接子节点，整行删掉而不是只删头像。
  // 上行深度封顶 3 层：站点若在消息与容器之间插了"分组/日期"包裹层，继续上行会误删整组别人的消息（违反"零影响"）。
  function rowFor(node) {
    if (node.classList && node.classList.contains('msg')) return node;
    const m = node.closest ? node.closest('.msg') : null;
    if (m) return m;
    let cur = node;
    for (let up = 0; up < 3; up++) {
      const p = cur.parentNode;
      if (!p || p === document.documentElement || p === document.body) break;
      if (p.classList && p.classList.contains('msgholderBox')) return cur;
      cur = p;
    }
    return node;
  }

  function hideSessionNodes(scope) {
    let list;
    try { list = (scope || document).querySelectorAll('[ip]'); } catch (e) { noteError('会话项查询', e); return; }
    Array.prototype.forEach.call(list, (n) => {
      const uid = n.getAttribute('ip');
      if (!looksLikeUid(uid)) return;
      const hide = store.enabled && isBlocked(uid);
      if (hide && !n.hasAttribute('data-bl-hidden')) {
        n.setAttribute('data-bl-prev-display', n.style.display || '');   // 记住站点自己设的原值，恢复时写回
        n.setAttribute('data-bl-hidden', '1');
        n.style.display = 'none';
        addCounter('dom');
        saveStore();
      } else if (!hide && n.hasAttribute('data-bl-hidden')) {   // 解除拉黑后恢复
        n.style.display = n.getAttribute('data-bl-prev-display') || '';
        n.removeAttribute('data-bl-prev-display');
        n.removeAttribute('data-bl-hidden');
      }
    });
  }

  // 排障用：只留最近 20 条，避免长挂机时无限累积（生产路径每 5 秒都会 push）
  let lastSweepDiag = [];
  function pushSweepDiag(d) {
    lastSweepDiag.push(d);
    if (lastSweepDiag.length > 20) lastSweepDiag.shift();
  }

  function sweepNode(root) {
    if (!root || root.nodeType !== 1) return 0;
    let removed = 0;
    const cand = [];
    if (uidOfMessageNode(root) || (root.getAttribute && looksLikeUid(root.getAttribute('ip')))) cand.push(rowFor(root));
    if (root.querySelectorAll) {
      Array.prototype.forEach.call(root.querySelectorAll('.msg, [data-uid], [ip]'), (n) => {
        const row = rowFor(n);
        if (row && cand.indexOf(row) < 0) cand.push(row);
      });
    }
    const diag = { cls: String(root.className || ''), candLen: cand.length, rootUid: uidOfMessageNode(root), enabled: !!store.enabled, hits: [] };
    cand.forEach((row) => {
      const uid = uidOfMessageNode(row);
      const hit = !!(uid && store.enabled && isBlocked(uid));
      diag.hits.push({ uid: uid, blocked: hit, hasParent: !!row.parentNode, sameAsRoot: row === root });
      if (hit) {
        if (row.parentNode) { row.parentNode.removeChild(row); removed++; addCounter('dom'); }
      }
    });
    pushSweepDiag(diag);
    if (removed) { saveStore(); if (ui && ui.refreshStats) ui.refreshStats(); }
    return removed;
  }

  function sweepMessages() {
    let removed = 0;
    try {
      const boxes = document.getElementsByClassName('msgholderBox');
      for (let b = 0; b < boxes.length; b++) {
        const kids = Array.prototype.slice.call(boxes[b].children);   // 先快照：删节点时 HTMLCollection 会位移
        kids.forEach((n) => { removed += sweepNode(n); });
      }
    } catch (e) { noteError('消息清扫', e); }
    return removed;
  }

  function sweepAll() {
    const removed = sweepMessages();
    try { hideSessionNodes(); } catch (e) { noteError('会话项清扫', e); }
    if (removed) log('清扫历史消息', removed, '条');
    return removed;
  }

  // 会话项扫描按 500ms 节流；消息清扫在观察者里按节点就地做，不整体重扫
  let sessTimer = null;
  function scheduleSessionSweep(scope) {
    if (sessTimer) return;
    sessTimer = setTimeout(() => {
      sessTimer = null;
      try { hideSessionNodes(scope); } catch (e) { noteError('会话项清扫（节流）', e); }
    }, 500);
  }

  function inMsgBox(node) {
    if (!node || !node.closest) return false;
    if (node.classList && node.classList.contains('msgholderBox')) return true;
    return !!node.closest('.msgholderBox');
  }

  function startDomGuard() {
    try {
      const obs = new MutationObserver((muts) => {
        let sawIp = false;
        for (let i = 0; i < muts.length; i++) {
          const m = muts[i];
          if (m.type === 'attributes') { sawIp = true; continue; }
          const added = m.addedNodes;
          for (let j = 0; j < added.length; j++) {
            const n = added[j];
            if (n.nodeType !== 1) continue;
            if (inMsgBox(n)) sweepNode(n);                       // 消息区：就地处理（含整批插入）
            if (n.getAttribute && n.getAttribute('ip')) sawIp = true;
            else if (n.querySelector && n.querySelector('[ip]')) sawIp = true;
          }
        }
        if (sawIp) scheduleSessionSweep();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['ip', 'data-uid'] });
      sweepAll();
      // 兜底：每 5 秒整体扫一次 + 自检收包过滤是否还在（站点重连/重建 socket 会丢掉包装）
      setInterval(() => {
        try { sweepAll(); } catch (e) { noteError('定时清扫', e); }
        try { rehookCheck(); } catch (e) { noteError('重挂自检', e); }
      }, 5000);
    } catch (e) { noteError('DOM 守卫启动', e); }
  }

  /* ==========================================================================
   * UI
   * ========================================================================== */
  let ui = null;
  let lastPlacement = '';      // 上次面板摆放的结论（自检行会显示），放模块作用域给 selfCheck 用

  const Z = '2147483000';
  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) for (const k in style) n.style[k] = style[k];
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // 同 el()，但内联样式带 !important（内联 !important 优先级最高），站点样式表盖不掉
  function imp(tag, style, text) {
    const n = document.createElement(tag);
    if (style) for (const k in style) n.style.setProperty(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), style[k], 'important');
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // 统一的"按下即触发"绑定。为什么不直接用 onclick：
  // 站点在 document 捕获阶段对 click 调 preventDefault()（真机实测：拖动、右键、onclick 都正常，
  // 唯独原生复选框的默认动作被取消 → 有方框但点不动）。默认动作被取消挡不住处理器触发，所以处理器照用；
  // 但为了将来站点改成 stopPropagation（那时连处理器都不触发）也不失效，同时挂 mouseup 这条路：
  // 按下并在同一元素上抬起就触发，用"本次手势"标志位保证 mouseup 与配对 click 不会翻两次。
  function onPress(node, fn) {
    let pressed = false, firedByGesture = false;
    const down = () => { pressed = true; firedByGesture = false; };
    const up = () => { if (pressed) { fn(); firedByGesture = true; } pressed = false; };
    node.addEventListener('mousedown', down);
    node.addEventListener('mouseup', up);
    node.addEventListener('pointerdown', down);          // 站点若只在指针事件体系里连通，鼠标事件可能被吞
    node.addEventListener('pointerup', up);
    node.addEventListener('click', () => { if (firedByGesture) { firedByGesture = false; return; } fn(); });
    document.addEventListener('mouseup', () => { pressed = false; });   // 冒泡阶段，晚于元素自身
    return node;
  }

  // ===== 手势记录（诊断"点击到底走到哪一步"）=====
  // 分三层挂：window / document / 面板。哪一层没记录，说明事件在那之前就被站点掐了。
  // _diag.gestures() 取出来看；命中我方控件时 key 标出是哪个控件。
  const gestures = [];
  function noteGesture(lvl, ev, e, extra) {
    try {
      const t = e && e.target;
      const host = t && t.closest ? t.closest('[data-bl-key],button') : null;
      gestures.push({
        lvl: lvl, ev: ev,
        key: host ? (host.dataset && host.dataset.blKey ? host.dataset.blKey : 'button:' + (host.textContent || '').slice(0, 6)) : '',
        tgt: t ? (t.tagName + (t.className ? '.' + String(t.className).slice(0, 16) : '')) : '',
        xy: [Math.round((e && e.clientX) || 0), Math.round((e && e.clientY) || 0)],
        dp: !!(e && e.defaultPrevented),
        extra: extra || '',
      });
      if (gestures.length > 40) gestures.shift();
    } catch (_) { }
  }
  function installGestureProbes(panel) {
    const evs = ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'contextmenu'];
    const bind = (lvl, node, capture) => {
      evs.forEach((ev) => node.addEventListener(ev, (e) => noteGesture(lvl, ev, e), capture));
    };
    try { bind('window', window, true); bind('document', document, true); } catch (_) { }
    if (panel) bind('panel', panel, false);
  }

  // ===== 父页面侧判定：iframe 内某坐标上的点击，到底会不会落进 iframe =====
  // iframe 自己的 elementFromPoint 看不见外面（这正是"17 个控件命中正常却点不动"的原因），
  // 所以要把坐标映射到父页面去看：父页面在该点的最上层元素如果就是我们的 iframe 元素，才说明点击进得来。
  // 同源才读得到父页面；跨域或读不到就一律当作"点得到"（宁可不动，也不要瞎挪）。
  function parentDocument() {
    try {
      if (!window.frameElement) return null;
      return (window.parent && window.parent.document) || null;
    } catch (_) { return null; }
  }
  function pointReachesIframe(cx, cy) {
    const pd = parentDocument();
    if (!pd) return true;
    try {
      const fe = window.frameElement;
      const fr = fe.getBoundingClientRect();
      const top = pd.elementFromPoint(Math.round(fr.left + cx), Math.round(fr.top + cy));
      if (!top) return true;
      return top === fe || (top.contains && top.contains(fe));   // 父页面该点最上层是我们这个 iframe
    } catch (_) { return true; }
  }
  function rectReachesIframe(r) {
    if (!r || r.width < 5 || r.height < 5) return false;
    const pts = [[r.left + 8, r.top + 8], [r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width - 8, r.top + r.height - 8]];
    // 每个开关行/按钮也各点一下
    if (ui && ui.panel) {
      Array.prototype.forEach.call(ui.panel.querySelectorAll('[data-bl-key],button'), (n) => {
        const b = n.getBoundingClientRect();
        if (b.top >= r.top - 1 && b.bottom <= r.bottom + 1) pts.push([b.left + Math.min(b.width / 2, 30), b.top + b.height / 2]);
      });
    }
    for (let i = 0; i < pts.length; i++) if (!pointReachesIframe(pts[i][0], pts[i][1])) return false;
    return true;
  }

  // ===== 控件自检：面板上每个开关行/按钮到底能不能点到 =====
  // 被祖先 overflow 裁掉（名单太长滚出可视区）不算"被盖住"，要分开报，否则真机会误报一片、把真问题埋掉
  function clippedByAncestor(n, x, y) {
    let e = n.parentNode;
    while (e && e !== document.body && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (/(hidden|auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX)) {
        const r = e.getBoundingClientRect();
        if (y < r.top || y > r.bottom || x < r.left || x > r.right) return true;
      }
      e = e.parentNode;
    }
    return false;
  }
  function hitTestControls() {
    const out = [];
    const scan = (root) => {
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll('[data-bl-key],button'), (n) => {
        const r = n.getBoundingClientRect();
        const cx = r.left + Math.min(r.width / 2, 40), cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const inside = !!(top && (n === top || n.contains(top)));
        out.push({
          what: n.dataset.blKey || ('button:' + (n.textContent || '').slice(0, 8)),
          rect: [r.left | 0, r.top | 0, r.width | 0, r.height | 0],
          visible: r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).pointerEvents !== 'none',
          topEl: top ? (top.tagName + (top.className ? '.' + String(top.className).slice(0, 24) : '')) : null,
          insideRow: inside,
          clippedOut: !inside && clippedByAncestor(n, cx, cy),
          state: n.dataset && n.dataset.blKey ? (n.querySelector('span') || {}).textContent : undefined,
        });
      });
    };
    scan(ui && ui.panel);
    scan(document.getElementById('__bl_menu__'));
    return out;
  }
  function selfCheck() {
    const info = hitTestControls();
    const bad = info.filter((i) => !i.visible || (!i.insideRow && !i.clippedOut));
    const line = bad.length
      ? ('自检：' + bad.length + '/' + info.length + ' 个控件点不到 → ' + bad.map((b) => b.what + '(该点位是 ' + b.topEl + ')').join('；'))
      : ('自检：' + info.length + ' 个控件命中正常');
    log(line);
    // 写进常驻自检行（不是状态行——状态行会被后续操作覆盖，结论就丢了）
    if (ui && ui.diagLine) {
      ui.diagLine.textContent = line + (lastPlacement ? '｜面板位置：' + lastPlacement : '') + (bad.length ? '' : '（点不动就右键开关行，或跑 _diag.gestures()）');
      ui.diagLine.style.setProperty('color', bad.length ? '#d0a04a' : '#7f8794', 'important');
    }
    return { line: line, info: info };
  }

  // 自绘开关：不依赖原生控件的渲染与默认动作，整行可点（方框+文字都算），键盘也能切
  function toggleRow(key, text, initial, onChange, right) {
    const row = imp('div', {
      display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '5px 12px',
      color: '#bbb', userSelect: 'none', marginLeft: right ? 'auto' : '0',
    });
    row.dataset.blKey = key;
    row.tabIndex = 0;
    const box = imp('span', {
      width: '13px', height: '13px', minWidth: '13px', borderRadius: '3px', border: '1px solid #666',
      background: '#2a2b33', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', lineHeight: '1', color: '#fff', boxSizing: 'border-box',
    });
    const label = imp('span', null, text);
    let on = !!initial;
    function paint() {
      box.textContent = on ? '✓' : '';
      box.style.setProperty('background', on ? '#b3261e' : '#2a2b33', 'important');
      box.style.setProperty('border-color', on ? '#b3261e' : '#666', 'important');
      label.style.setProperty('color', on ? '#eee' : '#888', 'important');
    }
    paint();
    const fire = (how) => {
      on = !on; paint(); onChange(on);
      noteGesture('action', '切换', { target: row, clientX: 0, clientY: 0 }, (row.dataset.blKey || '') + '=' + on + '(' + how + ')');
    };
    onPress(row, () => fire('按下'));
    // 按下高亮：也是个可见探针——按住时行背景变亮，说明 mousedown 到了这一行
    row.addEventListener('mousedown', () => { row.style.setProperty('background', '#33353f', 'important'); });
    row.addEventListener('mouseleave', () => { row.style.setProperty('background', 'transparent', 'important'); });
    document.addEventListener('mouseup', () => { row.style.setProperty('background', 'transparent', 'important'); });
    // 右键切换：右键通道（contextmenu）在本站已证实可用，作为左键失效时的备用路径
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); fire('右键'); });
    row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire('键盘'); } });
    row.appendChild(box); row.appendChild(label);
    row.__set = (v) => { on = !!v; paint(); };
    return row;
  }

  function makeDraggable(node, handle, onClick, onDrop) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; moved = 0;
      sx = e.clientX; sy = e.clientY;
      ox = node.offsetLeft; oy = node.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      node.style.left = (ox + dx) + 'px';
      node.style.top = (oy + dy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging && moved < 5 && onClick) onClick();
      else if (dragging && moved >= 5 && onDrop) onDrop(node.offsetLeft, node.offsetTop);
      dragging = false;
    });
  }

  function buildUi() {
    const fab = el('div', {
      position: 'fixed', left: (window.innerWidth - 60) + 'px', top: (window.innerHeight - 260) + 'px',
      width: '46px', height: '46px', borderRadius: '50%', background: '#b3261e', color: '#fff',
      fontSize: '20px', cursor: 'grab', boxShadow: '0 4px 14px rgba(0,0,0,.5)', zIndex: Z,
      display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none', touchAction: 'none',
    }, '🚫');
    fab.title = '拉黑 v' + VERSION + '（可拖动，点击开面板）';

    const panel = el('div', {
      position: 'fixed', left: (window.innerWidth - 360) + 'px', top: (window.innerHeight - 560) + 'px',
      width: '330px', maxHeight: '540px', background: '#1e1f26', borderRadius: '10px',
      boxShadow: '0 4px 24px rgba(0,0,0,.6)', zIndex: Z, display: 'none',
      flexDirection: 'column', overflow: 'hidden', color: '#eee',
      fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif', fontSize: '12px',
    });

    const title = el('div', {
      padding: '9px 12px', fontSize: '13px', fontWeight: '700', borderBottom: '1px solid #333',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'grab', userSelect: 'none',
    });
    title.appendChild(el('span', null, '🚫 拉黑屏蔽 v' + VERSION));
    const closeBtn = el('span', { cursor: 'pointer', color: '#888', fontSize: '16px' }, '×');
    onPress(closeBtn, () => { panel.style.display = 'none'; });
    title.appendChild(closeBtn);
    panel.appendChild(title);

    // 开关（自绘，不用原生 checkbox —— 站点全局 preventDefault 会把原生控件的默认动作吃掉）
    const swRow = el('div', { padding: '3px 0', display: 'flex', alignItems: 'center', borderBottom: '1px solid #2a2b33' });
    const enableToggle = toggleRow('enabled', '启用屏蔽', store.enabled, (on) => {
      store.enabled = on; saveStore();
      log('屏蔽开关', on);
      setStatus(on ? '已开启屏蔽' : '已关闭屏蔽（名单保留）', on ? '#68b26d' : '#d0a04a');
      setTimeout(() => { if (store.enabled) sweepAll(); }, 50);
    });
    const debugToggle = toggleRow('debug', '调试日志', !!store.conf.debug, (on) => {
      store.conf.debug = on; saveStore(); log('调试日志', on);
      setStatus(on ? '调试日志已开（控制台会打统计）' : '调试日志已关', '#999');
    }, true);
    swRow.appendChild(enableToggle); swRow.appendChild(debugToggle);
    panel.appendChild(swRow);

    // 右键菜单开关（conf.rightClick 之前只读、没法改）
    const rcToggle = toggleRow('rightClick', '右键头像弹拉黑菜单', store.conf.rightClick !== false, (on) => {
      store.conf.rightClick = on; saveStore();
      setStatus(on ? '右键房间消息头像可拉黑' : '右键菜单已关闭（面板里仍可拉黑）', '#999');
    });
    panel.appendChild(rcToggle);

    // 添加
    const addRow = el('div', { display: 'flex', gap: '6px', padding: '10px 12px 6px' });
    const input = el('input', {
      flex: '1', background: '#2a2b33', border: '1px solid #444', borderRadius: '6px', color: '#eee',
      padding: '6px 9px', fontSize: '12px', outline: 'none', minWidth: '0',
    });
    input.placeholder = 'uid，或收过/见过的人的名字';
    const addBtn = el('button', {
      background: '#b3261e', color: '#fff', border: 'none', borderRadius: '6px',
      padding: '6px 12px', cursor: 'pointer', fontSize: '12px', flexShrink: '0',
    }, '拉黑');
    addRow.appendChild(input); addRow.appendChild(addBtn);
    panel.appendChild(addRow);

    const status = el('div', { padding: '0 12px 8px', color: '#999', fontSize: '11px', minHeight: '15px' }, '右键房间消息头像也能拉黑');
    panel.appendChild(status);
    function setStatus(t, color) { status.textContent = t; status.style.color = color || '#999'; }

    // 已拉黑
    const blHead = el('div', { padding: '6px 12px', color: '#d98a86', fontWeight: '700', borderTop: '1px solid #2a2b33' }, '已拉黑 (0)');
    panel.appendChild(blHead);
    const blList = el('div', { overflowY: 'auto', maxHeight: '170px' });
    panel.appendChild(blList);

    // 最近出现
    const seenHead = el('div', { padding: '6px 12px', color: '#8aa0c9', fontWeight: '700', borderTop: '1px solid #2a2b33' }, '最近出现 (0)');
    panel.appendChild(seenHead);
    const seenList = el('div', { overflowY: 'auto', maxHeight: '150px' });
    panel.appendChild(seenList);

    // 统计 + 底部按钮
    const stats = el('div', { padding: '8px 12px', color: '#7f8794', borderTop: '1px solid #2a2b33' }, '已屏蔽：房间 0 · 私聊 0 · 弹幕 0 · 历史 0');
    panel.appendChild(stats);
    const warn = el('div', { padding: '0 12px 6px', color: '#d0a04a', fontSize: '11px', display: 'none' });
    panel.appendChild(warn);
    const diagLine = el('div', { padding: '6px 12px', color: '#7f8794', fontSize: '11px', lineHeight: '1.5' }, '自检：面板打开后 1 秒自动跑');
    panel.appendChild(diagLine);

    const foot = el('div', { display: 'flex', gap: '6px', padding: '0 12px 10px' });
    const copyBtn = el('button', {
      background: '#2a2b33', color: '#bbb', border: '1px solid #444', borderRadius: '5px',
      padding: '5px 10px', cursor: 'pointer', fontSize: '11px',
    }, '复制名单');
    onPress(copyBtn, () => {
      const lines = Object.keys(store.uids).map(u => u + '\t' + (store.uids[u].name || ''));
      if (!lines.length) { setStatus('名单为空，没什么可复制', '#d0a04a'); return; }
      const text = lines.join('\n');
      const okMsg = () => setStatus('已复制 ' + lines.length + ' 条到剪贴板', '#68b26d');
      const fallback = () => {
        // 用临时 textarea，别覆盖用户正在输入的搜索框
        const ta = el('textarea', { position: 'fixed', top: '0', left: '0', opacity: '0' });
        ta.value = text;
        document.body.appendChild(ta);
        let ok = false;
        try { ta.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        if (ok) okMsg();
        else { log(text); setStatus('复制失败（浏览器不给权限）：名单已打到控制台，可手动复制', '#ec4141'); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        // Promise 的拒绝 try/catch 抓不到，必须显式接失败分支
        navigator.clipboard.writeText(text).then(okMsg, fallback);
      } else fallback();
    });
    const resetBtn = el('button', {
      background: '#2a2b33', color: '#bbb', border: '1px solid #444', borderRadius: '5px',
      padding: '5px 10px', cursor: 'pointer', fontSize: '11px',
    }, '清空统计');
    onPress(resetBtn, () => {
      store.counters = { room: 0, priv: 0, danmaku: 0, dom: 0, abnormal: 0, err: 0 }; saveStore(); refreshAll();
      setStatus('统计已清零', '#68b26d');
    });
    foot.appendChild(copyBtn); foot.appendChild(resetBtn);
    panel.appendChild(foot);

    function row(uid, name, btnText, btnColor, onClick) {
      const r = el('div', { padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', borderTop: '1px solid #24252c' });
      const txt = el('div', { flex: '1', minWidth: '0' });
      txt.appendChild(el('div', { color: '#eee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, name || '(未知名字)'));
      txt.appendChild(el('div', { color: '#7f8794', fontSize: '10px' }, uid));
      const b = el('button', {
        background: 'transparent', color: btnColor, border: '1px solid ' + btnColor, borderRadius: '4px',
        padding: '3px 8px', cursor: 'pointer', fontSize: '11px', flexShrink: '0',
      }, btnText);
      onPress(b, onClick);
      r.appendChild(txt); r.appendChild(b);
      return r;
    }

    function refreshBlacklist() {
      blList.innerHTML = '';
      const keys = Object.keys(store.uids).sort((a, b) => (store.uids[b].ts || 0) - (store.uids[a].ts || 0));
      blHead.textContent = '已拉黑 (' + keys.length + ')';
      if (!keys.length) { blList.appendChild(el('div', { padding: '8px 12px', color: '#666' }, '（名单为空）')); return; }
      keys.forEach((uid) => {
        const name = store.uids[uid].name || ((store.seen[uid] || {}).name) || '';
        blList.appendChild(row(uid, name, '解除', '#68b26d', () => { unblock(uid); }));
      });
    }

    function refreshSeen() {
      seenList.innerHTML = '';
      const keys = Object.keys(store.seen)
        .filter(u => !isBlocked(u))
        .sort((a, b) => (store.seen[b].ts || 0) - (store.seen[a].ts || 0))
        .slice(0, 60);
      seenHead.textContent = '最近出现 (' + keys.length + ')';
      if (!keys.length) { seenList.appendChild(el('div', { padding: '8px 12px', color: '#666' }, '（还在等消息…）')); return; }
      keys.forEach((uid) => {
        seenList.appendChild(row(uid, store.seen[uid].name, '拉黑', '#d98a86', () => {
          block(uid, store.seen[uid].name);
        }));
      });
    }

    function refreshStats() {
      const c = store.counters;
      let t = '已屏蔽：房间 ' + c.room + ' · 私聊 ' + c.priv + ' · 弹幕 ' + c.danmaku + ' · 历史 ' + c.dom;
      if (c.abnormal) t += ' · 可疑帧 ' + c.abnormal;
      if (c.err) t += ' · 异常 ' + c.err;
      stats.textContent = t;
      // 真机上"看不到效果"的头号原因就是没挂上或落盘失败，这里必须显式显示
      const msgs = [];
      if (!isHooked()) msgs.push('⚠ 收包过滤未挂载（未登录？）——新消息不会被拦，只有历史清扫生效');
      if (saveFailed) msgs.push('⚠ 名单落盘失败（本次会话内仍生效）');
      if (c.err) msgs.push('存在内部异常 ' + c.err + ' 次（详见控制台）');
      if (msgs.length) { warn.textContent = msgs.join('；'); warn.style.display = 'block'; }
      else warn.style.display = 'none';
    }

    installGestureProbes(panel);

    function refreshAll() {
      refreshBlacklist(); refreshSeen(); refreshStats();
      enableToggle.__set(store.enabled);
      debugToggle.__set(!!store.conf.debug);
      rcToggle.__set(store.conf.rightClick !== false);
    }

    const doAdd = () => {
      const v = input.value.trim();
      if (!v) { setStatus('请输入 uid 或名字', '#ec4141'); return; }
      if (looksLikeUid(v)) { block(v, (store.seen[v] || {}).name || ''); }
      else {
        const r = findUidByName(store, v);
        if (!r.uid) { setStatus('没找到叫「' + v + '」的人（TA 还没在房间里说过话，请直接输 uid）', '#ec4141'); return; }
        block(r.uid, r.hits.length > 1 ? v : store.seen[r.uid].name);
        if (r.hits.length > 1) setStatus('同名 ' + r.hits.length + ' 个，已拉黑最近出现的那个', '#d0a04a');
      }
      input.value = '';
    };
    onPress(addBtn, doAdd);
    input.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); };

    document.body.appendChild(panel);
    document.body.appendChild(fab);
    // 摆放策略：① 记住的（用户拖到的）位置 → ② 悬浮球旁边 → ③ 四角，取第一个"点得到"的。
    // 为什么：真机上证实过——面板停在某块区域时点击会被别的元素接走（看得见、点不动），
    // 而悬浮球所在的区域必定点得到（否则面板根本打不开），所以以它为中心往外找。
    function setPanelPos(left, top) {
      const pr = panel.getBoundingClientRect();
      left = Math.max(4, Math.min(left, Math.max(4, window.innerWidth - pr.width - 4)));
      top = Math.max(4, Math.min(top, Math.max(4, window.innerHeight - pr.height - 4)));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
    }
    function placePanel() {
      const pr = panel.getBoundingClientRect();
      const fr = fab.getBoundingClientRect();
      const W = pr.width, H = pr.height;
      const saved = store.conf.panel;                       // 用户上次拖到的位置
      const cands = [];
      if (saved && typeof saved.left === 'number') cands.push([saved.left, saved.top, '上次的位置']);
      cands.push([fr.left - W - 12, fr.top - 40, '悬浮球左侧']);
      cands.push([fr.right + 12, fr.top - 40, '悬浮球右侧']);
      cands.push([fr.left, fr.top - H - 12, '悬浮球上方']);
      cands.push([fr.left, fr.bottom + 12, '悬浮球下方']);
      cands.push([8, 8, '左上角']);
      cands.push([window.innerWidth - W - 8, 8, '右上角']);
      let chosen = null;
      for (let i = 0; i < cands.length; i++) {
        setPanelPos(cands[i][0], cands[i][1]);
        if (rectReachesIframe(panel.getBoundingClientRect())) { chosen = cands[i]; break; }
      }
      if (!chosen) {                                        // 全被盖住（不该发生）：退回记住的位置或悬浮球左侧
        const fall = saved && typeof saved.left === 'number' ? [saved.left, saved.top] : [fr.left - W - 12, fr.top - 40];
        setPanelPos(fall[0], fall[1]);
        chosen = ['', '', '都点不到，已退回默认位置'];
      }
      lastPlacement = chosen[2];
      return chosen[2];
    }
    makeDraggable(fab, fab, () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (panel.style.display === 'flex') {
        placePanel();                                     // 摆放要在显示之后量尺寸，故放在这里
        refreshAll();
        setTimeout(() => { try { selfCheck(); } catch (e) { noteError('自检失败', e); } }, 1200);
      }
    });
    makeDraggable(panel, title, null, (left, top) => {
      store.conf.panel = { left: left, top: top };        // 用户拖过就记住，下次打开先试这个位置
      saveStore();
      statusMsg('面板位置已记住', '#68b26d');
    });

    ui = { panel, fab, setStatus, refreshAll, refreshSeen, refreshStats, refreshBlacklist, diagLine };
    refreshAll();
  }

  /* ---------------- 拉黑 / 解除 ---------------- */
  function block(uid, name) {
    if (!looksLikeUid(uid)) { statusMsg('不是有效的 uid：' + uid, '#ec4141'); return; }
    if (myUid() && uid === myUid()) { statusMsg('不能拉黑自己', '#ec4141'); return; }
    if (isBlocked(uid)) { statusMsg('已在名单中', '#d0a04a'); return; }
    store.uids[uid] = { name: name || (store.seen[uid] || {}).name || '', ts: Date.now() };
    saveStore();
    if (name) recordSeen(store, uid, name);
    log('拉黑', uid, name || '');
    statusMsg('已拉黑 ' + (name || uid), '#68b26d');
    if (ui) { ui.refreshAll(); }
    try { sweepAll(); } catch (e) { noteError('拉黑后的历史清扫', e); }
  }

  function unblock(uid) {
    if (!hasUid(store.uids, uid)) return;
    delete store.uids[uid];
    saveStore();
    log('解除拉黑', uid);
    statusMsg('已解除 ' + uid + '（旧消息已删，不会恢复；之后的消息可见）', '#68b26d');
    if (ui) { ui.refreshAll(); }
    try { hideSessionNodes(); } catch (e) { noteError('恢复会话项', e); }   // 恢复被隐藏的私聊会话项
  }

  function statusMsg(t, c) { if (ui) ui.setStatus(t, c); else log(t); }

  /* ---------------- 右键头像拉黑 ---------------- */
  function startContextMenu() {
    let menu = null;
    function closeMenu() { if (menu && menu.parentNode) menu.parentNode.removeChild(menu); menu = null; }
    document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);

    document.addEventListener('contextmenu', (e) => {
      if (!store.conf.rightClick) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const host = t.closest('.msgavatar,[data-uid],[ip]');
      if (!host) return;
      const uid = (host.dataset && host.dataset.uid) || host.getAttribute('ip')
        || (host.closest('.msg') && host.closest('.msg').dataset ? String(host.closest('.msg').dataset.id || '').split('_')[0] : null);
      if (!looksLikeUid(uid)) return;

      e.preventDefault(); e.stopPropagation();
      closeMenu();
      const name = (store.seen[uid] || {}).name || (store.uids[uid] || {}).name || '';
      const blocked = isBlocked(uid);
      menu = el('div', {
        position: 'fixed', left: Math.min(e.clientX, window.innerWidth - 150) + 'px',
        top: Math.min(e.clientY, window.innerHeight - 50) + 'px', background: '#26272f',
        border: '1px solid #444', borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,.6)',
        zIndex: Z, overflow: 'hidden',
      });
      menu.id = '__bl_menu__';
      const item = el('div', {
        padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
        color: blocked ? '#68b26d' : '#ffb4ae',
      }, (blocked ? '解除拉黑 ' : '拉黑 ') + (name || uid));
      item.onmouseenter = () => { item.style.background = '#33353f'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      onPress(item, () => { if (blocked) unblock(uid); else block(uid, name); closeMenu(); });
      menu.appendChild(item);
      document.body.appendChild(menu);
    }, true);
  }

  /* ==========================================================================
   * 启动
   * ========================================================================== */
  function init() {
    // 幂等：同一页面被注入两次时，第二份会因"看起来已挂载"而半失效（面板用第二份的名单，过滤用第一份的 store）。
    // 注意必须用独立的已初始化标记，不能用 window.__IIROSE_BLACKLIST__——它在本脚本求值时（init 之前）就已挂上，
    // 拿它当守卫会导致第一次加载就 return（踩过）。
    if (window.__IIROSE_BLACKLIST_INITED__) {
      try { console.warn(TAG, '本页面已加载过拉黑插件，跳过重复注入（版本 ' + VERSION + '）'); } catch (_) { }
      return;
    }
    window.__IIROSE_BLACKLIST_INITED__ = true;
    loadStore();
    waitSocket();
    startDomGuard();
    startContextMenu();
    buildUi();
    // 卸载窗口兜底：拉黑后 200ms 内刷新/切房，节流中的那次改动否则会丢
    try { window.addEventListener('pagehide', flushSave); window.addEventListener('beforeunload', flushSave); } catch (_) { }
    console.log('%c[iirose 拉黑] v' + VERSION + ' 已加载' + (store.enabled ? '' : '（当前为关闭状态）'),
      'color:#ff6b6b;font-weight:bold');
  }

  // 注册排障 API：已存在就不覆盖（否则重复注入时，第二份的空 store 会顶掉第一份的 API，排障结论全错）
  if (!window.__IIROSE_BLACKLIST__) try {
    window.__IIROSE_BLACKLIST__ = {
      version: VERSION,
      get store() { return store; },
      get hooked() { return isHooked(); },          // 实时判定，不是一次性闩锁
      flush: flushSave,
      // 三个开关的非鼠标入口（面板点不动时的备用路径，也是排障对照：API 生效但点击不生效 → 事件被站点吞了）
      setEnabled: function (v) { store.enabled = !!v; saveStore(); if (ui) ui.refreshAll(); return store.enabled; },
      setDebug: function (v) { store.conf.debug = !!v; saveStore(); if (ui) ui.refreshAll(); return store.conf.debug; },
      setRightClick: function (v) { store.conf.rightClick = !!v; saveStore(); if (ui) ui.refreshAll(); return store.conf.rightClick; },
      block: block,
      unblock: unblock,
      isBlocked: isBlocked,
      sweep: sweepAll,
      // 真机排障：逐行报告 DOM 清扫的判断结果，用来定位"为什么这条没删掉"
      debugSweep: function () {
        const boxes = document.getElementsByClassName('msgholderBox');
        const out = [];
        for (let b = 0; b < boxes.length; b++) {
          const rows = [];
          Array.prototype.forEach.call(boxes[b].children, (n) => {
            const uid = uidOfMessageNode(n);
            rows.push({ cls: String(n.className), id: (n.dataset && n.dataset.id) || '', uid: uid, blocked: !!(uid && isBlocked(uid)) });
          });
          out.push({ boxIndex: b, childCount: boxes[b].children.length, rows: rows });
        }
        return { enabled: store.enabled, boxCount: boxes.length, boxes: out, blacklist: Object.keys(store.uids) };
      },
      rawStats: () => JSON.parse(JSON.stringify(rawStats)),
      // 内部函数直通（真机排障用，便于逐行验证判断链）
      _diag: {
        uidOfMessageNode: uidOfMessageNode,
        rowFor: rowFor,
        sweepNode: sweepNode,
        isBlockedIn: (u) => isBlocked(u),
        lastSweep: function () { const d = lastSweepDiag; lastSweepDiag = []; return JSON.parse(JSON.stringify(d)); },
        // 控件点不动时先跑这个：报告每个开关行/按钮的位置、实际渲染尺寸、该点位命中的元素是谁
        // （命中元素不在该行内 → 被别的东西盖住了；尺寸为 0 → 面板根本没显示）
        hitTest: hitTestControls,
        // 自检（打开面板时已自动跑过一次，结果同时写在面板底部状态行）
        selfCheck: selfCheck,
        // 面板"看得见但点不动"的最后一招：把控件坐标映射到父页面（iframe 外）去查那个点上压着什么。
        // 本页元素的 elementFromPoint 看不见 iframe 外面的东西 —— 如果父页面（或别的注入插件）有覆盖层，
        // 渲染不受影响（所以面板看得见），点击却会被它接走。用悬浮球作为"已知能点"的参照点对比。
        whoCovers: function () {
          const out = { inIframe: false, iframeRect: null, iframeView: null, parentView: null, points: [] };
          let fe = null, pd = null;
          try {
            fe = window.frameElement;
            if (fe) { pd = window.parent && window.parent.document; }
          } catch (e) { out.err = '跨域，读不到父页面：' + e.message; return out; }
          if (!fe || !pd) return out;
          out.inIframe = true;
          const fr = fe.getBoundingClientRect();
          out.iframeRect = [fr.left | 0, fr.top | 0, fr.width | 0, fr.height | 0];
          out.iframeView = [window.innerWidth, window.innerHeight];
          try { out.parentView = [window.parent.innerWidth, window.parent.innerHeight]; } catch (_) { }
          const stackOf = (px, py) => {
            try {
              return pd.elementsFromPoint(px, py).map((e) => e.tagName
                + (e.id ? '#' + e.id : '')
                + (e.className ? '.' + String(e.className).slice(0, 28) : '')
                + (e === fe ? ' <== 本插件所在的 iframe' : '')).slice(0, 5);
            } catch (e) { return ['读不到：' + e.message]; }
          };
          const probe = (what, cx, cy) => {
            const px = Math.round(fr.left + cx), py = Math.round(fr.top + cy);
            const inFrame = document.elementFromPoint(cx, cy);
            out.points.push({
              what: what,
              iframeXY: [Math.round(cx), Math.round(cy)],
              parentXY: [px, py],
              inFrame: inFrame ? (inFrame.tagName + (inFrame.className ? '.' + String(inFrame.className).slice(0, 22) : '')) : null,
              parentStack: stackOf(px, py),
            });
          };
          if (arguments.length >= 2) {                       // whoCovers(x, y)：查任意一个 iframe 内坐标
            probe('自定义点', arguments[0], arguments[1]);
            return out;
          }
          // 参照点：悬浮球（已知能点）
          if (ui && ui.fab) {
            const r = ui.fab.getBoundingClientRect();
            probe('悬浮球(参照)', r.left + r.width / 2, r.top + r.height / 2);
          }
          hitTestControls().forEach((i) => {
            if (i.clippedOut) return;
            probe(i.what, i.rect[0] + 6, i.rect[1] + i.rect[3] / 2);
          });
          return out;
        },
        // 手势记录：点几下之后跑这个，看事件走到了哪一层
        // 只有 window 有 → document 那层之前就断了；三层都有但没有 action 条目 → 事件到了、处理器没跑
        gestures: function () { return JSON.parse(JSON.stringify(gestures)); },
        clearGestures: function () { gestures.length = 0; return 'ok'; },
        // 点击是不是被站点吞了：跑这个装上探针，再点一下开关，看控制台打出哪几层
        // （只有 bubble 有 → 站点在捕获阶段 preventDefault；一层都没有 → 站点 stopPropagation）
        watchClick: function (ms) {
          const rep = (tag) => (e) => console.log('[点击探针] ' + tag,
            '目标=' + (e.target && (e.target.className || e.target.tagName)),
            'defaultPrevented=' + e.defaultPrevented,
            '到达我的处理器=' + !!(e.target && e.target.closest && e.target.closest('[data-bl-key],button,.bl-ui')));
          const w1 = rep('window捕获'), w2 = rep('window冒泡'), d1 = rep('document捕获'), d2 = rep('document冒泡');
          window.addEventListener('click', w1, true);
          window.addEventListener('click', w2);
          document.addEventListener('click', d1, true);
          document.addEventListener('click', d2);
          setTimeout(() => {
            window.removeEventListener('click', w1, true); window.removeEventListener('click', w2);
            document.removeEventListener('click', d1, true); document.removeEventListener('click', d2);
            console.log('[点击探针] 已卸载');
          }, ms || 20000);
          return '探针已装（' + ((ms || 20000) / 1000) + ' 秒后自动卸载）：现在去点一下开关';
        },
      },
      // 真机诊断用：把当前页面结构摘要打出来（不截图也能看出选择器对不对）
      dumpDom: function () {
        const pick = (sel, n) => {
          const out = [];
          try {
            Array.prototype.forEach.call(document.querySelectorAll(sel), (e) => {
              if (out.length >= (n || 5)) return;
              out.push({ cls: e.className, id: e.id || '', uid: (e.dataset && e.dataset.uid) || e.getAttribute('ip') || '', dsid: (e.dataset && e.dataset.id) || '', html: (e.outerHTML || '').slice(0, 200) });
            });
          } catch (e) { }
          return out;
        };
        return {
          version: VERSION, hooked: isHooked(), myUid: myUid(),
          msgholderBox: !!document.getElementsByClassName('msgholderBox')[0],
          msgs: pick('.msgholderBox > *', 6),
          ipNodes: pick('[ip]', 6),
          counters: store.counters,
          blacklist: Object.keys(store.uids),
        };
      },
    };
  } catch (e) { }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
