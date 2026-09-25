/* 真机自测探针 —— 在 iirose 的 iframe（i.html）上下文里粘贴执行。
 *
 * 用途：不需要第二个人，也能在真机上验证「协议级丢帧」到底生不生效。
 * 原理：直接调用站点自己的收包回调 window.socket._onmessage(帧)，把一条**本机伪造**的帧
 *       送进和真实消息完全相同的处理链。帧只在本机流转，不发给服务器 —— 别人看不到任何东西。
 *
 * 步骤（每步看 console 输出的「界面出现？」）：
 *   1. __T.go()                         → 未拉黑：房间消息应出现在聊天区（这一步是在验证"假帧能被站点渲染"这条通道）
 *   2. __T.S.block(__T.U, '测试甲')      → 拉黑
 *   3. __T.go()                         → 界面应为 false（看不到），面板「已屏蔽·房间」+1
 *   4. __T.go(1) / __T.S.block 后再来   → 私聊帧同理
 *   5. __T.S.unblock(__T.U)             → 解除后 __T.go() 应又变回 true
 *
 * 若第 1 步就是 false：说明是「假帧格式/通道」的问题，不是拉黑没生效 —— 这两件事必须先分开，
 * 否则真人测试时无法判断失败原因。
 */
(() => {
  const U = 'bltest000001';
  const S = window.__IIROSE_BLACKLIST__;
  if (!S) { console.warn('[自测] 插件没加载：__IIROSE_BLACKLIST__ 不存在'); return; }
  if (!window.socket || typeof window.socket._onmessage !== 'function') { console.warn('[自测] 还没登录/没有 socket'); return; }

  const frame = (uid, priv) => priv
    ? '""1708000002>' + uid + '>测试甲>http://r.iirose.com/i/1.bmp>这是私聊>339f88>>339f88>3>http://r.iirose.com/i/1.png>12345678'
    : '"1708000001>http://r.iirose.com/i/1.bmp>测试甲>这是房间消息>040b02>040b02>1>x>' + uid + ">g'0'1>12345678";

  const go = (priv) => {
    const word = priv ? '这是私聊' : '这是房间消息';
    window.socket._onmessage(frame(U, priv));
    setTimeout(() => {
      console.log('[自测] ' + (priv ? '私聊' : '房间') + '帧 → 界面出现该消息？',
        document.documentElement.innerText.indexOf(word) >= 0,
        '| hooked =', S.hooked,
        '| counters =', JSON.stringify(S.store.counters));
    }, 500);
  };

  // A2（v0.1.11 起的新口径）：拉黑后**已经渲染出来的旧消息应当仍在**。
  // 用法：__T.go() 看到 true → __T.S.block(__T.U,'测试甲') → __T.retained() 应为 true
  const retained = () => {
    const still = document.documentElement.innerText.indexOf('这是房间消息') >= 0;
    console.log('[自测] 拉黑后旧消息仍在界面？', still,
      '| 保留聊天记录开关 =', S.store.conf.keepHistory !== false,
      '| 若这里是 false 而开关是开的 → 保留历史失效，把这个结果发我');
    return still;
  };

  window.__T = { U, S, go, retained, tip: '步骤：__T.go()（应看到）→ __T.retained()（应 true）→ __T.S.block(__T.U,\'测试甲\') → __T.go() 应看不到、__T.retained() 仍应 true' };
  console.log('[自测] 就绪。' + window.__T.tip);
})();
