/*!
 * iirose 拉黑 · 手机诊断 / 免终端注入脚本（mobile-probe）
 * 版本 probe-1  2026-09-25
 *
 * 用途：手机上排查「悬浮球不显示」这类问题。它做两件事：
 *   ① 不依赖站点终端：在主文档里找到 #mainFrame，把插件脚本注入进那个 iframe（手机浏览器书签里就能跑）
 *   ② 在两个上下文里各挂一条红色状态横幅，把关键事实直接写在屏幕上（手机不好开控制台）
 *
 * 用法（任选其一）：
 *   A. 存成书签后点一下（地址栏粘贴时注意手动补回开头的 javascript:）
 *   B. 站点终端里注入本文件地址
 *   C. 已注入插件的情况下，也能单独注入本文件当"体检"
 *
 * 想换插件地址：本文件末尾 PLUGIN 常量。
 */
(function () {
  'use strict';
  var PLUGIN = 'https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/iirose-blacklist.js';
  var TAG = '[iirose 手机诊断]';
  var BANNER_ID = '__iirose_probe_banner';

  function q(sel, doc) { try { return (doc || document).querySelector(sel); } catch (e) { return null; } }
  function vw(w) { try { return w.innerWidth + '×' + w.innerHeight; } catch (e) { return '?'; } }
  function isTop() { try { return window === window.top; } catch (e) { return true; } }
  function ctxName() {
    try { return isTop() ? '顶层窗口(站点外壳)' : 'iframe ' + (window.location && window.location.pathname); }
    catch (e) { return '未知上下文'; }
  }
  function frameDoc() {
    var f = q('#mainFrame');
    if (!f) return null;
    try { return f.contentDocument || null; } catch (e) { return null; }
  }
  function probeIn(w, doc, label) {
    var out = [];
    out.push('· ' + label + '：视口 ' + vw(w) + '，dpr ' + (w.devicePixelRatio || 1));
    out.push('· ' + label + '：document.body ' + (doc && doc.body ? '有' : '无') +
      '，readyState=' + (doc ? doc.readyState : '?'));
    var sock = '未知';
    try { sock = (w.socket && typeof w.socket._onmessage === 'function') ? '有' : '无（未登录或还没连上）'; } catch (e) { sock = '取不到'; }
    out.push('· ' + label + '：window.socket._onmessage ' + sock);
    var ver = '未加载';
    try { if (w.__IIROSE_BLACKLIST_VERSION__) ver = w.__IIROSE_BLACKLIST_VERSION__; } catch (e) { }
    out.push('· ' + label + '：插件已加载？' + ver);
    var inited = false;
    try { inited = !!w.__IIROSE_BLACKLIST_INITED__; } catch (e) { }
    out.push('· ' + label + '：插件 init 完成？' + (inited ? '是' : '否（脚本跑到了但初始化没走完）'));
    try {
      var bd = doc && doc.body;
      if (bd) {
        var last = bd.lastElementChild;
        out.push('· ' + label + '：body 子节点 ' + bd.children.length + ' 个，末尾节点：' +
          (last ? String(last.outerHTML).slice(0, 90) : '无'));
      }
    } catch (e) { }
    var fab = null;
    try { fab = doc && doc.querySelector ? doc.querySelector('div[title^="拉黑 v"]') : null; } catch (e) { }
    if (fab) {
      var r = fab.getBoundingClientRect();
      out.push('· ' + label + '：悬浮球存在，位置 ' + Math.round(r.left) + ',' + Math.round(r.top) +
        '，尺寸 ' + Math.round(r.width) + '×' + Math.round(r.height));
      var covered = '测不到';
      try {
        var top = (w.document || doc).elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        covered = (top === fab || (top && fab.contains(top))) ? '最上层就是它（可点）' : ('被 ' + (top ? (top.tagName + '.' + (top.className || '')) : 'null') + ' 盖住');
      } catch (e) { covered = '测不到：' + e.message; }
      out.push('· ' + label + '：悬浮球命中检测 → ' + covered);
    } else {
      out.push('· ' + label + '：悬浮球节点不存在');
    }
    var err = '（无）';
    try { if (w.__iiroseLastError) err = w.__iiroseLastError; } catch (e) { }
    out.push('· ' + label + '：脚本错误 = ' + err);
    var ext = null;
    try { ext = w.localStorage.getItem('extJs'); } catch (e) { }
    out.push('· ' + label + '：extJs = ' + (ext === null ? '（空，即站点终端里没注入过地址）' : '"' + String(ext).slice(0, 120) + '"'));
    return out;
  }
  function scan(extra) {
    var lines = [];
    lines.push('iirose 拉黑 · 手机诊断 probe-1');
    lines.push('· 当前脚本运行在：' + ctxName());
    try { lines.push('· 页面地址：' + window.location.href); } catch (e) { }
    lines = lines.concat(probeIn(window, document, isTop() ? '本窗口' : 'iframe'));
    if (isTop()) {
      var f = q('#mainFrame');
      lines.push('· 顶层：找到 #mainFrame ' + (f ? ('是，src=' + String(f.src).slice(0, 60)) : '否'));
      var d = frameDoc();
      if (!d) lines.push('· 顶层：iframe 文档读不到（跨域或还没建好）');
      else {
        try { lines = lines.concat(probeIn(f.contentWindow, d, 'iframe内')); } catch (e) { }
      }
    }
    if (extra) lines.push('· ' + extra);
    return lines;
  }
  function banner(lines) {
    var doc = document, id = BANNER_ID;
    var box = doc.getElementById(id);
    if (!box) {
      box = doc.createElement('div');
      box.id = id;
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:rgba(179,38,30,.96);' +
        'color:#fff;font:12px/1.55 -apple-system,PingFang SC,Microsoft YaHei,sans-serif;padding:10px 34px 10px 12px;' +
        'white-space:pre-wrap;word-break:break-all;max-height:80vh;overflow:auto;-webkit-overflow-scrolling:touch;';
      var close = doc.createElement('span');
      close.textContent = '✕';
      close.style.cssText = 'position:absolute;right:8px;top:6px;font-size:18px;padding:4px 6px;cursor:pointer;';
      close.onclick = function () { box.style.display = 'none'; };
      box.appendChild(close);
      var body = doc.createElement('div');
      body.id = id + '_body';
      box.appendChild(body);
      (doc.body || doc.documentElement).appendChild(box);
    }
    var target = doc.getElementById(id + '_body');
    target.textContent = lines.join('\n');
    return box;
  }
  function injectIntoIframe() {
    if (!isTop()) return '本脚本已在 iframe 内，不重复注入';
    var d = frameDoc();
    if (!d || !d.body) return 'iframe 还没就绪，稍后重试';
    // 关键：iframe 可能在注入之后才真正导航完成（provisional 文档被换掉），只看"标签在不在"会误判成已注入。
    // 所以以"插件自己有没有落地"为准，每次重扫都允许补注入。
    var landed = false;
    try { landed = !!(d.defaultView && d.defaultView.__IIROSE_BLACKLIST_VERSION__); } catch (e) { }
    if (landed) return 'iframe 内插件已落地';
    if (d.getElementById('__iirose_bl_injected')) return '已注入过，等它执行';
    try {
      var iw = d.defaultView || d.parentWindow;
      if (iw && !iw.__iiroseErrHooked) {
        iw.__iiroseErrHooked = true;
        iw.__iiroseLastError = null;
        iw.addEventListener('error', function (ev) {
          try { iw.__iiroseLastError = 'error: ' + (ev.message || ev.type) + ' @' + (ev.filename || '') + ':' + (ev.lineno || 0); } catch (e) { }
        });
        iw.addEventListener('unhandledrejection', function (ev) {
          try { iw.__iiroseLastError = 'promise: ' + (ev.reason && (ev.reason.message || ev.reason)); } catch (e) { }
        });
      }
    } catch (e) { }
    var s = d.createElement('script');
    s.id = '__iirose_bl_injected';
    // 注意：file:// 地址加查询串会被浏览器拒绝加载（实测），只对 http(s) 做缓存串
    var bust = /^https?:/i.test(PLUGIN) ? (PLUGIN.indexOf('?') < 0 ? '?probe=1' : '&probe=1') : '';
    s.src = PLUGIN + bust;
    s.onerror = function () { banner(scan('插件脚本加载失败：' + PLUGIN)); };
    (d.body || d.documentElement).appendChild(s);
    return '已把插件脚本注入 iframe：' + s.src;
  }

  try {
    window.__iiroseLastError = window.__iiroseLastError || null;
    window.addEventListener('error', function (ev) {
      try { window.__iiroseLastError = 'error: ' + (ev.message || ev.type) + ' @' + (ev.filename || '') + ':' + (ev.lineno || 0); } catch (e) { }
    });
  } catch (e) { }
  var note = '';
  try {
    note = injectIntoIframe();
  } catch (e) {
    note = '注入出错：' + e.message;
  }
  banner(scan(note));
  [1500, 4000, 9000].forEach(function (ms) {
    setTimeout(function () {
      if (isTop()) { try { note = injectIntoIframe(); } catch (e) { note = '注入出错：' + e.message; } }
      banner(scan(note));
    }, ms);
  });
  try {
    window.__IIROSE_PROBE__ = {
      dump: function () { return scan(note).join('\n'); },
      plugin: PLUGIN,
      reinject: injectIntoIframe
    };
  } catch (e) { }
  try { console.log(TAG, 'diagnostic banner shown'); } catch (e) { }
})();
