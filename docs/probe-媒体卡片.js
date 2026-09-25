(function () {
  var W, D, A;
  try { var F = document.getElementById('mainFrame'); W = (F && F.contentWindow) || window; } catch (e) { W = window; }
  try { D = W.document; A = W.__IIROSE_BLACKLIST__; } catch (e) { W = window; D = document; A = window.__IIROSE_BLACKLIST__; }
  window.__CAP__ = []; window.__DOMCAP__ = [];
  var s = W.socket, o = s && s._onmessage;
  if (o && !o.__cap) {
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length > 3 && (d.charAt(0) === '{' || d.charAt(0) === '&' || d.indexOf('__4') >= 0)) {
          window.__CAP__.push(String(d).slice(0, 600));
        }
      } catch (e) {}
      return o.apply(this, arguments);
    };
    w.__cap = 1; s._onmessage = w;
  }
  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType === 1 && n.outerHTML && n.outerHTML.length > 30) {
          window.__DOMCAP__.push(n.outerHTML.slice(0, 400));
          if (window.__DOMCAP__.length > 30) { window.__DOMCAP__.shift(); }
        }
      });
    });
  });
  mo.observe(D.body, { childList: true, subtree: true });
  var rows = [].slice.call(D.querySelectorAll('.msgholderBox>*')).slice(-12).map(function (r) {
    return { c: r.className, id: r.getAttribute('data-id'), uid: r.getAttribute('data-uid'), ip: r.getAttribute('ip'), h: r.innerHTML.slice(0, 100) };
  });
  console.log('① 帧前缀统计:', A ? JSON.stringify(A.rawStats()) : '(没取到插件)');
  console.log('② 最后 12 行消息行:', JSON.stringify(rows));
  console.log('③ 已开始抓卡片。等卡片出现后运行: copy(JSON.stringify({frames:window.__CAP__,dom:window.__DOMCAP__}))');
})()
