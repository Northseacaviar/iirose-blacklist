/* 定位：报告每一层窗口里有没有插件、有没有 socket、页面是什么
   用法：Console 里粘贴本文件全部内容 -> 回车 -> 把输出截图发我
   （它会自动扫 顶层 + 全部 iframe，不需要你手动切上下文） */
(function () {
  var out = [], i, ws = [window], w, t;
  try {
    for (i = 0; i < window.frames.length; i++) {
      try { ws.push(window.frames[i]); } catch (e) {}
    }
  } catch (e) {}
  for (i = 0; i < ws.length; i++) {
    t = '层' + i + (ws[i] === window ? '(当前上下文)' : '');
    try {
      w = ws[i];
      out.push(t
        + ' | 插件=' + (w.__IIROSE_BLACKLIST__ ? '有 v' + w.__IIROSE_BLACKLIST__.version : '无')
        + ' | socket=' + (w.socket ? '有' : '无')
        + ' | 已钩住=' + (w.socket && w.socket._onmessage && w.socket._onmessage.__blWrapped ? '是' : '否')
        + ' | 地址=' + String(w.location.href || '').slice(0, 60)
        + ' | 消息行=' + (function () { try { return w.document.getElementsByClassName('msgholderBox').length + ' 个容器/' + w.document.getElementsByClassName('msg').length + ' 行'; } catch (e) { return '?'; } })());
    } catch (e) {
      out.push(t + ' | 读不到（跨源）');
    }
  }
  console.log('【层报告】\n' + out.join('\n'));
  console.log('提示：把上面这几行连同 Console 左上角"上下文"下拉框里显示的名字一起截图');
  return out.join(' | ');
})()
