/* 信箱探针 v2 (只读) —— 修正 v1 的两个 bug，并改成「指名道姓地找」
 *
 * v1 的锅（我的）：
 *   ① 名单只从 localStorage 读 —— 若插件走官方 settings 形态，名单根本不在这儿，于是读到 0 人，
 *      结果只把页面上所有带 uid 的元素倒出来（一堆无关的）。
 *   ② 自动存盘被自己下载 json 的 <a> 节点触发 → 5 秒内把 5 次配额用光，你点信箱的时刻没抓到。
 * v2 的改法：
 *   ① 名单优先从插件本体读（window.__IIROSE_BLACKLIST__.store，两种存储都吃），并把它报出来；
 *   ② 只观察「有 socket / 有插件」的同源 frame，忽略 <a>/blob 这类自己造出来的噪音，每次存盘间隔 ≥ 4 秒；
 *   ③ 明文列出候选容器（会话列表 #sessionHolder、消息盒 homeHolderMsgBox、目录 homeHolderMsgContentBox、
 *      资料卡 #selectHolder 等）的条数与样本 HTML —— 不管有没有拉黑人都能看出结构；
 *   ④ 收包钩子每秒自检重挂（站点重连换 socket 也不会漏），并把「挂没挂上」写进存档。
 *
 * 用法：在插件那一层的 console 粘一次 -> 回车，然后：
 *   ① 确认名单读到了人（console 会打印，0 人时它会提醒你）
 *   ② 打开你说的「信箱」面板
 *   ③ 等 1~2 秒（自动存一次），再点开里面那个人的条目
 *   ④ 告诉我一声，我去读下载目录里的 blk-mail2-*.json（你不用复制任何输出）
 * 手动补存：__MAIL2__.scan('手动')     收工：__MAIL2__.stop()
 * 安全：只读。不改 DOM、不改插件、不发请求。跑完 F5 恢复。
 */
