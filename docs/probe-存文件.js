/* 自动存盘版探针：装好后点一首歌，卡片出现约 2 秒后自动把一个 json 存进「下载」目录
   用法：在 Console 里粘贴本文件全部内容 -> 回车 -> 点一首歌 -> 告诉我一声 */
(function () {
  if (window.__PROBE_SAVER__) { console.log('【已装过】直接点歌即可'); return; }
  window.__PROBE_SAVER__ = 1;
  var W = window, D = document;
  try {
    var f = document.getElementById('mainFrame');
    if (f && f.contentWindow && f.contentWindow.document) { W = f.contentWindow; D = W.document; }
  } catch (e) {}
  W.__CAP__ = W.__CAP__ || [];
  W.__DOMCAP__ = W.__DOMCAP__ || [];
  var s = W.socket, o = s && s._onmessage, armed = 0;

  function save() {
    try {
      var data = JSON.stringify({
        when: new Date().toISOString(),
        url: location.href,
        frames: W.__CAP__,
        dom: W.__DOMCAP__
      }, null, 1);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-probe-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
      console.log('【已存文件】下载目录里的 blk-probe-*.json（' + data.length + ' 字节）');
    } catch (e) { console.log('【存文件失败】' + e.message); }
  }

  if (o && !o.__saver) {
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length > 3 &&
            (d.charAt(0) === '{' || d.charAt(0) === '&' || d.indexOf('__4') >= 0)) {
          W.__CAP__.push(String(d).slice(0, 1500));
          if (d.indexOf('__4') >= 0 && !armed) { armed = 1; setTimeout(save, 2000); }
        }
      } catch (e) {}
      return o.apply(this, arguments);
    };
    w.__saver = 1;
    s._onmessage = w;
  }

  var mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType === 1 && n.outerHTML) {
          W.__DOMCAP__.push(n.outerHTML.slice(0, 1500));
          if (W.__DOMCAP__.length > 60) { W.__DOMCAP__.shift(); }
        }
      });
    });
  });
  try { mo.observe(D.body, { childList: true, subtree: true }); } catch (e) {}
  console.log('【已装好】现在点一首歌：卡片出现后约 2 秒会自动存一个 json 到下载目录');
})()
