/* 信箱探针 (只读) —— 专治「信箱里的消息怎么来的、长什么样」
 * 目的：一次抓齐三样东西
 *   ① 所有 WS 收包原文（含前缀）—— 看信箱消息走哪个前缀、字段里有没有 uid
 *   ② 所有 XHR/fetch 的 URL 与响应开头 —— 判断信箱是不是用 HTTP 拉回来的
 *   ③ DOM 里跟「被拉黑的人」有关的新增节点原文 + 祖先链 —— 看信箱条目的真实结构
 * 用法：在你平时注入插件的那层 console 里粘贴本文件全部内容 -> 回车
 *       然后：打开「信箱」→ 如果有被拉黑的人给你发过东西/点过赞，把它展开
 *       每次有新内容出现，约 1.2 秒后自动存一个 json 到「下载」目录（blk-mail-*.json），最多 5 个
 *       想立刻再存一次：__MAIL_HUNT__.scan()      想收工：__MAIL_HUNT__.stop()
 *       跑完告诉我一声即可，我去读下载目录里的文件（你不用复制任何输出）
 * 安全：只读 —— 不改 DOM、不改插件、不发请求，只是"旁听"。跑完 F5 即恢复
 */
(function () {
  if (window.__MAIL_HUNT__ && window.__MAIL_HUNT__.active) {
    console.log('【已装过】立刻再扫 = __MAIL_HUNT__.scan() ；收工 = __MAIL_HUNT__.stop()');
    return;
  }

  var MAX_FRAME_KEEP = 400;    // 保留最近多少条收包原文
  var MAX_NET_KEEP = 200;
  var MAX_RAW_KEEP = 60;       // 保留多少个"新出现节点"的原文
  var MAX_REC = 300;           // 每个文档最多记多少条命中
  var MAX_SAVES = 5;
  var DEBOUNCE_MS = 1200;
  var WATCH_MS = 120000;

  // 可手填；留空则自动用 localStorage 里的插件名单（uid + 名字）
  var HUNT = { uids: [], names: [] };

  var framesSeen = [], prefixCount = {}, netLog = [], rawAdded = [];
  var armed = {}, obsList = [], saves = 0, timer = null, stopped = false;

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

  var ATTRS = ['data-uid', 'ip', 'rid', 'data-id', 'data-systemmsg', 'n', 'accessory', 't', 'data-user', 'data-g', 'user', 'uid'];
  function desc(n) {
    var s = n.tagName ? n.tagName.toLowerCase() : '?';
    try {
      if (n.id) s += '#' + n.id;
      if (n.classList && n.classList.length) s += '.' + Array.prototype.slice.call(n.classList, 0, 4).join('.');
      var a = [];
      for (var i = 0; i < ATTRS.length; i++) { var v = n.getAttribute && n.getAttribute(ATTRS[i]); if (v) a.push(ATTRS[i] + '=' + String(v).slice(0, 48)); }
      if (a.length) s += '[' + a.join(' ') + ']';
    } catch (e) { }
    return s;
  }
  function chainOf(n, up) {
    var out = [], c = n, i = 0;
    while (c && c.nodeType === 1 && i < up) { out.push(desc(c)); c = c.parentNode; i++; }
    return out.join('  <  ');
  }
  function textOf(n) { try { return String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch (e) { return ''; } }
  function visOf(n, w) {
    try {
      var r = n.getBoundingClientRect(), st = w.getComputedStyle(n);
      return { w: Math.round(r.width), h: Math.round(r.height), display: st.display, vis: st.visibility, op: st.opacity };
    } catch (e) { return null; }
  }
  function save(data, tag) {
    try {
      var s = JSON.stringify(data, null, 1);
      var blob = new Blob([s], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-mail-' + Date.now() + '-' + tag + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 3000);
      console.log('【已存文件】下载目录 blk-mail-*-' + tag + '.json （' + s.length + ' 字节）');
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

  // ---- 旁听：WS 收包 / XHR / fetch ----
  function armListeners(entry) {
    var w = entry.w; if (!w) return;
    var s;
    try { s = w.socket; } catch (e) { s = null; }
    if (s && typeof s._onmessage === 'function' && !armed[entry.path + '|ws']) {
      armed[entry.path + '|ws'] = 1;
      var orig = s._onmessage;
      var wrapped = function () {
        try {
          var d = arguments[0];
          if (typeof d === 'string' && d.length) {
            var p = d.charAt(0);
            var kk = (p === '"' && d.charAt(1) === '"') ? '""' : p;
            prefixCount[kk] = (prefixCount[kk] || 0) + 1;
            framesSeen.push({ f: entry.path, p: kk, len: d.length, s: d.slice(0, 900) });
            if (framesSeen.length > MAX_FRAME_KEEP) framesSeen.shift();
          }
        } catch (e) { }
        return orig.apply(this, arguments);
      };
      wrapped.__mailhunt = 1;
      try { s._onmessage = wrapped; } catch (e) { }
    }
    if (!armed[entry.path + '|net']) {
      armed[entry.path + '|net'] = 1;
      try {
        var XO = w.XMLHttpRequest;
        if (XO && XO.prototype && XO.prototype.open && !XO.prototype.__mailhunt) {
          var oo = XO.prototype.open, os = XO.prototype.send;
          XO.prototype.open = function (m, u) {
            try { this.__mu = String(u); netLog.push({ f: entry.path, m: String(m), u: String(u).slice(0, 300) }); if (netLog.length > MAX_NET_KEEP) netLog.shift(); } catch (e) { }
            return oo.apply(this, arguments);
          };
          XO.prototype.send = function () {
            var xhr = this;
            try {
              xhr.addEventListener('load', function () {
                try {
                  var t = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '';
                  if (t) netLog.push({ f: entry.path, resp: String(xhr.__mu || '').slice(0, 200), len: t.length, head: String(t).slice(0, 800) });
                  if (netLog.length > MAX_NET_KEEP) netLog.shift();
                } catch (e) { }
              });
            } catch (e) { }
            return os.apply(this, arguments);
          };
          XO.prototype.__mailhunt = 1;
        }
        if (w.fetch && !w.fetch.__mailhunt) {
          var of = w.fetch;
          var wf = function (u, o) {
            try { netLog.push({ f: entry.path, m: 'fetch', u: String(u && u.url ? u.url : u).slice(0, 300) }); if (netLog.length > MAX_NET_KEEP) netLog.shift(); } catch (e) { }
            return of.apply(this, arguments);
          };
          wf.__mailhunt = 1;
          w.fetch = wf;
        }
      } catch (e) { }
    }
  }

  function armObservers() {
    var frames = collect(window.top || window, 'top', [], 0);
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i]; if (!fr.w) continue;
      armListeners(fr);
      if (armed[fr.path + '|obs']) continue;
      var D;
      try { D = fr.w.document; } catch (e) { continue; }
      armed[fr.path + '|obs'] = 1;
      try {
        var mo = new fr.w.MutationObserver(function (ms) {
          if (stopped) return;
          var got = false;
          for (var a = 0; a < ms.length; a++) {
            var add = ms[a].addedNodes;
            for (var b = 0; b < add.length; b++) {
              var nd = add[b];
              if (nd.nodeType !== 1) continue;
              var h = '';
              try { h = String(nd.outerHTML || ''); } catch (e) { h = ''; }
              if (h.length < 40) continue;
              rawAdded.push({ f: fr.path, t: Date.now(), chain: chainOf(nd, 4), len: h.length, outer: h.slice(0, 1200), text: textOf(nd).slice(0, 120) });
              if (rawAdded.length > MAX_RAW_KEEP) rawAdded.shift();
              got = true;
            }
          }
          if (!got) return;
          if (timer) return;
          if (saves >= MAX_SAVES) return;
          timer = setTimeout(function () { timer = null; run('auto'); }, DEBOUNCE_MS);
        });
        mo.observe(D.body, { childList: true, subtree: true });
        obsList.push(mo);
      } catch (e) { }
    }
  }

  // ---- 扫 DOM：找出跟被拉黑者有关的节点 ----
  function scanDoc(entry, st) {
    var rec = { path: entry.path, url: '', title: '', crossOrigin: entry.crossOrigin || null, records: [] };
    var w = entry.w; if (!w) return rec;
    var D;
    try { D = w.document; rec.url = String(w.location.href); rec.title = String(D.title || ''); } catch (e) { rec.crossOrigin = String(e.message); return rec; }
    try {
      rec.plugin = !!(w.__IIROSE_BLACKLIST__);
      rec.hasSocket = !!(w.socket && typeof w.socket._onmessage === 'function');
      rec.bodyChildren = Array.prototype.slice.call(D.body.children, 0, 15).map(function (n) {
        var h = ''; try { h = String(n.outerHTML || ''); } catch (e) { }
        return { tag: desc(n), len: h.length, head: h.slice(0, 220) };
      });
      // 疑似"信箱/面板"容器：按 class 关键词列出来（不猜内容，只报存在与大小）
      var panel = D.querySelectorAll('[class*="mail"],[class*="Mail"],[class*="letter"],[class*="inbox"],[class*="notice"],[class*="email"],[class*="MsgBox"],[class*="panel"]');
      rec.panels = Array.prototype.slice.call(panel, 0, 25).map(function (n) { var h = ''; try { h = String(n.outerHTML || ''); } catch (e) { } return { tag: desc(n), len: h.length, text: textOf(n).slice(0, 100) }; });
    } catch (e) { }

    try {
      var html = D.documentElement.outerHTML;
      rec.htmlLen = html.length;
      rec.uidOccur = {}; rec.nameOccur = {};
      for (var u in st.uids) { var c = 0, ix = -1; while ((ix = html.indexOf(u, ix + 1)) >= 0) c++; rec.uidOccur[u] = c; }
      for (var i2 = 0; i2 < st.names.length; i2++) { var nm = st.names[i2]; if (!nm) continue; var c2 = 0, ix2 = -1; while ((ix2 = html.indexOf(nm, ix2 + 1)) >= 0) c2++; rec.nameOccur[nm] = c2; }
    } catch (e) { }

    var list;
    try { list = D.querySelectorAll('*'); } catch (e) { return rec; }
    var seen = {}, out = [];
    for (var i = 0; i < list.length && out.length < MAX_REC; i++) {
      var n = list[i], ds = n.dataset || {}, why = null;
      if (ds.uid) why = 'data-uid';
      else if (n.getAttribute && n.getAttribute('ip')) why = 'ip';
      else {
        for (var u3 in st.uids) { if (u3 && String(n.getAttribute && n.getAttribute('onclick') || '').indexOf(u3) >= 0) { why = 'onclick-uid'; break; } }
      }
      if (!why && st.names.length) {
        var tx = textOf(n);
        for (var k = 0; k < st.names.length; k++) if (st.names[k] && tx.indexOf(st.names[k]) >= 0 && tx.length < 160) { why = 'name'; break; }
      }
      if (!why) continue;
      var sig = chainOf(n, 4) + '|' + textOf(n).slice(0, 40);
      if (seen[sig]) continue; seen[sig] = 1;
      var bl = [];
      for (var u4 in st.uids) {
        if (!u4) continue;
        if (String(ds.uid || '') === u4 || String(n.getAttribute && n.getAttribute('ip') || '') === u4 ||
          String(n.getAttribute && n.getAttribute('onclick') || '').indexOf(u4) >= 0) bl.push(u4);
      }
      out.push({ why: why, blacklistedUid: bl, tag: desc(n), text: textOf(n), vis: visOf(n, w), chain: chainOf(n, 5), outer: String(n.outerHTML || '').slice(0, 1000) });
    }
    rec.records = out;
    return rec;
  }

  function run(tag) {
    if (stopped) return;
    var st = readStore();
    armObservers();
    var frames = collect(window.top || window, 'top', [], 0);
    var out = {
      when: new Date().toISOString(), tag: tag,
      store: { uids: st.uids, names: st.names },
      prefixCount: prefixCount, framesSeen: framesSeen.slice(-250), netLog: netLog.slice(-150),
      rawAdded: rawAdded.slice(-40), frames: []
    };
    var lines = [];
    for (var i = 0; i < frames.length; i++) {
      try { var r = scanDoc(frames[i], st); out.frames.push(r); lines.push((r.path || '?') + ' 命中=' + (r.records ? r.records.length : 0) + ' plugin=' + (!!r.plugin) + ' socket=' + (!!r.hasSocket) + ' ' + (r.url || r.crossOrigin || '')); }
      catch (e) { out.frames.push({ path: frames[i].path, error: String(e && e.message || e) }); }
    }
    console.log('【信箱探针】' + tag + ' —— 扫了 ' + out.frames.length + ' 个文档：');
    for (var l = 0; l < lines.length; l++) console.log('   ' + lines[l]);
    try { console.log('   收包前缀计数：' + JSON.stringify(prefixCount) + '  网络请求 ' + netLog.length + ' 条 / 新增节点 ' + rawAdded.length + ' 条'); } catch (e) { }
    saves++;
    save(out, tag + saves);
  }

  window.__MAIL_HUNT__ = {
    active: true, hunt: HUNT,
    scan: function () { run('manual'); },
    frames: function () { return framesSeen.slice(-20); },
    net: function () { return netLog.slice(-20); },
    added: function () { return rawAdded.slice(-10); },
    stop: function () { stopped = true; for (var i = 0; i < obsList.length; i++) { try { obsList[i].disconnect(); } catch (e) { } } console.log('【信箱探针】已停'); }
  };

  var st0 = readStore();
  console.log('【已装好】拉黑名单读到 ' + Object.keys(st0.uids).length + ' 人（' + st0.names.join('、') + '）');
  console.log('   下一步：① 打开「信箱」 ② 把里面来自被拉黑者的那条展开 —— 每次有新内容约 1.2 秒后自动存一个 json 到下载目录');
  console.log('   立刻再存一次 = __MAIL_HUNT__.scan()   看最近收包 = __MAIL_HUNT__.frames()   收工 = __MAIL_HUNT__.stop()');
  run('now');
  armObservers();
  setTimeout(function () { if (!stopped) { try { window.__MAIL_HUNT__.stop(); } catch (e) { } } }, WATCH_MS);
})();
