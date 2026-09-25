/* 卡片行结构探针：把聊天里点播卡片那一行的【完整 HTML + 祖先链属性】抓回来（不截断）
   目的：看这行到底有没有藏着 uid 线索（有 → 就能按人清历史卡）
   用法：Console 粘贴全文 -> 回车（自动下载 blk-cardrow-*.json）-> 告诉我 */
(function () {
  var i, ws = [window], P = null;
  try { for (i = 0; i < window.frames.length; i++) { try { ws.push(window.frames[i]); } catch (e) {} } } catch (e) {}
  for (i = 0; i < ws.length; i++) { try { if (ws[i].__IIROSE_BLACKLIST__ || (ws[i].document && ws[i].document.getElementsByClassName('msgholderBox').length)) { P = ws[i]; break; } } catch (e) {} }
  if (!P) { console.log('【没找到聊天层】'); return; }
  var D = P.document;
  var out = { url: String(D.location.href), at: new Date().toISOString(), cards: [], msgRowCount: 0, withDataId: 0, notes: [] };

  function attrs(el) {
    var o = {}, a = el.attributes || [], k;
    for (k = 0; k < a.length; k++) { o[a[k].name] = String(a[k].value).slice(0, 200); }
    return o;
  }

  var rows = D.querySelectorAll('.msg');
  out.msgRowCount = rows.length;
  Array.prototype.forEach.call(rows, function (r) {
    if (r.getAttribute('data-id')) { out.withDataId++; }
  });

  Array.prototype.forEach.call(rows, function (r) {
    var card = r.querySelector('.systemCardMediaShare, [class*="systemCardMediaShare"]');
    if (!card) { return; }
    var chain = [], cur = r, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      chain.push({ tag: cur.tagName, cls: String(cur.className || '').slice(0, 120), attrs: attrs(cur) });
      cur = cur.parentNode; depth++;
    }
    var html = r.outerHTML || '';
    var tokens = (html.match(/[0-9a-z_]{9,20}/gi) || []);
    var uniq = [];
    tokens.forEach(function (t) { if (uniq.indexOf(t) < 0 && uniq.length < 40) { uniq.push(t); } });
    out.cards.push({
      t: r.getAttribute('t') || '', rowClass: String(r.className), rowAttrs: attrs(r),
      ancestors: chain, htmlLength: html.length,
      tokensInHtml: uniq,
      cardText: (card.textContent || '').replace(/\s+/g, ' ').slice(0, 200),
      html: html.slice(0, 8000)
    });
  });

  out.notes.push('卡片行 = 含 systemCardMediaShare 的 .msg 行');
  out.notes.push('tokensInHtml 是这行 HTML 里所有 9~20 位字母数字串（uid 大概长这样）');

  var data = JSON.stringify(out, null, 1);
  try {
    var blob = new Blob([data], { type: 'application/json' });
    var a = D.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blk-cardrow-' + Date.now() + '.json';
    D.body.appendChild(a); a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
    console.log('【已存】blk-cardrow-*.json｜消息行 ' + out.msgRowCount + ' 条（有 data-id 的 ' + out.withDataId + '）｜卡片行 ' + out.cards.length + ' 条，' + data.length + ' 字节');
  } catch (e) { console.log('【存文件失败】' + e.message); }
})()
