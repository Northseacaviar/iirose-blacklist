/* 卡片过滤实测 v3：修正 v2 的两处脚本 bug（未真正注入 / A.store 当函数调）
   这次记录【所有新增元素节点】（不再按 class 过滤），并用唯一封面文件名当指纹
   用法：Console 粘贴全文 -> 回车 -> 等约 15 秒（自动下载 blk-cardtest3-*.json） */
(function () {
  var i, ws = [window], P = null;
  try { for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} } } catch (e) {}
  for (i = 0; i < ws.length; i++) { try { if (ws[i].__IIROSE_BLACKLIST__ && ws[i].socket) { P = ws[i]; break; } } catch (e) {} }
  if (!P) { console.log('【没找到插件层】'); return; }

  var A = P.__IIROSE_BLACKLIST__, D = P.document;
  var TEST_UID = 'blktest00003';
  var TAG = String(Date.now()).slice(-6);
  var added = [], steps = [], rep = { version: A.version, hooked: A.hooked, tag: TAG, url: D.location.href };

  function counters() {
    try { return JSON.parse(JSON.stringify(A.store.counters)); } catch (e) { return 'ERR:' + e.message; }
  }
  function fullList() {
    try { return Object.keys(A.store.uids); } catch (e) { return 'ERR:' + e.message; }
  }
  rep.before = counters();
  rep.blacklistBefore = fullList();

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) { return; }
        added.push({ at: Date.now(), cls: String(n.className || ''), t: (n.getAttribute && n.getAttribute('t')) || '',
                     id: (n.getAttribute && n.getAttribute('data-id')) || '', h: (n.outerHTML || '').slice(0, 1200) });
        if (added.length > 120) { added.shift(); }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}

  function cardFrame(step, uid, song) {
    return '"179034' + Math.floor(Math.random() * 9000 + 1000)
      + '>http://r.iirose.com/i/26/8/4/4/1023-GT.jpg>测试卡片>m__4@0&gt;' + song
      + '&gt;测试歌手&gt;http://p2.music.126.net/PROBE' + TAG + '-' + step + '.jpg&gt;a1' + step + 'b' + step + 'c' + step + '&gt;128>dce8f6>ffffff>0>>'
      + uid + '>0测试>999999999999';
  }
  function eventFrame(step, song) {
    return '&1{"s":"s://x.mp3","d":10,"c":"s://p2.music.126.net/PROBE' + TAG + '-e' + step + '.jpg","n":"' + song
      + '","r":"测试歌手","b":"@0","o":"s://x","l":""}';
  }
  function fire(f) { try { P.socket._onmessage(f); return 'ok'; } catch (e) { return 'ERR:' + e.message; } }

  var queue = [
    { name: '① 未拉黑 + 卡片帧（对照：应渲染卡片）', mid: '1', run: function () { return fire(cardFrame(1, 'other0000001', '对照歌曲A')); } },
    { name: '② 拉黑 + 卡片帧（应被丢帧、不渲染）', mid: '2', run: function () { A.block(TEST_UID, '过滤自测'); return fire(cardFrame(2, TEST_UID, '应拦歌曲B')); } },
    { name: '③ 解除拉黑 + 卡片帧（应恢复渲染）', mid: '3', run: function () { A.unblock(TEST_UID); return fire(cardFrame(3, TEST_UID, '恢复歌曲C')); } },
    { name: '④ 拉黑 + 整对（卡片帧 + 事件帧 = 真实点歌形态）', mid: '4|e4', run: function () {
        A.block(TEST_UID, '过滤自测');
        return fire(cardFrame(4, TEST_UID, '整对卡片D')) + '/' + fire(eventFrame(4, '整对事件D'));
      } },
    { name: '⑤ 未拉黑 + 只喂事件帧（看站点是否自己画卡）', mid: 'e5', run: function () { A.unblock(TEST_UID); return fire(eventFrame(5, '事件独唱E')); } }
  ];

  function runStep(k) {
    if (k >= queue.length) { finish(); return; }
    var st = queue[k], m0 = added.length;
    var out = st.run();
    setTimeout(function () {
      var got = added.slice(m0).filter(function (r) { return (r.h || '').indexOf('PROBE' + TAG + '-' + st.mid) >= 0; });
      steps.push({ name: st.name, fired: out, nodesAdded: added.length - m0,
                   fingerprintHits: got.length, counters: counters(),
                   hitClasses: got.map(function (r) { return r.cls || '(无class)'; }),
                   hitHtml: got.length ? got[0].h.slice(0, 800) : '' });
      console.log('【' + st.name + '】新增节点 ' + (added.length - m0) + '｜指纹命中 ' + got.length + '｜计数 ' + JSON.stringify(counters()));
      runStep(k + 1);
    }, 2500);
  }

  function finish() {
    try { A.unblock(TEST_UID); } catch (e) {}
    rep.steps = steps;
    rep.after = counters();
    rep.blacklistAfter = fullList();
    rep.cleanup = (function () { try { return A.store.uids[TEST_UID] ? '仍在名单' : '已清理'; } catch (e) { return 'ERR:' + e.message; } })();
    rep.nodes = added;
    var data = JSON.stringify(rep, null, 1);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = D.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-cardtest3-' + Date.now() + '.json';
      D.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存报告】blk-cardtest3-*.json（' + data.length + ' 字节，指纹 ' + TAG + '）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
    console.log('【清理】' + rep.cleanup + ' | 黑名单 ' + JSON.stringify(rep.blacklistAfter));
  }

  console.log('【已开始】层=' + rep.url + '｜版本 ' + A.version + '｜指纹 ' + TAG + '｜5 步约 15 秒');
  runStep(0);
})()
