/* 卡片过滤实测 v2：给每次注入的帧打唯一指纹（封面文件名 + 卡片颜色），把"行是谁画的"钉死
   用法：Console 里粘贴本文件全部内容 -> 回车 -> 等约 12 秒（自动下载 blk-cardtest2-*.json）
   注入的帧只走本地收包回调，不经服务器、不影响任何人；结束时自动清理测试 uid */
(function () {
  var i, ws = [window], P = null;
  try {
    for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} }
  } catch (e) {}
  for (i = 0; i < ws.length; i++) {
    try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {}
  }
  if (!P) { console.log('【没找到插件层】'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var TEST_UID = 'blktest00002';
  var TAG = String(Date.now()).slice(-6);          // 本次实验的唯一后缀
  var rows = [], rep = { version: A.version, hooked: A.hooked, tag: TAG, url: D.location.href, steps: [] };

  function snap() {
    try { return JSON.parse(JSON.stringify(A.store().counters)); }
    catch (e) { return 'ERR:' + e.message; }
  }
  rep.before = snap();
  rep.apiProbe = (function () {
    var o = {};
    try { o.storeType = typeof A.store; } catch (e) { o.storeErr = e.message; }
    try { o.uids = Object.keys(A.store().uids).length; } catch (e) { o.uidsErr = e.message; }
    return o;
  })();

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        var cls = String(n.className || '');
        if (cls.indexOf('msg') >= 0 || cls.indexOf('demand') >= 0 || cls.indexOf('media') >= 0 || cls.indexOf('card') >= 0) {
          rows.push({ at: Date.now(), cls: cls, t: (n.getAttribute && n.getAttribute('t')) || '', h: (n.outerHTML || '').slice(0, 2500) });
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  // 每步唯一的指纹：封面文件名 + 卡片颜色
  function cardFrame(step, uid, song) {
    var cover = 'http://p2.music.126.net/PROBE' + TAG + '-' + step + '.jpg';
    var color = 'a1' + step + 'b' + step + 'c' + step;
    return '"179034' + Math.floor(Math.random() * 9000 + 1000)
      + '>http://r.iirose.com/i/26/8/4/4/1023-GT.jpg>测试卡片>m__4@0&gt;' + song
      + '&gt;测试歌手&gt;' + cover + '&gt;' + color + '&gt;128>dce8f6>ffffff>0>>'
      + uid + '>0测试>999999999999';
  }
  function eventFrame(step, song) {
    return '&1{"s":"s://x.mp3","d":10,"c":"s://p2.music.126.net/PROBE' + TAG + '-e' + step + '.jpg","n":"' + song
      + '","r":"测试歌手","b":"@0","o":"s://x","l":""}';
  }
  function inject(f) { try { P.socket._onmessage(f); return 'ok'; } catch (e) { return 'ERR:' + e.message; } }

  var queue = [
    { name: '① 未拉黑 + 卡片帧（对照：应渲染）', mid: '1', mk: function () { return cardFrame(1, 'other0000001', '对照歌曲A'); } },
    { name: '② 拉黑 + 卡片帧（应被丢帧、不渲染）', mid: '2', mk: function () { A.block(TEST_UID, '过滤自测'); return cardFrame(2, TEST_UID, '应拦歌曲B'); } },
    { name: '③ 解除拉黑 + 卡片帧（应恢复）', mid: '3', mk: function () { A.unblock(TEST_UID); return cardFrame(3, TEST_UID, '恢复歌曲C'); } },
    { name: '④ 拉黑 + 整对（卡片帧 + 事件帧，模拟真实点歌）', mid: '4|e4', mk: function () {
        A.block(TEST_UID, '过滤自测');
        var r1 = inject(cardFrame(4, TEST_UID, '整对卡片D'));
        var r2 = inject(eventFrame(4, '整对事件D'));
        return r1 + '/' + r2;
      } },
    { name: '⑤ 只喂事件帧（未拉黑，看站点会不会自己画卡）', mid: 'e5', mk: function () { A.unblock(TEST_UID); return eventFrame(5, '事件独唱E'); } }
  ];

  function runStep(k) {
    if (k >= queue.length) { finish(); return; }
    var st = queue[k], m0 = rows.length, out;
    out = st.mk();
    setTimeout(function () {
      var added = rows.slice(m0), matched = 0, sample = [];
      added.forEach(function (r) {
        if ((r.h || '').indexOf('PROBE' + TAG + '-' + st.mid) >= 0) { matched++; if (sample.length < 1) { sample.push(r.h); } }
      });
      var rec = { name: st.name, rowsAdded: added.length, matchedByFingerprint: matched, counters: snap(), inject: out };
      if (sample.length) { rec.sampleHtml = sample[0].slice(0, 900); }
      rep.steps.push(rec);
      console.log('【' + st.name + '】新增行 ' + added.length + '｜本步指纹命中 ' + matched + '｜计数 ' + JSON.stringify(snap()));
      runStep(k + 1);
    }, 2000);
  }

  function finish() {
    try { A.unblock(TEST_UID); } catch (e) {}
    rep.after = snap();
    rep.rows = rows;
    rep.cleanup = (function () { try { return Object.keys(A.store().uids).indexOf(TEST_UID) < 0 ? '已清理' : '仍在名单'; } catch (e) { return 'ERR:' + e.message; } })();
    var data = JSON.stringify(rep, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-cardtest2-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】blk-cardtest2-*.json（' + data.length + ' 字节，指纹 ' + TAG + '）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
    console.log('【清理】测试 uid ' + rep.cleanup);
  }

  console.log('【已开始】层=' + rep.url + '｜版本 ' + A.version + '｜指纹 ' + TAG + '｜共 5 步约 12 秒');
  runStep(0);
})()
