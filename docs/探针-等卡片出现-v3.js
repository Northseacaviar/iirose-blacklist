/* 等卡片探针 v3：记录【所有前缀的入站帧】（不只是 " 和 &），看小号的东西到底有没有来、以什么形态来
   用法：Console 粘贴全文 -> 回车
        ① 小号在房间里发一条文字（比如：测试文字123）
        ② 小号再点一首歌（记住歌名，告诉我）
        ③ 主号运行：__WATCH_SAVE__('manual')
   输出：blk-watch3-*.json */
(function () {
  var i, ws = [window], P = null;
  try { for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} } } catch (e) {}
  for (i = 0; i < ws.length; i++) { try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {} }
  if (!P) { console.log('【没找到插件层】'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var R = {
    start: new Date().toISOString(), url: D.location.href, version: A.version, saved: 0,
    blacklist: (function () { try { return Object.keys(A.store.uids); } catch (e) { return 'ERR:' + e.message; } })(),
    prefixCount: {}, allFrames: [], cards: [], rows: []
  };
  var rows = [];

  function counters() { try { return JSON.parse(JSON.stringify(A.store.counters)); } catch (e) { return 'ERR:' + e.message; } }
  function save(tag) {
    R.rows = rows.slice(-20);
    R.saved++;
    var data = JSON.stringify(R, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-watch3-' + tag + '-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】blk-watch3-' + tag + '.json（' + data.length + ' 字节｜入站帧 ' + R.allFrames.length + ' 条）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }
  window.__WATCH_SAVE__ = save;

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        var cls = String(n.className || '');
        if (cls === 'msg' || cls.indexOf('msg ') === 0) {
          rows.push({ at: Date.now(), t: (n.getAttribute && n.getAttribute('t')) || '', h: (n.outerHTML || '').slice(0, 1000) });
          if (rows.length > 30) { rows.shift(); }
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  var s = P.socket, o = s && s._onmessage;
  if (o && !o.__watch3) {
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length > 0) {
          var p = d.charAt(0);
          R.prefixCount[p] = (R.prefixCount[p] || 0) + 1;
          if (p === '"' || p === '{' || p === '&' || p === '=' || p === '%') {
            R.allFrames.push({ at: Date.now(), prefix: p, len: d.length, head: String(d).slice(0, 200) });
            if (R.allFrames.length > 150) { R.allFrames.shift(); }
            // 卡片检测：无论以 " 还是 { 形态来
            if (d.indexOf('m__4') >= 0) {
              var f = (p === '"') ? d.slice(1).split('<')[0].split('>') : [];
              R.cards.push({
                at: Date.now(), prefix: p, msgId: f[0] || '', uid: f[8] || '', name: f[2] || '',
                content: String(f[3] || d).slice(0, 300),
                blockedAtArrival: f[8] ? (function () { try { return !!A.isBlocked(f[8]); } catch (e) { return 'ERR:' + e.message; } })() : null,
                counters: counters(), raw: String(d).slice(0, 800)
              });
              console.log('【卡片帧】前缀=' + p + ' uid=' + (f[8] || '?') + ' 在黑名单=' + (f[8] ? A.isBlocked(f[8]) : '?') + '｜原文: ' + String(d).slice(0, 120));
            }
          }
        }
      } catch (e) { R.err = String(e && e.message); }
      return o.apply(this, arguments);
    };
    w.__watch3 = 1;
    s._onmessage = w;
  }

  console.log('【已开始等待 v3】层=' + R.url + '｜版本 ' + A.version + '｜黑名单 ' + JSON.stringify(R.blacklist));
  console.log('顺序：小号发一条文字 → 小号点一首歌 → 主号运行 __WATCH_SAVE__(\'manual\')');
})()
