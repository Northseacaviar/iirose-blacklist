/* 寻人探针 (只读) —— 找「被拉黑者」在页面里所有露头的地方
 * 用途：定位 ① 本房间目录(成员列表)里的用户卡片  ② 房间推荐页点开房间的卡片  长什么样、在哪个 frame 里、uid 藏在哪
 * 用法：在你平时注入插件的那层 console 里粘贴本文件全部内容 -> 回车
 *       粘完先别动，看 console 打出【已装好】；然后【打开房间目录】、【点开推荐页的房间卡片】
 *       每点一次，约 1.2 秒后自动存一个 json 到「下载」目录（文件名 blk-hunt-*.json）；总共最多存 4 个
 *       用完告诉我一声，我去读文件 —— 你不用复制任何输出
 * 安全：只读，不改 DOM、不发请求、不动插件；跑完可以 F5
 */
(function () {
  if (window.__BLK_HUNT__ && window.__BLK_HUNT__.active) {
    console.log('【已装过】现在扫一次 = __BLK_HUNT__.scan() ；停掉 = __BLK_HUNT__.stop()');
    return;
  }

  // 名单留空 = 自动从 localStorage 的插件名单读；也可以手填（都填也不要紧）
  var HUNT = { uids: [], names: [] };

  var MAX_ELEMS = 30000;        // 每个文档最多看这么多元素，防卡
  var MAX_REC = 400;            // 每个文档最多记这么多条
  var DEBOUNCE_MS = 1200;       // 点开后等多久扫（等动画/接口回来）
  var MAX_SAVES = 4;            // 最多存几个文件
  var WATCH_MS = 60000;         // 监视窗口，超过就自动停

  // ---------- 名单 ----------
  function readStore() {
    var out = { uids: {}, names: [] };
    try {
      var raw = localStorage.getItem('iirose_blacklist_v1');
      if (raw) {
        var j = JSON.parse(raw), u = (j && j.uids) || {};
        for (var k in u) { if (!u[k]) continue; out.uids[k] = String(u[k].name || ''); if (u[k].name) out.names.push(String(u[k].name)); }
      }
    } catch (e) { }
    for (var i = 0; i < HUNT.uids.length; i++) { var x = HUNT.uids[i]; if (x) out.uids[x] = out.uids[x] || ''; }
    for (var j2 = 0; j2 < HUNT.names.length; j2++) { if (HUNT.names[j2]) out.names.push(String(HUNT.names[j2])); }
    return out;
  }

  // ---------- 工具 ----------
  var ATTRS = ['data-uid', 'ip', 'rid', 'data-id', 'data-systemmsg', 'n', 'accessory', 't', 'data-user', 'data-g', 'user'];
  function desc(n) {
    var s = n.tagName ? n.tagName.toLowerCase() : '?';
    try {
      if (n.id) s += '#' + n.id;
      if (n.classList && n.classList.length) s += '.' + Array.prototype.slice.call(n.classList, 0, 4).join('.');
      var a = [];
      for (var i = 0; i < ATTRS.length; i++) {
        var v = n.getAttribute && n.getAttribute(ATTRS[i]);
        if (v) a.push(ATTRS[i] + '=' + String(v).slice(0, 48));
      }
      if (a.length) s += '[' + a.join(' ') + ']';
    } catch (e) { }
    return s;
  }
  function chain(n, up) {
    var out = [], c = n, i = 0;
    while (c && c.nodeType === 1 && i < up) { out.push(desc(c)); c = c.parentNode; i++; }
    return out.join('  <  ');
  }
  function visible(n) {
    try {
      var r = n.getBoundingClientRect();
      var st = window.getComputedStyle(n);
      return { w: Math.round(r.width), h: Math.round(r.height), display: st.display, vis: st.visibility, op: st.opacity };
    } catch (e) { return null; }
  }
  function textOf(n) {
    try { return String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140); } catch (e) { return ''; }
  }
  function save(data, tag) {
    try {
      var s = JSON.stringify(data, null, 1);
      var blob = new Blob([s], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-hunt-' + Date.now() + '-' + tag + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 3000);
      console.log('【已存文件】下载目录 blk-hunt-*-' + tag + '.json （' + s.length + ' 字节）');
      return true;
    } catch (e) { console.log('【存文件失败】' + e.message); return false; }
  }

  // ---------- 收包抓帧（看信箱这类消息走的是什么前缀/字段）----------
  var framesSeen = [];      // 最近的收包原文（含前缀），最多 300 条
  var prefixCount = {};     // 各前缀出现次数
  var netLog = [];          // XHR / fetch 的 URL（判断信箱是不是走 HTTP 取回来的）
  var armed = {};

  function armFrameCapture(entry) {
    var w = entry.w; if (!w) return;
    var key = entry.path + '|frame';
    if (armed[key]) return;
    var s;
    try { s = w.socket; } catch (e) { return; }
    if (!s || typeof s._onmessage !== 'function') return;
    armed[key] = 1;
    var orig = s._onmessage;
    var wrapped = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length) {
          var p = d.charAt(0);
          var kk = p + (p === '"' && d.charAt(1) === '"' ? '"' : '');
          prefixCount[kk] = (prefixCount[kk] || 0) + 1;
          framesSeen.push({ f: entry.path, p: kk, len: d.length, s: d.slice(0, 700) });
          if (framesSeen.length > 300) framesSeen.shift();
        }
      } catch (e) { }
      return orig.apply(this, arguments);
    };
    wrapped.__hunt = 1;
    try { s._onmessage = wrapped; } catch (e) { }
  }

  function armNetCapture(entry) {
    var w = entry.w; if (!w) return;
    var key = entry.path + '|net';
    if (armed[key]) return;
    armed[key] = 1;
    try {
      var XO = w.XMLHttpRequest;
      if (XO && XO.prototype && XO.prototype.open && !XO.prototype.__hunt) {
        var oo = XO.prototype.open;
        XO.prototype.open = function (m, u) {
          try { netLog.push({ f: entry.path, m: String(m), u: String(u).slice(0, 300) }); if (netLog.length > 200) netLog.shift(); } catch (e) { }
          return oo.apply(this, arguments);
        };
        XO.prototype.__hunt = 1;
      }
      if (w.fetch && !w.fetch.__hunt) {
        var of = w.fetch;
        var wf = function (u) {
          try { netLog.push({ f: entry.path, m: 'fetch', u: String(u && u.url ? u.url : u).slice(0, 300) }); if (netLog.length > 200) netLog.shift(); } catch (e) { }
          return of.apply(this, arguments);
        };
        wf.__hunt = 1;
        w.fetch = wf;
      }
    } catch (e) { }
  }

  function armAll() {
    var frames = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frames.length; i++) { armFrameCapture(frames[i]); armNetCapture(frames[i]); }
  }

  // ---------- 收集 frame ----------
  function collect(w, path, acc, depth) {
    acc.push({ w: w, path: path });
    if (depth > 3) return acc;
    var fs = null;
    try { fs = w.frames; } catch (e) { return acc; }
    if (!fs) return acc;
    for (var i = 0; i < fs.length; i++) {
      var cw = null; var bad = null;
      try { cw = fs[i]; var t = cw.document.title; if (t === undefined) throw new Error('no doc'); } catch (e) { bad = String(e && e.message || e); }
      if (bad) { acc.push({ w: null, path: path + '/frame[' + i + ']', crossOrigin: bad }); continue; }
      collect(cw, path + '/frame[' + i + ']', acc, depth + 1);
    }
    return acc;
  }

  // ---------- 扫一个文档 ----------
  function scanDoc(entry, st) {
    var w = entry.w;
    var rec = { path: entry.path, url: '', title: '', crossOrigin: entry.crossOrigin || null };
    if (!w) return rec;
    var D;
    try { D = w.document; rec.url = String(w.location.href); rec.title = String(D.title || ''); } catch (e) { rec.crossOrigin = String(e.message); return rec; }
    try {
      rec.plugin = !!(w.__IIROSE_BLACKLIST__);
      rec.pluginVersion = (w.__IIROSE_BLACKLIST__ && w.__IIROSE_BLACKLIST__.version) || null;
      rec.hasSocket = !!(w.socket && typeof w.socket._onmessage === 'function');
      var fabs = 0, all0 = D.querySelectorAll('*');
      for (var q = 0; q < all0.length; q++) { if (String(all0[q].textContent || '').trim() === '🚫') fabs++; }
      rec.fabCount = fabs;
      rec.bodyChildClasses = Array.prototype.slice.call(D.body.children, 0, 12).map(function (n) { return desc(n); });
    } catch (e) { }

    // uid 在整篇 HTML 里出现几次（判断"根本不含 uid"还是"含但没认出来"）
    try {
      var html = D.documentElement.outerHTML;
      rec.htmlLen = html.length;
      rec.uidOccur = {};
      for (var u in st.uids) {
        var n = 0, idx = -1;
        while ((idx = html.indexOf(u, idx + 1)) >= 0) n++;
        rec.uidOccur[u] = n;
      }
      for (var i2 = 0; i2 < st.names.length; i2++) {
        var nm = st.names[i2];
        if (!nm) continue;
        var n2 = 0, id2 = -1;
        while ((idx = html.indexOf(nm, id2 + 1)) >= 0) n2++;
        rec['nameOccur:' + nm] = n2;
      }
    } catch (e) { }

    var list = [];
    try { list = D.querySelectorAll('*'); } catch (e) { return rec; }
    var cap = Math.min(list.length, MAX_ELEMS);
    var recs = [];
    var seen = {};
    for (var i = 0; i < cap && recs.length < MAX_REC; i++) {
      var n = list[i];
      var ds = n.dataset || {};
      var cls = String(n.className || '');
      var hit = null;
      if (ds.uid) hit = 'data-uid';
      else if (n.getAttribute && n.getAttribute('ip')) hit = 'ip';
      else if (n.getAttribute && n.getAttribute('rid')) hit = 'rid';
      else if (/whois|selectHolder|member|userList|userlist|directory|roomList|roomcard|room_card|profile|pubMsgSystem/i.test(cls)) hit = 'class';
      else if (st.names.length) {
        var tx = textOf(n);
        for (var k = 0; k < st.names.length; k++) { if (st.names[k] && tx.indexOf(st.names[k]) >= 0 && tx.length < 160) { hit = 'name'; break; } }
      }
      else if (n.getAttribute && n.getAttribute('onclick') && st.uids) {
        var oc = String(n.getAttribute('onclick'));
        for (var u2 in st.uids) { if (u2 && oc.indexOf(u2) >= 0) { hit = 'onclick-uid'; break; } }
      }
      if (!hit) continue;
      // 命中 uid 的（最要紧）单独标出来
      var uidHit = [];
      for (var u3 in st.uids) {
        if (!u3) continue;
        if (String(ds.uid || '') === u3) uidHit.push(u3);
        else if (String(n.getAttribute && n.getAttribute('ip') || '') === u3) uidHit.push(u3);
        else if (String(n.getAttribute && n.getAttribute('onclick') || '').indexOf(u3) >= 0) uidHit.push(u3);
      }
      var sig = chain(n, 5) + '|' + textOf(n).slice(0, 40);
      if (seen[sig]) continue;
      seen[sig] = 1;
      recs.push({
        why: hit,
        blacklistedUid: uidHit,
        tag: desc(n),
        childCount: n.children ? n.children.length : 0,
        ownAttrs: (function () { var o = {}; for (var ai = 0; ai < ATTRS.length; ai++) { var v = n.getAttribute && n.getAttribute(ATTRS[ai]); if (v) o[ATTRS[ai]] = String(v).slice(0, 120); } return o; })(),
        onclick: (n.getAttribute && String(n.getAttribute('onclick') || '').slice(0, 400)) || '',
        text: textOf(n),
        vis: visible(n),
        chain: chain(n, 5),
        outer: String(n.outerHTML || '').slice(0, 900)
      });
    }
    rec.records = recs;
    rec.elemScanned = cap;
    return rec;
  }

  // ---------- 主流程 ----------
  var st = readStore();
  var saves = 0, timer = null, stopped = false, obsList = [];

  function runAll(tag) {
    if (stopped) return;
    var frames = collect(window.top || window, 'top', [], 0);
    st = readStore();
    armAll();
    var out = { when: new Date().toISOString(), tag: tag, store: { uids: st.uids, names: st.names },
      prefixCount: prefixCount, framesSeen: framesSeen.slice(-200), netLog: netLog.slice(-120), frames: [] };
    var lines = [];
    for (var i = 0; i < frames.length; i++) {
      try {
        var r = scanDoc(frames[i], st);
        out.frames.push(r);
        lines.push((r.path || '?') + '  hits=' + ((r.records && r.records.length) || 0) + '  plugin=' + (!!r.plugin) + '  socket=' + (!!r.hasSocket) + '  ' + (r.url || r.crossOrigin || ''));
      } catch (e) { out.frames.push({ path: frames[i].path, error: String(e && e.message || e) }); }
    }
    try {
      out.scanCount = (window.__BLK_HUNT__.runs = (window.__BLK_HUNT__.runs || 0) + 1);
    } catch (e) { out.scanCount = 1; }
    console.log('【寻人探针】' + tag + ' 扫了 ' + out.frames.length + ' 个文档：');
    for (var l = 0; l < lines.length; l++) console.log('   ' + lines[l]);
    try { console.log('   收包前缀计数：' + JSON.stringify(prefixCount)); } catch (e) { }
    saves++;
    save(out, tag + saves);
  }

  function armWatch() {
    var frames = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frames.length; i++) {
      (function (fr) {
        if (!fr.w) return;
        var D;
        try { D = fr.w.document; } catch (e) { return; }
        try {
          var mo = new fr.w.MutationObserver(function (ms) {
            if (stopped) return;
            var interesting = false;
            for (var a = 0; a < ms.length; a++) {
              var add = ms[a].addedNodes;
              for (var b = 0; b < add.length; b++) {
                var nd = add[b];
                if (nd.nodeType === 1 && nd.outerHTML && nd.outerHTML.length > 60) { interesting = true; break; }
              }
              if (interesting) break;
            }
            if (!interesting) return;
            if (timer) return;
            if (saves >= MAX_SAVES) return;
            timer = setTimeout(function () { timer = null; runAll('auto'); }, DEBOUNCE_MS);
          });
          mo.observe(D.body, { childList: true, subtree: true });
          obsList.push(mo);
        } catch (e) { }
      })(frames[i]);
    }
  }

  window.__BLK_HUNT__ = {
    active: true,
    hunt: HUNT,
    scan: function () { runAll('manual'); },
    stop: function () { stopped = true; for (var i = 0; i < obsList.length; i++) { try { obsList[i].disconnect(); } catch (e) { } } console.log('【寻人探针】已停'); },
    frames: function () { return collect(window.top || window, 'top', [], 0).map(function (f) { return f.path + ' ' + (f.crossOrigin || 'same-origin'); }); }
  };

  console.log('【已装好】拉黑名单里读到 ' + Object.keys(st.uids).length + ' 人（' + st.names.join('、') + '）');
  console.log('   接下来：① 打开房间目录  ② 点开推荐页的房间卡片 —— 每次点开约 1.2 秒后自动存一个 json 到下载目录');
  console.log('   想立刻再扫：__BLK_HUNT__.scan() ；想收工：__BLK_HUNT__.stop()');
  runAll('now');
  armWatch();
  setTimeout(function () { if (!stopped) { try { window.__BLK_HUNT__.stop(); } catch (e) { } } }, WATCH_MS);
})();
