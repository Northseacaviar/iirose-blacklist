/* 等卡片探针：只在你黑名单里的人发点播卡片时，才自动存一份判定报告
   用法：Console 粘贴全文 -> 回车 -> 让被你拉黑的那个人点一首歌 -> 卡片出现后等 4 秒（自动下载 blk-watch-*.json）
   它会记录：卡片帧原文 / 发送者 uid / 该 uid 是否在黑名单 / 插件计数变化 / 那一行到底渲染了没有 */
(function () {
  var i, ws = [window], P = null;
  try { for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} } } catch (e) {}
  for (i = 0; i < ws.length; i++) { try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {} }
  if (!P) { console.log('【没找到插件层】'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var R = {
    start: new Date().toISOString(), url: D.location.href, version: A.version,
    blacklist: (function () { try { return Object.keys(A.store.uids); } catch (e) { return 'ERR:' + e.message; } })(),
    cards: [], events: [], rows: [], saved: 0
  };
  var rows = [];

  // 只看真正的消息行（插件面板那些节点不再干扰）
  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        var cls = String(n.className || '');
        if (cls === 'msg' || cls.indexOf('msg ') === 0) {
          rows.push({ at: Date.now(), cls: cls, t: (n.getAttribute && n.getAttribute('t')) || '', h: (n.outerHTML || '').slice(0, 1500) });
          if (rows.length > 60) { rows.shift(); }
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  function counters() { try { return JSON.parse(JSON.stringify(A.store.counters)); } catch (e) { return 'ERR:' + e.message; } }
  function save(tag) {
    R.rows = rows.slice(-40);
    R.saved++;
    var data = JSON.stringify(R, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-watch-' + tag + '-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】blk-watch-' + tag + '.json（' + data.length + ' 字节）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }

  var s = P.socket, o = s && s._onmessage;
  if (o && !o.__watch) {
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length > 4) {
          if (d.charAt(0) === '&') { R.events.push({ at: Date.now(), raw: String(d).slice(0, 400) }); }
          if (d.charAt(0) === '"' && d.indexOf('m__4') >= 0) {
            var f = d.slice(1).split('<')[0].split('>');
            var uid = f[8] || '';
            var rec = {
              at: Date.now(), msgId: f[0], senderUid: uid, senderName: f[2] || '',
              content: String(f[3] || '').slice(0, 300),
              blockedAtArrival: (function () { try { return !!A.isBlocked(uid); } catch (e) { return 'ERR:' + e.message; } })(),
              countersBefore: counters(), raw: String(d).slice(0, 900)
            };
            R.cards.push(rec);
            console.log('【收到卡片帧】uid=' + uid + '(' + rec.senderName + ') 是否在黑名单=' + rec.blockedAtArrival);
            setTimeout(function () {
              rec.countersAfter = counters();
              rec.rowAppeared = rows.some(function (r) { return r.t === rec.msgId; });
              rec.rowCounters = rows.length;
              save('blocked-' + uid);
            }, 4000);
          }
        }
      } catch (e) { R.err = String(e && e.message); }
      return o.apply(this, arguments);
    };
    w.__watch = 1;
    s._onmessage = w;
  }

  console.log('【已开始等待】层=' + R.url + '｜版本 ' + A.version + '｜当前黑名单 ' + JSON.stringify(R.blacklist));
  console.log('现在让被你拉黑的那个人点一首歌。收到卡片帧后约 4 秒自动存报告。');
})()
