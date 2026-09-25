/*!
 * iirose 拉黑屏蔽 · iirose-blacklist v0.1.0
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

  const VERSION = '0.1.0';
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
      uids: {},                       // uid -> { name, ts }  黑名单
      seen: {},                       // uid -> { name, ts }  最近见过的人（用于面板里按名字拉黑）
      counters: { room: 0, priv: 0, danmaku: 0, dom: 0 },
      conf: { rightClick: true, debug: false },
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

  /**
   * 帧结构（官方文档 + iiroseForge 生产验证）：
   *   房间消息 `"`  + rec1<rec2<…   rec 字段：0 消息id | 1 头像 | 2 用户名 | 3 内容 | 4 颜色 | 5 颜色 | 6 | 7 | 8 uid | 9 头衔 | 10 随机数
   *   私聊     `""` + rec1<rec2<…   rec 字段：0 消息id | 1 发送者uid | 2 用户名 | 3 头像 | 4 内容 | 5 颜色 | 6 | 7 颜色 | 8 | 9 背景图 | 10 随机数
   *   弹幕     `=`  + 单条记录      字段：0 用户名 | 1 内容 | 2 颜色 | 3 颜色 | 4 | 5 头像 | 6 消息id | 7 uid | 8 头衔 | …
   * 返回 { data, changed, blocked[] }；data 为 null 表示整帧丢弃。
   */
  function filterFrame(data, store, hooks) {
    const out = { data: data, changed: false, blocked: [], kind: null };
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
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const f = rec.split('>');
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
      // 整帧丢弃：房间/私聊帧里只剩空记录时也别发给客户端
      out.data = kept.some(r => r.length) ? (head + kept.join('<')) : null;
    }
    return out;
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

  function loadStore() {
    try {
      store = normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
    } catch (e) {
      store = defaultStore();
    }
  }

  function saveStore() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { }
    }, 200);
  }

  function log() {
    if (!store.conf.debug) return;
    try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) { }
  }

  function myUid() {
    try { return window.uid || null; } catch (e) { return null; }
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

  let hooked = false;

  function tryHookSocket() {
    const sock = window.socket;
    if (!sock || typeof sock._onmessage !== 'function') return false;
    if (sock.__blWrapped) { hooked = true; return true; }

    const orig = sock._onmessage;
    sock._onmessage = function () {
      const args = arguments;
      try {
        if (typeof args[0] === 'string' && args[0].length) {
          const p = args[0].charAt(0);
          rawStats[p] = (rawStats[p] || 0) + 1;
          const r = filterFrame(args[0], store, hookCbs);
          if (r.changed) {
            if (r.data === null) return;                    // 整帧丢弃
            args[0] = r.data;
          }
        }
      } catch (e) {
        log('过滤异常（已放行）', e && e.message);
      }
      return orig.apply(this, args);
    };
    sock.__blWrapped = true;
    hooked = true;
    log('已挂载收包过滤');
    return true;
  }

  function waitSocket() {
    if (tryHookSocket()) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (tryHookSocket() || n > 600) { clearInterval(t); if (n > 600) log('未找到 window.socket，收包过滤未挂载'); }
    }, 500);
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
  function rowFor(node) {
    if (node.classList && node.classList.contains('msg')) return node;
    const m = node.closest ? node.closest('.msg') : null;
    if (m) return m;
    let cur = node;
    while (cur && cur.parentNode && !(cur.parentNode.classList && cur.parentNode.classList.contains('msgholderBox'))) cur = cur.parentNode;
    return (cur && cur !== document.documentElement && cur !== document.body) ? cur : node;
  }

  function hideSessionNodes(scope) {
    let list;
    try { list = (scope || document).querySelectorAll('[ip]'); } catch (e) { return; }
    Array.prototype.forEach.call(list, (n) => {
      const uid = n.getAttribute('ip');
      if (!looksLikeUid(uid)) return;
      const hide = store.enabled && isBlocked(uid);
      if (hide && !n.hasAttribute('data-bl-hidden')) {
        n.setAttribute('data-bl-hidden', '1');
        n.style.display = 'none';
        store.counters.dom++;
        saveStore();
      } else if (!hide && n.hasAttribute('data-bl-hidden')) {   // 解除拉黑后恢复
        n.removeAttribute('data-bl-hidden');
        n.style.display = '';
      }
    });
  }

  let lastSweepDiag = [];

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
        if (row.parentNode) { row.parentNode.removeChild(row); removed++; store.counters.dom++; }
      }
    });
    lastSweepDiag.push(diag);
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
    } catch (e) { log('消息清扫异常', e && e.message); }
    return removed;
  }

  function sweepAll() {
    const removed = sweepMessages();
    try { hideSessionNodes(); } catch (e) { log('会话项清扫异常', e && e.message); }
    if (removed) log('清扫历史消息', removed, '条');
    return removed;
  }

  // 会话项扫描按 500ms 节流；消息清扫在观察者里按节点就地做，不整体重扫
  let sessTimer = null;
  function scheduleSessionSweep(scope) {
    if (sessTimer) return;
    sessTimer = setTimeout(() => {
      sessTimer = null;
      try { hideSessionNodes(scope); } catch (e) { }
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
      // 兜底：每 5 秒整体扫一次（只遍历可见消息，开销小），防漏网
      setInterval(() => { try { sweepAll(); } catch (e) { } }, 5000);
    } catch (e) { log('DOM 守卫启动失败', e && e.message); }
  }

  /* ==========================================================================
   * UI
   * ========================================================================== */
  let ui = null;

  const Z = '2147483000';
  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) for (const k in style) n.style[k] = style[k];
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function makeDraggable(node, handle, onClick) {
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
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    title.appendChild(closeBtn);
    panel.appendChild(title);

    // 开关
    const swRow = el('div', { padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #2a2b33' });
    const chk = el('input'); chk.type = 'checkbox'; chk.checked = store.enabled;
    const chkLabel = el('span', null, '启用屏蔽');
    chk.onchange = () => {
      store.enabled = chk.checked; saveStore();
      log('屏蔽开关', store.enabled);
      setStatus(store.enabled ? '已开启屏蔽' : '已关闭屏蔽（名单保留）', store.enabled ? '#68b26d' : '#d0a04a');
      setTimeout(() => { if (store.enabled) sweepAll(); }, 50);
    };
    swRow.appendChild(chk); swRow.appendChild(chkLabel);
    const dbgWrap = el('label', { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', color: '#888', cursor: 'pointer' });
    const dbg = el('input'); dbg.type = 'checkbox'; dbg.checked = !!store.conf.debug;
    dbg.onchange = () => { store.conf.debug = dbg.checked; saveStore(); log('调试日志', dbg.checked); };
    dbgWrap.appendChild(dbg); dbgWrap.appendChild(el('span', null, '调试日志'));
    swRow.appendChild(dbgWrap);
    panel.appendChild(swRow);

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
    const foot = el('div', { display: 'flex', gap: '6px', padding: '0 12px 10px' });
    const copyBtn = el('button', {
      background: '#2a2b33', color: '#bbb', border: '1px solid #444', borderRadius: '5px',
      padding: '5px 10px', cursor: 'pointer', fontSize: '11px',
    }, '复制名单');
    copyBtn.onclick = () => {
      const lines = Object.keys(store.uids).map(u => u + '\t' + (store.uids[u].name || ''));
      const text = lines.join('\n') || '(名单为空)';
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(text);
        else { input.value = text; input.select(); document.execCommand('copy'); }
        setStatus('已复制 ' + lines.length + ' 条到剪贴板', '#68b26d');
      } catch (e) { setStatus('复制失败，见控制台', '#ec4141'); log(text); }
    };
    const resetBtn = el('button', {
      background: '#2a2b33', color: '#bbb', border: '1px solid #444', borderRadius: '5px',
      padding: '5px 10px', cursor: 'pointer', fontSize: '11px',
    }, '清空统计');
    resetBtn.onclick = () => {
      store.counters = { room: 0, priv: 0, danmaku: 0, dom: 0 }; saveStore(); refreshAll();
      setStatus('统计已清零', '#68b26d');
    };
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
      b.onclick = onClick;
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
      stats.textContent = '已屏蔽：房间 ' + c.room + ' · 私聊 ' + c.priv + ' · 弹幕 ' + c.danmaku + ' · 历史 ' + c.dom;
    }

    function refreshAll() { refreshBlacklist(); refreshSeen(); refreshStats(); chk.checked = store.enabled; }

    addBtn.onclick = () => {
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
    input.onkeydown = (e) => { if (e.key === 'Enter') addBtn.onclick(); };

    document.body.appendChild(panel);
    document.body.appendChild(fab);
    makeDraggable(fab, fab, () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (panel.style.display === 'flex') refreshAll();
    });
    makeDraggable(panel, title);

    ui = { panel, fab, setStatus, refreshAll, refreshSeen, refreshStats, refreshBlacklist };
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
    sweepAll();
  }

  function unblock(uid) {
    if (!hasUid(store.uids, uid)) return;
    delete store.uids[uid];
    saveStore();
    log('解除拉黑', uid);
    statusMsg('已解除 ' + uid + '（旧消息已删，不会恢复；之后的消息可见）', '#68b26d');
    if (ui) { ui.refreshAll(); }
    hideSessionNodes();   // 恢复被隐藏的私聊会话项
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
      const item = el('div', {
        padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
        color: blocked ? '#68b26d' : '#ffb4ae',
      }, (blocked ? '解除拉黑 ' : '拉黑 ') + (name || uid));
      item.onmouseenter = () => { item.style.background = '#33353f'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.onclick = () => { if (blocked) unblock(uid); else block(uid, name); closeMenu(); };
      menu.appendChild(item);
      document.body.appendChild(menu);
    }, true);
  }

  /* ==========================================================================
   * 启动
   * ========================================================================== */
  function init() {
    loadStore();
    waitSocket();
    startDomGuard();
    startContextMenu();
    buildUi();
    console.log('%c[iirose 拉黑] v' + VERSION + ' 已加载' + (store.enabled ? '' : '（当前为关闭状态）'),
      'color:#ff6b6b;font-weight:bold');
  }

  try {
    window.__IIROSE_BLACKLIST__ = {
      version: VERSION,
      get store() { return store; },
      get hooked() { return hooked; },
      block: block,
      unblock: unblock,
      isBlocked: isBlocked,
      sweep: sweepAll,
      // 真机排障：逐行报告 DOM 清扫的判断结果，用来定位"为什么这条没删掉"
      debugSweep: function () {
        const box = document.getElementsByClassName('msgholderBox')[0];
        const rows = [];
        if (box) {
          Array.prototype.forEach.call(box.children, (n) => {
            const uid = uidOfMessageNode(n);
            rows.push({ cls: String(n.className), id: (n.dataset && n.dataset.id) || '', uid: uid, blocked: !!(uid && isBlocked(uid)) });
          });
        }
        return { enabled: store.enabled, boxFound: !!box, childCount: box ? box.children.length : -1, rows: rows, blacklist: Object.keys(store.uids) };
      },
      rawStats: () => JSON.parse(JSON.stringify(rawStats)),
      // 内部函数直通（真机排障用，便于逐行验证判断链）
      _diag: {
        uidOfMessageNode: uidOfMessageNode,
        rowFor: rowFor,
        sweepNode: sweepNode,
        isBlockedIn: (u) => isBlocked(u),
        lastSweep: function () { const d = lastSweepDiag; lastSweepDiag = []; return JSON.parse(JSON.stringify(d)); },
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
          version: VERSION, hooked: hooked, myUid: myUid(),
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
