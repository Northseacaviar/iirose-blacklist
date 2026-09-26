/*!
 * iirose 拉黑屏蔽 · 加载器（loader）v2.0 · 2026-09-26
 * 作者：Corvin Hermes（为北海做）
 *
 * 作用：**只注入这一个地址，就永远是最新版**。主脚本更新后不需要重贴地址、不需要改 ?v=、不需要手动刷 CDN。
 * 自己怎么用：站点里 `js` 粘贴下面这一行（和以前一样存在 extJs 里，可与其他插件地址空格分隔）：
 *   https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js
 * 想钉死版本（不跟更新）就在地址里带版本： https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist@v0.3.3/loader.js
 *
 * ------------------------------------------------------------------------------------------------
 * v2.0 为什么重写（v1.2 的真实事故，2026-09-26 真机）：
 *   v1.2 把「@main 分支」当作「最新」，只按顺序失败降级。问题是 **jsdelivr 对分支引用的缓存是 12 小时**
 *   （s-maxage=43200），而 `?t=时间戳` 只能绕开浏览器缓存 —— CDN 忽略查询串，照旧发回它那份旧快照。
 *   结果：v0.3.0/0.3.1/0.3.2 连发三版，用户页面上跑的仍是 v0.2.4（实测与 tag v0.2.6 的发布件 md5 相同），
 *   新功能在他那里等于「没实现」。降级链只在「拉不到」时有用，对「拉到的是旧的」完全无效。
 *
 * v2.0 的做法：**先比版本，再注入**，不信任任何单一地址。
 *   1. 候选地址并行取回文本（不执行），从每个文件里读出 `const VERSION = 'x.y.z'`；
 *   2. 选版本号最高的那个注入 —— 于是「@main 还停在旧版、tag 快照已是新版」这种局面会自动走新版；
 *   3. 候选来源（多一条路就多一分拿到新版的概率）：
 *        · 同主机 @main 分支
 *        · 同主机 无 ref 地址（= 最新 tag 快照）
 *        · 问 GitHub 拿最新 tag（api.github.com，浏览器可直连），拼出 @<tag> 的**不可变**地址（新 tag 一定是新的）
 *        · fastly / gcore 两个备用域名上的同样组合
 *   4. 全都取不到（断网/被拦/CORS）→ 退回 v1.2 那套「按顺序注入、失败降级」，保证总有一份能跑；
 *   5. 选了哪个、各地址各是什么版本，都写进 `window.__IIROSE_BLACKLIST_LOADER__`，控制台也打一行，
 *      排查时一眼能看出「到底跑的是哪一版、从哪个地址来的」。
 *
 * 不做的（刻意的）：
 *   - 不做后台静默热更新：脚本一旦执行就不该被替换，刷新页面才换版（和任何注入脚本一样）；
 *   - 不写 localStorage（官方规范：存储交给插件自己的双形态适配层）；
 *   - 本地/非 jsdelivr 环境下不做探测，直接取同目录的主脚本（file:// 下探测会被 CORS 拦，反而拖慢）。
 */
(function () {
  'use strict';

  // 已经在跑了就别再来一份（重复注入会被主脚本的幂等守卫挡掉，但这里先省一次请求）
  if (window.__IIROSE_BLACKLIST__ || window.__IIROSE_BLACKLIST_INITED__) {
    try { console.log('[拉黑/loader] 插件已在运行，跳过加载'); } catch (e) { }
    return;
  }

  var MAIN = 'iirose-blacklist.js';
  var REPO = 'Northseacaviar/iirose-blacklist';            // owner/repo：GitHub API 用
  var FALLBACK_HOSTS = ['fastly.jsdelivr.net', 'gcore.jsdelivr.net'];
  // gcore 那份 @main 缓存 purge 接口管不到（providers 只报 CF + FY，实测 gcore 的 @main 长期停在旧版），
  // 所以对它把「非 @main」的候选排在前面。
  var GCORE = 'gcore.jsdelivr.net';
  var PROBE_TIMEOUT = 6000;                                 // 单个候选的取回上限（毫秒）
  var TAG_TIMEOUT = 2500;                                   // 问 GitHub 要 tag 的上限：拿不到就不拖时间
  var STATE = { self: '', mode: '', candidates: [], probes: [], chosen: null, tag: null, fallback: false };

  try { window.__IIROSE_BLACKLIST_LOADER__ = STATE; } catch (e) { }

  /* ---------- 自身地址与目录 ---------- */
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
    ? STATE.self.replace(/[^/]*$/, '')                     // 去掉文件名，保留目录（含协议与主机）
    : 'https://cdn.jsdelivr.net/gh/' + REPO + '/';
  // 测试钩子：本地桩页用它把「自身地址」与仓库换成假的，从而能在不联网的情况下验 v2 的探测逻辑
  // （没有它就只能靠真 CDN 碰运气，测不到「候选里有旧版时会不会挑新版」这种关键分支）。
  var TESTHOOK = window.__BL_LOADER_TEST__;
  if (TESTHOOK && TESTHOOK.base) base = TESTHOOK.base;
  if (TESTHOOK && TESTHOOK.repo) REPO = TESTHOOK.repo;
  var dir = base.replace(/\/$/, '');
  var pinned = /@[^\/]+\/?$/.test(dir);                     // 地址自带 @版本 = 用户钉了版本，尊重它
  var onJsd = /jsdelivr\.net/.test(base);


  /* ---------- 版本号工具 ---------- */
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
  function pickHighest(list) {                              // list: [{name,ver}] → 版本最高者
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.ver) continue;
      if (!best || cmpVer(c.ver, best.ver) > 0) best = c;
    }
    return best;
  }

  /* ---------- 取文本（不执行）：fetch 优先，XHR 兜底 ---------- */
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

  /* ---------- 候选地址 ---------- */
  function hostSwap(u, h) { return u.replace(/^https?:\/\/[^/]+\//, location.protocol + '//' + h + '/'); }

  function buildCandidates(tag) {
    var forms = [];                                          // 同主机上的候选（按"新到旧"的直觉排，真正决定权在版本比较）
    if (pinned || !onJsd) return [base + MAIN];              // 钉版本 / 本地：只同目录取
    if (tag) {
      // 新 tag 的地址是**不可变**的：CDN 上第一次请求必然回源，所以它一定是最新的那一版
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
        // gcore 的 @main 缓存是旧的，把它的非 @main 候选排前面
        if (h === GCORE) hs.sort(function (a, b) { return (/@main/.test(a) ? 1 : 0) - (/@main/.test(b) ? 1 : 0); });
        hs.forEach(function (u) { list.push(hostSwap(u, h)); });
      });
    }
    // 去重：hostSwap 会把不同形式映射到同一个 URL（gcore 那种排序后尤其容易撞），去掉多余的请求
    var seen = {}, out = [];
    list.forEach(function (u) { if (!seen[u]) { seen[u] = 1; out.push(u); } });
    return out;
  }

  /* ---------- 问 GitHub 要最新 tag（拿不到就 null，不阻塞） ---------- */
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
      // GitHub 不通（国内常见）→ 退到 jsdelivr 数据 API；它可能滞后，只当补充
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

  /* ---------- 注入 ---------- */
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

  // 兜底：v1.2 那套——按顺序注入，失败换下一个（不比较版本，保证总有一份能跑）
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

  /* ---------- 主流程 ---------- */
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
    // 本地 / 钉版本：不存在「分支缓存」问题，不探测，直接同目录取
    // （file:// 下探测还会被 CORS 拦，白等一次超时）
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
