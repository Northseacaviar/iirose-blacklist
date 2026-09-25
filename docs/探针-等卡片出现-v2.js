/* 等卡片探针 v2：记录【所有房间消息帧】+ 检测卡片帧，手动也能存
   用法：Console 粘贴全文 -> 回车 -> 小号（被你拉黑的那个）点一首歌 -> 等 4 秒
   手动存：在 Console 运行 __WATCH_SAVE__('manual')
   输出：blk-watch2-*.json（含这段时间收到的每条房间消息的消息id/uid/名字/内容前80字） */
(function () {
  var i, ws = [window], P = null;
  try { for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} } } catch (e) {}
  for (i = 0; i < ws.length; i++) { try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {} }
  if (!P) { console.log('【没找到插件层】'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var R = {
    start: new Date().toISOString(), url: D.location.href, version: A.version, saved: 0,
    blacklist: (function () { try { return Object.keys(A.store.uids); } catch (e) { return 'ERR:' + e.message; } })(),
    roomFrames: [], cards: [], events: [], rows: []
  };
  var rows = [];

  function counters() { try { return JSON.parse(JSON.stringify(A.store.counters)); } catch (e) { return 'ERR:' + e.message; } }

  function save(tag) {
    R.rows = rows.slice(-30);
    R.saved++;
    var data = JSON.stringify(R, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-watch2-' + tag + '-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】blk-watch2-' + tag + '.json（' + data.length + ' 字节，房间帧 ' + R.roomFrames.length + ' 条）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }
  window.__WATCH_SAVE__ = save;          // 手动存：__WATCH_SAVE__('manual')

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        var cls = String(n.className || '');
        if (cls === 'msg' || cls.indexOf('msg ') === 0) {
          rows.push({ at: Date.now(), t: (n.getAttribute && n.getAttribute('t')) || '', h: (n.outerHTML || '').slice(0, 1200) });
          if (rows.length > 40) { rows.shift(); }
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  var s = P.socket, o = s && s._onmessage;
  if (o && !o.__watch2) {
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length > 4) {
          if (d.charAt(0) === '&') { R.events.push({ at: Date.now(), raw: String(d).slice(0, 400) }); }
          if (d.charAt(0) === '"' && d.charAt(1) !== '"') {
            var recs = d.slice(1).split('<');
            recs.forEach(function (one) {
              var f = one.split('>');
              if (!/^\d{6,}$/.test(f[0] || '')) { return; }
              var uid = f[8] || '', content = String(f[3] || '');
              var isCard = content.indexOf('m__4') >= 0;
              var rec = {
                at: Date.now(), msgId: f[0], uid: uid, name: f[2] || '',
                isCard: isCard, contentHead: content.slice(0, 80),
                blockedAtArrival: (function () { try { return !!A.isBlocked(uid); } catch (e) { return 'ERR:' + e.message; } })(),
                counters: counters()
              };
              R.roomFrames.push(rec);
              if (R.roomFrames.length > 80) { R.roomFrames.shift(); }
              if (isCard) {
                R.cards.push(rec);
                console.log('【卡片帧】uid=' + uid + '(' + rec.name + ') 在黑名单=' + rec.blockedAtArrival);
                setTimeout(function () {
                  rec.countersAfter = counters();
                  rec.rowAppeared = rows.some(function (r) { return r.t === rec.msgId; });
                  save('card-' + uid);
                }, 4000);
              }
            });
          }
        }
      } catch (e) { R.err = String(e && e.message); }
      return o.apply(this, arguments);
    };
    w.__watch2 = 1;
    s._onmessage = w;
  }

  console.log('【已开始等待 v2】层=' + R.url + '｜版本 ' + A.version + '｜黑名单 ' + JSON.stringify(R.blacklist));
  console.log('小号点一首歌；收到卡片帧会自动存报告，也可随时运行 __WATCH_SAVE__(\'manual\') 手动存');
})()
