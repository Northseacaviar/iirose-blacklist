/*! 拉黑 loader v2.0 */
(function () {
  'use strict';

  // 已在运行就不再注入
  if (window.__IIROSE_BLACKLIST__ || window.__IIROSE_BLACKLIST_INITED__) {
    try { console.log('[拉黑/loader] 插件已在运行，跳过加载'); } catch (e) { }
    return;
  }

  var MAIN = 'iirose-blacklist.js';
  var REPO = 'Northseacaviar/iirose-blacklist';            // owner/repo
  var FALLBACK_HOSTS = ['fastly.jsdelivr.net', 'gcore.jsdelivr.net'];
  // gcore 的 @main 缓存旧
  var GCORE = 'gcore.jsdelivr.net';
  var PROBE_TIMEOUT = 6000;                                 // 单个候选取回上限（毫秒）
  var TAG_TIMEOUT = 2500;                                   // 问 tag 的上限
  var STATE = { self: '', mode: '', candidates: [], probes: [], chosen: null, tag: null, fallback: false };

  try { window.__IIROSE_BLACKLIST_LOADER__ = STATE; } catch (e) { }

  /* 自身地址 */
  function selfUrl() {
    var s = document.currentScript;
    if (!s) {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/loader\.js(\?|$)/.test(all[i].src || '')) { s = all[i]; break; }
      }
    }
    return (s && s.src) || '';
  }

  STATE.self = selfUrl();
  var base = STATE.self
    ? STATE.self.replace(/[^/]*$/, '')                     // 去掉文件名，保留目录
    : 'https://cdn.jsdelivr.net/gh/' + REPO + '/';
  // 测试钩子：假地址假仓库
  var TESTHOOK = window.__BL_LOADER_TEST__;
  if (TESTHOOK && TESTHOOK.base) base = TESTHOOK.base;
  if (TESTHOOK && TESTHOOK.repo) REPO = TESTHOOK.repo;
  var dir = base.replace(/\/$/, '');
  var pinned = /@[^\/]+\/?$/.test(dir);                     // 钉了版本就尊重它
  var onJsd = /jsdelivr\.net/.test(base);


  /* 版本比较 */
  function parseVer(v) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function cmpVer(a, b) {
    var x = parseVer(a), y = parseVer(b);
    if (!x && !y) return 0;
    if (!x) return -1;
    if (!y) return 1;
    for (var i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; }
    return 0;
  }
  function pickHighest(list) {                              // 取版本最高者
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.ver) continue;
      if (!best || cmpVer(c.ver, best.ver) > 0) best = c;
    }
    return best;
  }

  /* 取文本 */
  function getText(url, ms, cb) {
    var done = false, timer = setTimeout(function () { if (!done) { done = true; cb(null); } }, ms);
    function finish(text) { if (done) return; done = true; clearTimeout(timer); cb(text); }
    try {
      if (window.fetch) {
        fetch(url, { cache: 'no-store', credentials: 'omit' })
          .then(function (r) { return r.text(); })
          .then(function (t) { finish(t); })
          .catch(function () { finish(null); });
        return;
      }
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.onload = function () { finish(x.status >= 200 && x.status < 400 ? x.responseText : null); };
      x.onerror = function () { finish(null); };
      x.send();
    } catch (e) { finish(null); }
  }

  /* 候选地址 */
  function hostSwap(u, h) { return u.replace(/^https?:\/\/[^/]+\//, location.protocol + '//' + h + '/'); }

  function buildCandidates(tag) {
    var forms = [];                                          // 同主机候选，版本高者胜
    if (pinned || !onJsd) return [base + MAIN];              // 钉版本/本地：只同目录取
    if (tag) {
      // 新 tag 不可变，必回源
      forms.push(dir + '@' + tag + '/' + MAIN);
    }
    forms.push(dir + '@main/' + MAIN);                       // 分支：可能被 CDN 缓存 12 小时
    forms.push(dir + '/' + MAIN);                            // 无 ref：最新 tag 快照
    var list = forms.slice();
    var host = base.match(/^https?:\/\/([^/]+)\//);
    if (host) {
      FALLBACK_HOSTS.forEach(function (h) {
        if (h === host[1]) return;
        var hs = forms.slice();
        // gcore 的 @main 缓存旧，排后
        if (h === GCORE) hs.sort(function (a, b) { return (/@main/.test(a) ? 1 : 0) - (/@main/.test(b) ? 1 : 0); });
        hs.forEach(function (u) { list.push(hostSwap(u, h)); });
      });
    }
    // 去重，别重复发请求
    var seen = {}, out = [];
    list.forEach(function (u) { if (!seen[u]) { seen[u] = 1; out.push(u); } });
    return out;
  }

  /* 问最新 tag */
  function discoverTag(cb) {
    getText('https://api.github.com/repos/' + REPO + '/tags?per_page=100', TAG_TIMEOUT, function (txt) {
      if (txt) {
        try {
          var arr = JSON.parse(txt), names = [];
          for (var i = 0; i < arr.length; i++) {
            var n = arr[i] && arr[i].name;
            if (n && parseVer(n)) names.push({ name: n, ver: n });
          }
          var best = pickHighest(names);
          if (best) { STATE.tag = best.name; return cb(best.name); }
        } catch (e) { }
      }
      // 退到 jsdelivr 数据 API
      getText('https://data.jsdelivr.com/v1/packages/gh/' + REPO, TAG_TIMEOUT, function (t2) {
        if (t2) {
          try {
            var o = JSON.parse(t2), vs = [];
            (o.versions || []).forEach(function (v) {
              if (v && v.version && parseVer(v.version)) vs.push({ name: 'v' + String(v.version).replace(/^v/, ''), ver: v.version });
            });
            var b2 = pickHighest(vs);
            if (b2) { STATE.tag = b2.name; return cb(b2.name); }
          } catch (e) { }
        }
        cb(null);
      });
    });
  }

  /* 注入 */
  function inject(url, next, onOk) {
    var s = document.createElement('script');
    s.async = true;
    s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    s.onload = function () { if (onOk) onOk(s.src); };
    s.onerror = function () {
      try { console.warn('[拉黑/loader] 加载失败：' + s.src); } catch (e) { }
      if (next) next();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function report(line) {
    try { console.log('[拉黑/loader] ' + line); } catch (e) { }
  }

  // 兜底：按序注入，失败换下一个
  function fallbackRun(list) {
    STATE.fallback = true;
    var tried = 0;
    function tryNext() {
      if (tried >= list.length) {
        report('所有地址都加载失败（网络被拦或 CDN 不可达）。可临时改用直连地址：' + list[0] + '?v=' + Date.now());
        return;
      }
      inject(list[tried++], tryNext);
    }
    tryNext();
  }

  /* 主流程 */
  function run(list, tag) {
    STATE.mode = 'probe';
    STATE.candidates = list;
    var left = list.length, results = [];
    if (!left) return fallbackRun(list);

    list.forEach(function (url) {
      getText(url, PROBE_TIMEOUT, function (text) {
        var ver = text ? ((text.match(/const VERSION = '([^']+)'/) || [])[1] || null) : null;
        results.push({ url: url, ver: ver, ok: !!text });
        STATE.probes.push({ url: url, ver: ver, ok: !!text });
        if (--left === 0) choose();
      });
    });

    function choose() {
      var best = pickHighest(results);
      if (!best) {
        report('所有候选都取不回来（断网 / 被拦 / CORS），改用顺序注入兜底');
        return fallbackRun(list);
      }
      STATE.chosen = best.url;
      report('选用 v' + best.ver + ' ← ' + best.url + (tag ? '（GitHub 最新 tag ' + tag + '）' : ''));
      inject(best.url, function () { fallbackRun(list); }, function (src) {
        STATE.loaded = src;
        var got = (window.__IIROSE_BLACKLIST__ && window.__IIROSE_BLACKLIST__.version) || best.ver;
        report('主脚本已就绪：v' + got + '（来源 ' + src + '）');
      });
    }
  }

  if (pinned || !onJsd) {
    // 本地/钉版本：不探测，直接取
    STATE.mode = pinned ? 'pinned' : 'direct';
    inject(base + MAIN, null, function (src) {
      STATE.chosen = base + MAIN;
      STATE.loaded = src;
      report('主脚本已就绪：v'
        + ((window.__IIROSE_BLACKLIST__ && window.__IIROSE_BLACKLIST__.version) || '?')
        + '（来源 ' + src + '）');
    });
  } else {
    discoverTag(function (tag) { run(buildCandidates(tag), tag); });
  }
})();
