/* 诊断：一次性打印插件状态（黑名单 / 计数 / 帧前缀 / 挂载状态）
   用法：Console 里粘贴本文件全部内容 -> 回车 -> 截图发我 */
(function () {
  var A = window.__IIROSE_BLACKLIST__;
  if (!A) {
    console.log('【没找到插件】请确认插件装在这个页面（或先刷新一次）');
    return;
  }
  function safe(fn, dft) { try { return fn(); } catch (e) { return '读取失败:' + e.message; } }
  var st = safe(function () { return A.store; }, {});   // store 是属性（getter 返回对象），不是函数
  var uids = st && st.uids ? st.uids : {};
  var list = [];
  for (var k in uids) {
    if (Object.prototype.hasOwnProperty.call(uids, k)) {
      list.push(k + (uids[k] && uids[k].name ? '(' + uids[k].name + ')' : ''));
    }
  }
  console.log('【插件】版本 ' + safe(function () { return A.version; }, '?')
    + ' | 已挂载 socket: ' + safe(function () { return A.hooked; }, '?')
    + ' | 存储形态: ' + JSON.stringify(safe(function () { return A.storage(); }, '?')));
  console.log('【黑名单】共 ' + list.length + ' 人 —— ' + (list.join('、') || '（空）'));
  console.log('【计数】' + JSON.stringify(st && st.counters ? st.counters : {}));
  console.log('【帧前缀累计】' + JSON.stringify(safe(function () { return A.rawStats(); }, {})));
  console.log('【卡片发送者对照】本机抓到的卡片 uid = 5d3e8659b060c（鬼见愁）—— 看它有没有出现在上面黑名单里');
  console.log('【下一步】在 Console 里运行 __IIROSE_BLACKLIST__.setDebug(true) 后再让人点一首，观察是否打印「已屏蔽」');
})()
