/* 卡片过滤实测：在真机上把四个环节逐个喂帧验一遍，最后自动存一份报告到下载目录
   用法：Console 里粘贴本文件全部内容 -> 回车 -> 等约 8 秒（会自动下载 blk-cardtest-*.json）
   说明：注入的帧只走"收包回调"，不经服务器、不影响任何人；卡片是本地渲染的
   若验证过程把测试 uid 留在黑名单里，脚本最后会自动解除 */
(function () {
  var i, ws = [window], P = null;
  try {
    for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} }
  } catch (e) {}
  for (i = 0; i < ws.length; i++) {
    try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {}
  }
  if (!P) { console.log('【没找到插件层】请确认插件已注入，然后重跑'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var TEST_UID = 'blktest00001';
  var rows = [], marks = [], marks2 = [];
  var rep = { version: A.version, hooked: A.hooked, before: null, steps: [], url: D.location.href };

  function snap() { try { return JSON.parse(JSON.stringify(A.store().counters)); } catch (e) { return null; } }
  rep.before = snap();

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        var cls = String(n.className || '');
        if (cls.indexOf('msg') >= 0 || cls.indexOf('demand') >= 0 || cls.indexOf('media') >= 0) {
          rows.push({ at: Date.now(), cls: cls, t: (n.getAttribute && n.getAttribute('t')) || '', h: (n.outerHTML || '').slice(0, 700) });
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  function cardFrame(uid, song) {
    return '"179034' + Math.floor(Math.random() * 9000 + 1000)
      + '>http://r.iirose.com/i/26/8/4/4/1023-GT.jpg>测试卡片>m__4@0&gt;' + song
      + '&gt;测试歌手&gt;http://p2.music.126.net/x.jpg&gt;dce8f6&gt;128>dce8f6>ffffff>0>>'
      + uid + '>0测试>999999999999';
  }
  var EVENT_FRAME = '&1{"s":"s://x.mp3","d":10,"c":"s://x.jpg","n":"测试事件歌","r":"测试","b":"@0","o":"s://x","l":""}';

  function inject(f) { try { P.socket._onmessage(f); return 'ok'; } catch (e) { return 'ERR:' + e.message; } }
  function since(k) { return rows.length - k; }

  function step(name, fn, wait, marker) {
    setTimeout(function () {
      var m = rows.length;
      var extra = fn() || {};
      setTimeout(function () {
        var added = rows.slice(m);
        var hit = 0;
        if (marker) {
          added.forEach(function (r) { if ((r.h || '').indexOf(marker) >= 0) { hit++; } });
        }
        rep.steps.push(Object.assign({ name: name, rowsAdded: added.length, matchedMarker: hit, counters: snap() }, extra));
        console.log('【' + name + '】新增行 ' + added.length + '｜其中含「' + (marker || '-') + '」的 ' + hit + '｜计数 ' + JSON.stringify(snap()));
        next();
      }, wait || 1400);
    }, 0);
  }

  var queue = [
    function () { return step('① 未拉黑 + 卡片帧（对照组，应出现卡片）',
      function () { return { inject: inject(cardFrame('other0000001', '对照歌曲')) }; }, 1800, '对照歌曲'); },
    function () { return step('② 拉黑后 + 同一张卡片帧（应被丢弃、不出现）',
      function () { A.block(TEST_UID, '过滤自测'); return { blockedUid: TEST_UID, inject: inject(cardFrame(TEST_UID, '应被拦歌曲')) }; }, 1800, '应被拦歌曲'); },
    function () { return step('③ 解除拉黑 + 再喂一次（应恢复出现）',
      function () { A.unblock(TEST_UID); return { inject: inject(cardFrame(TEST_UID, '解除后歌曲')) }; }, 1800, '解除后歌曲'); },
    function () { return step('④ 只喂媒体事件帧 &1{…}（看站点会不会自己另画一张卡）',
      function () { return { inject: inject(EVENT_FRAME) }; }, 2400, '测试事件歌'); }
  ];
  var qi = 0;
  function next() {
    if (qi >= queue.length) { finish(); return; }
    var f = queue[qi++];
    f();
  }

  function finish() {
    try { A.unblock(TEST_UID); } catch (e) {}
    rep.after = snap();
    rep.rows = rows;
    rep.finalBlocked = (function () { try { return A.store().uids[TEST_UID] ? '仍在名单' : '已清理'; } catch (e) { return '?'; } })();
    var data = JSON.stringify(rep, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-cardtest-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】下载目录 blk-cardtest-*.json（' + data.length + ' 字节）—— 告诉我一声即可');
    } catch (e) { console.log('【存文件失败】' + e.message); }
    console.log('【清理】测试 uid ' + rep.finalBlocked + '；黑名单现有 ' + JSON.stringify(Object.keys(A.store().uids)));
  }

  console.log('【已开始】找到插件层：' + rep.url + '｜版本 ' + A.version + '｜共 4 步，约 8 秒');
  next();
})()