(function () {
  if (window.__MAIL2__ && window.__MAIL2__.active) {
    console.log('【已装过】补存一次 = __MAIL2__.scan("手动") ；收工 = __MAIL2__.stop()');
    return;
  }

  var HUNT = { uids: [], names: [] };   // 可手填：{"uids":["5e67013311167"],"names":["某某"]}
  var MAX_SAVES = 8;
  var MIN_SAVE_GAP = 4000;              // 两次存盘至少隔 4 秒（防自己触发自己）
  var WATCH_MS = 180000;
  var CONTAINERS = [
    '#sessionHolder', '.sessionHolderPmTaskBox', '[class*="sessionHolderPmTaskBoxItem"]',
    '[class*="homeHolderMsgBox"]', '[class*="homeHolderMsgContentBox"]', '[class*="homeHolder"]',
    '#selectHolder', '[class*="msgholderBox"]', '[class*="pubMsgSystem"]',
    '[class*="mail"]', '[class*="Mail"]', '[class*="letter"]', '[class*="inbox"]', '[class*="notice"]'
  ];

  var framesSeen = [], prefixCount = {}, netLog = [], rawAdded = [];
  var saves = 0, lastSave = 0, timer = null, stopped = false, wsStatus = {}, obsList = [], lastStore = null;

  // ---------- 名单：优先插件本体 ----------
  function readStore() {
    var out = { uids: {}, names: [], source: [] };
    function eat(list, src) {
      if (!list) return;
      for (var k in list) {
        if (!k) continue;
        var nm = (list[k] && list[k].name) || '';
        out.uids[k] = String(nm);
        if (nm) out.names.push(String(nm));
      }
      out.source.push(src);
    }
    var frs = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frs.length; i++) {
      var w = frs[i].w; if (!w) continue;
      try {
        var A = w.__IIROSE_BLACKLIST__;
        if (A && A.store && A.store.uids) eat(A.store.uids, '插件@' + frs[i].path);
      } catch (e) { }
    }
    if (!Object.keys(out.uids).length) {
      try {
        var raw = localStorage.getItem('iirose_blacklist_v1');
        if (raw) {
          var j = JSON.parse(raw);
          eat((j && j.uids) || null, 'localStorage');
        }
      } catch (e) { }
    }
    for (var a = 0; a < HUNT.uids.length; a++) if (HUNT.uids[a]) { out.uids[HUNT.uids[a]] = out.uids[HUNT.uids[a]] || ''; out.source.push('手填'); }
    for (var b = 0; b < HUNT.names.length; b++) if (HUNT.names[b]) out.names.push(HUNT.names[b]);
    return out;
  }

  // ---------- 工具 ----------
  function desc(n) {
    var s = n.tagName ? n.tagName.toLowerCase() : '?';
    try {
      if (n.id) s += '#' + n.id;
      if (n.classList && n.classList.length) s += '.' + Array.prototype.slice.call(n.classList, 0, 4).join('.');
      var a = [];
      var ATTRS = ['data-uid', 'ip', 'rid', 'data-id', 'data-name', 'n', 't', 'accessory', 'data-systemmsg'];
      for (var i = 0; i < ATTRS.length; i++) { var v = n.getAttribute && n.getAttribute(ATTRS[i]); if (v) a.push(ATTRS[i] + '=' + String(v).slice(0, 40)); }
      if (a.length) s += '[' + a.join(' ') + ']';
    } catch (e) { }
    return s;
  }
  function chainOf(n, up) {
    var out = [], c = n, i = 0;
    while (c && c.nodeType === 1 && i < up) { out.push(desc(c)); c = c.parentNode; i++; }
    return out.join('  <  ');
  }
  function textOf(n) { try { return String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch (e) { return ''; } }
  function outerOf(n, cap) { try { return String(n.outerHTML || '').slice(0, cap || 900); } catch (e) { return ''; } }
  function visOf(n, w) {
    try { var r = n.getBoundingClientRect(), st = w.getComputedStyle(n); return { w: Math.round(r.width), h: Math.round(r.height), display: st.display, vis: st.visibility, op: st.opacity }; } catch (e) { return null; }
  }
  function save(data, tag) {
    try {
      var s = JSON.stringify(data, null, 1);
      var blob = new Blob([s], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-mail2-' + Date.now() + '-' + tag + '.json';
      a.__mail2self = 1;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 3000);
      console.log('【已存文件】blk-mail2-*-' + tag + '.json （' + s.length + ' 字节）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }

  function collect(w, path, acc, depth) {
    acc.push({ w: w, path: path });
    if (depth > 3) return acc;
    var fs = null;
    try { fs = w.frames; } catch (e) { return acc; }
    if (!fs) return acc;
    for (var i = 0; i < fs.length; i++) {
      var cw = null, bad = null;
      try { cw = fs[i]; if (cw.document.title === undefined) throw new Error('no doc'); } catch (e) { bad = String(e && e.message || e); }
      if (bad) { acc.push({ w: null, path: path + '/frame[' + i + ']', crossOrigin: bad }); continue; }
      collect(cw, path + '/frame[' + i + ']', acc, depth + 1);
    }
    return acc;
  }

  // ---------- 收包钩子（每秒自检重挂）----------
  function hookSockets() {
    var frs = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frs.length; i++) {
      var w = frs[i].w; if (!w) continue;
      var s = null;
      try { s = w.socket; } catch (e) { continue; }
      if (!s || typeof s._onmessage !== 'function') { wsStatus[frs[i].path] = 'no-socket'; continue; }
      if (s.__mail2 === true) { wsStatus[frs[i].path] = 'hooked'; continue; }
      try {
        var orig = s._onmessage;
        var path = frs[i].path;
        var wrapped = function () {
          try {
            var d = arguments[0];
            if (typeof d === 'string' && d.length) {
              var p = d.charAt(0);
              var kk = (p === '"' && d.charAt(1) === '"') ? '""' : p;
              prefixCount[kk] = (prefixCount[kk] || 0) + 1;
              framesSeen.push({ f: path, p: kk, len: d.length, s: d.slice(0, 900) });
              if (framesSeen.length > 400) framesSeen.shift();
            }
          } catch (e) { }
          return orig.apply(this, arguments);
        };
        wrapped.__mail2 = 1;
        s._onmessage = wrapped;
        s.__mail2 = true;
        wsStatus[path] = 'hooked-now';
      } catch (e) { wsStatus[frs[i].path] = 'hook-fail:' + e.message; }
    }
  }

  function hookNet() {
    var frs = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frs.length; i++) {
      var w = frs[i].w; if (!w) continue;
      var path = frs[i].path;
      try {
        var XO = w.XMLHttpRequest;
        if (XO && XO.prototype && XO.prototype.open && !XO.prototype.__mail2) {
          var oo = XO.prototype.open, os = XO.prototype.send;
          XO.prototype.open = function (m, u) {
            try { this.__m2u = String(u); netLog.push({ f: path, m: String(m), u: String(u).slice(0, 300) }); if (netLog.length > 200) netLog.shift(); } catch (e) { }
            return oo.apply(this, arguments);
          };
          XO.prototype.send = function () {
            var xhr = this;
            try { xhr.addEventListener('load', function () { try { var t = xhr.responseText; if (t) { netLog.push({ f: path, resp: String(xhr.__m2u || '').slice(0, 200), len: t.length, head: String(t).slice(0, 800) }); if (netLog.length > 200) netLog.shift(); } } catch (e) { } }); } catch (e) { }
            return os.apply(this, arguments);
          };
          XO.prototype.__mail2 = 1;
        }
        if (w.fetch && !w.fetch.__mail2) {
          var of = w.fetch;
          var wf = function (u) { try { netLog.push({ f: path, m: 'fetch', u: String(u && u.url ? u.url : u).slice(0, 300) }); if (netLog.length > 200) netLog.shift(); } catch (e) { } return of.apply(this, arguments); };
          wf.__mail2 = 1; w.fetch = wf;
        }
      } catch (e) { }
    }
  }

  function hookObservers() {
    var frs = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frs.length; i++) {
      var fr = frs[i]; if (!fr.w) continue;
      var isApp = false;
      try { isApp = !!(fr.w.socket || fr.w.__IIROSE_BLACKLIST__); } catch (e) { }
      if (!isApp) continue;                       // 只观察应用 frame：顶层的下载 <a> 噪音不再参与
      if (fr.__obs) continue;
      var D;
      try { D = fr.w.document; } catch (e) { continue; }
      fr.__obs = 1;
      try {
        var mo = new fr.w.MutationObserver(function (ms) {
          if (stopped) return;
          var got = false;
          for (var a = 0; a < ms.length; a++) {
            var add = ms[a].addedNodes;
            for (var b = 0; b < add.length; b++) {
              var nd = add[b];
              if (nd.nodeType !== 1) continue;
              if (nd.__mail2self || nd.tagName === 'A' || nd.tagName === 'SCRIPT' || nd.tagName === 'STYLE') continue;
              var h = outerOf(nd, 1600);
              if (h.length < 60) continue;
              rawAdded.push({ f: fr.path, t: Date.now(), chain: chainOf(nd, 4), len: h.length, text: textOf(nd).slice(0, 140), outer: h.slice(0, 1200) });
              if (rawAdded.length > 60) rawAdded.shift();
              got = true;
            }
          }
          if (!got) return;
          if (timer) return;
          if (saves >= MAX_SAVES) return;
          var wait = Math.max(1200, MIN_SAVE_GAP - (Date.now() - lastSave));
          timer = setTimeout(function () { timer = null; run('auto'); }, wait);
        });
        mo.observe(D.body, { childList: true, subtree: true });
        obsList.push(mo);
      } catch (e) { }
    }
  }

  // ---------- 扫 DOM ----------
  function candidateRows(D, n) {                 // 候选"行/卡片"节点：命中者 + 其被点开的资料卡入口
    var out = [];
    for (var i = 0; i < n.length; i++) out.push(n[i]);
    return out;
  }

  function scanDoc(entry, st) {
    var rec = { path: entry.path, url: '', title: '', crossOrigin: entry.crossOrigin || null, records: [], containers: [] };
    var w = entry.w; if (!w) return rec;
    var D;
    try { D = w.document; rec.url = String(w.location.href); rec.title = String(D.title || ''); } catch (e) { rec.crossOrigin = String(e.message); return rec; }
    try {
      rec.plugin = !!(w.__IIROSE_BLACKLIST__);
      rec.hasSocket = !!(w.socket && typeof w.socket._onmessage === 'function');
      rec.wsStatus = wsStatus[entry.path] || null;
      rec.localStore = (function () { try { var r = localStorage.getItem('iirose_blacklist_v1'); return r ? r.slice(0, 300) : null; } catch (e) { return 'err'; } })();
    } catch (e) { }

    // 候选容器：条数 + 样本行
    for (var c = 0; c < CONTAINERS.length; c++) {
      var sel = CONTAINERS[c], nodes;
      try { nodes = D.querySelectorAll(sel); } catch (e) { continue; }
      if (!nodes.length) continue;
      var item = { sel: sel, count: nodes.length };
      var sample = null, childRows = 0;
      for (var q = 0; q < nodes.length && !sample; q++) {
        var n0 = nodes[q];
        var grandkids = n0.children && n0.children.length;
        if (grandkids) {
          childRows = grandkids;
          var firstRow = n0.children[0];
          sample = { row: desc(firstRow), rowLen: outerOf(firstRow, 1500).length, rowOuter: outerOf(firstRow, 1200), rowChildren: firstRow.children.length, rowChildTags: Array.prototype.slice.call(firstRow.children, 0, 8).map(desc) };
        }
      }
      item.childCount = childRows;
      item.sampleRow = sample;
      item.uidOccur = (function () { var html = ''; try { html = String(nodes[0].outerHTML || ''); } catch (e) { } var o = {}; for (var u in st.uids) { var k = 0, ix = -1; while ((ix = html.indexOf(u, ix + 1)) >= 0) k++; if (k) o[u] = k; } return o; })();
      rec.containers.push(item);
    }

    // 命中：uid/ip/onclick 命中黑名单，或文本里出现被拉黑者的名字
    var all;
    try { all = D.querySelectorAll('*'); } catch (e) { return rec; }
    var seen = {}, hits = [];
    for (var i = 0; i < all.length && hits.length < 200; i++) {
      var n = all[i], ds = n.dataset || {};
      var hitUids = [];
      for (var u2 in st.uids) {
        if (!u2) continue;
        var ip = n.getAttribute && n.getAttribute('ip');
        if (String(ds.uid || '') === u2 || String(ip || '') === u2 || String(n.getAttribute && n.getAttribute('onclick') || '').indexOf(u2) >= 0) hitUids.push(u2);
      }
      var byName = false, tx = '';
      if (!hitUids.length && st.names.length) {
        tx = textOf(n);
        for (var k2 = 0; k2 < st.names.length; k2++) if (st.names[k2] && tx.indexOf(st.names[k2]) >= 0 && tx.length < 200) { byName = true; break; }
      }
      if (!hitUids.length && !byName) continue;
      var sig = chainOf(n, 3) + '|' + outerOf(n, 60);
      if (seen[sig]) continue; seen[sig] = 1;
      var row = n;
      // 往上找"整行"：父节点为止，最多 4 层，找出带 ip/data-uid 的那层或直接父
      hits.push({
        whyUid: hitUids, whyName: byName,
        tag: desc(n), chain: chainOf(n, 6), text: textOf(n), vis: visOf(n, w),
        parentChain: chainOf(n.parentNode, 4),
        parentOuter: outerOf(n.parentNode, 900),
        outer: outerOf(n, 1200)
      });
    }
    rec.records = hits;
    return rec;
  }

  function run(tag) {
    if (stopped) return;
    var now = Date.now();
    if (tag === 'auto' && now - lastSave < MIN_SAVE_GAP) return;
    hookSockets(); hookNet(); hookObservers();
    var st = readStore();
    lastStore = st;
    var frs = collect(window.top || window, 'top', [], 0);
    var out = {
      when: new Date().toISOString(), tag: tag,
      store: { uids: st.uids, names: st.names, source: st.source },
      prefixCount: prefixCount, wsStatus: wsStatus,
      framesSeen: framesSeen.slice(-250), netLog: netLog.slice(-120),
      rawAdded: rawAdded.slice(-30), frames: []
    };
    var lines = [];
    for (var i = 0; i < frs.length; i++) {
      try { var r = scanDoc(frs[i], st); out.frames.push(r); lines.push((r.path || '?') + ' 命中=' + ((r.records && r.records.length) || 0) + ' 容器=' + ((r.containers && r.containers.length) || 0) + ' plugin=' + (!!r.plugin) + ' ws=' + (r.wsStatus || '-') + ' ' + (r.url || r.crossOrigin || '')); }
      catch (e) { out.frames.push({ path: frs[i].path, error: String(e && e.message || e) }); }
    }
    console.log('【信箱探针v2】' + tag + ' —— 名单来源：' + st.source.join(',') + ' | 人数：' + Object.keys(st.uids).length + ' | 收包前缀：' + JSON.stringify(prefixCount));
    for (var l = 0; l < lines.length; l++) console.log('   ' + lines[l]);
    saves++; lastSave = now;
    save(out, tag + saves);
  }

  window.__MAIL2__ = {
    active: true, hunt: HUNT,
    scan: function (t) { run(t || '手动'); },
    frames: function () { return framesSeen.slice(-20); },
    added: function () { return rawAdded.slice(-10); },
    store: function () { return readStore(); },
    stop: function () { stopped = true; for (var i = 0; i < obsList.length; i++) { try { obsList[i].disconnect(); } catch (e) { } } console.log('【信箱探针v2】已停'); }
  };

  var st0 = readStore();
  if (!Object.keys(st0.uids).length) console.log('【提醒】名单读到 0 人（来源：' + (st0.source.join(',') || '无') + '）—— 请先在插件面板里拉黑一个人，再打开信箱；或手填 __MAIL2__.hunt.uids=["<uid>"] 后 __MAIL2__.scan("手填")');
  else console.log('【已装好】名单 ' + Object.keys(st0.uids).length + ' 人：' + JSON.stringify(st0.uids));
  console.log('   下一步：① 打开「信箱」 ② 等 1~2 秒 ③ 点开里面来自被拉黑者的条目 ④ 告诉我一声');
  console.log('   立刻补存 = __MAIL2__.scan("手动")   收工 = __MAIL2__.stop()');
  hookSockets(); hookNet(); hookObservers();
  run('now');
  setInterval(function () { if (!stopped) hookSockets(); }, 1000);
  setTimeout(function () { if (!stopped) { try { window.__MAIL2__.stop(); } catch (e) { } } }, WATCH_MS);
})();
