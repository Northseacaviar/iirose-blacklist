/* 取数：把探针抓到的结果打印出来并复制到剪贴板
   用法：在 Console 里粘贴本文件全部内容 -> 回车 -> 回聊天 Ctrl+V
   它会扫顶层 + 全部 frame，所以不管 Console 上下文停在哪一层都能取到 */
(function () {
  var out = [], i, ws = [window], w, cap, dom;
  try {
    for (i = 0; i < window.frames.length; i++) {
      try { ws.push(window.frames[i]); } catch (e) {}
    }
  } catch (e) {}
  for (i = 0; i < ws.length; i++) {
    try {
      w = ws[i];
      cap = w.__CAP__ ? w.__CAP__.length : -1;
      dom = w.__DOMCAP__ ? w.__DOMCAP__.length : -1;
      out.push('层' + i + (w === window ? '(top)' : '') + ': 帧=' + cap + ' 新增节点=' + dom);
    } catch (e) { out.push('层' + i + ': 读不到（跨源）'); }
  }
  var sum = out.join(' | ');
  console.log('【探针状态】' + sum);
  var data = '{}';
  try {
    w = null;
    for (i = 0; i < ws.length; i++) {
      try { if (ws[i].__CAP__ && ws[i].__CAP__.length) { w = ws[i]; break; } } catch (e) {}
    }
    if (!w) {
      for (i = 0; i < ws.length; i++) {
        try { if (ws[i].__DOMCAP__ && ws[i].__DOMCAP__.length) { w = ws[i]; break; } } catch (e) {}
      }
    }
    if (w) {
      data = JSON.stringify({ frames: w.__CAP__ || [], dom: w.__DOMCAP__ || [] });
      console.log('【抓到的内容】' + data.slice(0, 200));
    } else {
      console.log('【未抓到】探针装了但没数据 —— 可能是装探针之前点的歌，再点一首');
    }
  } catch (e) {}
  try { copy(data); console.log('【已复制到剪贴板】回聊天里 Ctrl+V 即可'); } catch (e) { console.log('【复制失败】请手动选中上面的 JSON'); }
  return sum;
})()
