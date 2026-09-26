/* 探针：拉黑「清群聊历史」现场取证 v1（2026-09-26）
 *
 * 用途：北海反馈 v0.3.2 后"拉黑不再屏蔽群聊历史消息"。本探针只读，不改 DOM、不发请求、不动插件代码。
 *
 * 用法（三步）：
 *   ① 打开房间页面，把被拉黑者的历史消息滚到屏幕里（看不到就滚一下）
 *   ② F12 → Console（新版 Chrome 要先打 allow pasting 回车）→ 粘贴本文件全部内容 → 回车
 *   ③ 它会自动下载 blk-sweep-*.json 到下载目录；跟我说一声，我去读（你不用复制任何输出）
 *
 * 可选：想让我看到"拉黑那一刻"的判断，先粘贴本探针，再在面板里拉黑一次（或 A.block(uid)），
 *       探针会自己抓一份带 tag=拉黑后的快照。
 */
(function () {
  if (window.__SWEEP1__ && window.__SWEEP1__.active) { console.log('【已装过】再存一份：__SWEEP1__.scan("手动")'); return; }
  var saves = 0, last = 0;

  function save(data, tag) {
    try {
      var s = JSON.stringify(data, null, 1);
      var blob = new Blob([s], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-sweep-' + Date.now() + '-' + tag + '.json';
      a.__sweep1self = 1;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 3000);
      console.log('【已存文件】blk-sweep-*-' + tag + '.json（' + s.length + ' 字节）—— 告诉 Corvin 一声他去读');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }

  function cls(n) { try { return (n.className && String(n.className)) || ''; } catch (e) { return ''; } }
  function attrs(n, keys) {
    var o = {};
    try { for (var i = 0; i < keys.length; i++) { var v = n.getAttribute && n.getAttribute(keys[i]); if (v) o[keys[i]] = String(v).slice(0, 60); } } catch (e) { }
    return o;
  }
  function text(n) { try { return String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch (e) { return ''; } }

  function scan(tag) {
    var A = window.__IIROSE_BLACKLIST__;
    var out = { when: new Date().toISOString(), tag: tag, href: String(location.href).slice(0, 160) };
    if (!A) { out.note = '这一层没有插件（可能插件在 iframe 里）'; save(out, tag); return; }

    out.version = A.version;
    out.conf = A.store.conf;
    out.counters = A.store.counters;
    out.uids = (function () { var o = {}; for (var k in A.store.uids) o[k] = { name: (A.store.uids[k] || {}).name || '', ts: (A.store.uids[k] || {}).ts || 0 }; return o; })();
    out.seenCount = Object.keys(A.store.seen || {}).length;

    // 房间消息区的结构现状
    function q(sel) { try { return document.querySelectorAll(sel); } catch (e) { return { length: -1 }; } }
    out.dom = {
      msgholderBox: q('.msgholderBox').length,
      msgholderBox_msg: q('.msgholderBox .msg').length,
      any_msg: q('.msg').length,
      data_uid: q('[data-uid]').length,
      ip_attr: q('[ip]').length,
      pubMsgSystem: q('[class*="pubMsgSystem"]').length,
      cardMediaShare: q('[class*="systemCardMediaShare"]').length
    };

    // 前 3 行的原文结构（看站点是不是改版了）
    out.sampleRows = [];
    var rows = q('.msgholderBox .msg');
    for (var i = 0; i < rows.length && out.sampleRows.length < 3; i++) {
      var r = rows[i];
      out.sampleRows.push({
        cls: cls(r), attrs: attrs(r, ['data-uid', 'ip', 'data-id', 'id']),
        text: text(r), html: String(r.outerHTML || '').slice(0, 700)
      });
    }

    // 被拉黑的人：屏幕上有没有他的行、哪些行能被识别出 uid
    out.blockedRows = [];
    var all = q('.msgholderBox *');
    for (var k in A.store.uids) {
      var nm = (A.store.uids[k] || {}).name || '';
      var hitCount = 0, samples = [];
      for (var j = 0; j < all.length; j++) {
        var n = all[j];
        var t = text(n);
        var hasUid = (n.getAttribute && n.getAttribute('data-uid') === k) || (n.getAttribute && n.getAttribute('ip') === k);
        var hasName = nm && t.indexOf(nm) >= 0 && t.length < 200;
        if (!hasUid && !hasName) continue;
        hitCount++;
        if (samples.length < 3) {
          samples.push({ cls: cls(n), attrs: attrs(n, ['data-uid', 'ip', 'data-id', 'id']), text: t,
                         outer: String(n.outerHTML || '').slice(0, 500) });
        }
      }
      out.blockedRows.push({ uid: k, name: nm, hitCount: hitCount, samples: samples });
    }

    // 插件自己的判断（debugSweep 逐行报告；lastSweep 是最近一次清扫的过程记录）
    try { A._diag.debugSweep(); } catch (e) { out.debugSweepError = String(e && e.message || e); }
    try { out.lastSweep = A._diag.lastSweep(); } catch (e) { out.lastSweepError = String(e && e.message || e); }
    try { out.pluginDiag = { sweep: typeof A.sweep === 'function' ? A.sweep() : null }; } catch (e) { out.sweepError = String(e && e.message || e); }

    out.notes = [
      'conf.keepHistory=false 表示"拉黑瞬间清历史"（默认）；true=保留文字历史、只拦新的',
      'dom.msgholderBox_msg 是当前能识别到的消息行数；为 0 而 any_msg>0 = 站点换了容器',
      'blockedRows[].hitCount 为 0 = 屏幕上没有他的行（可能没滚到）'
    ];
    saves++; last = Date.now();
    save(out, tag + saves);
    console.log('【清扫取证】版本 ' + out.version + ' · keepHistory=' + out.conf.keepHistory + ' · 消息行 ' + out.dom.msgholderBox_msg + ' · 名单 ' + Object.keys(out.uids).length + ' 人 · 错误计数 ' + out.counters.err);
  }

  window.__SWEEP1__ = { active: true, scan: scan, last: function () { return last; } };
  scan('手动');
})();
