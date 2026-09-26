/* 真机自测探针 v2 —— 在 iirose 的 messages.html（聊天 iframe）上下文里粘贴执行。
 *
 * 用途：不需要第二个人，也能在真机上验证「协议级丢帧」和「历史清理」到底生不生效。
 * 原理：直接调用站点自己的收包回调 window.socket._onmessage(帧)，把一条**本地伪造**的帧
 *       送进和真实消息完全相同的处理链。帧只在本地流转，不发给服务器 —— 别人看不到任何东西。
 *
 * 步骤（每一步看 console 打印）：
 *   1. __T.go()      → 未拉黑：房间文字消息应出现在聊天区（先证明"假帧能被站点渲染"，否则后面失败无法归因）
 *      __T.goCard()  → 未拉黑：点播卡片应出现在聊天区
 *   2. __T.S.block(__T.U, '测试甲')   → 拉黑（默认口径：清掉他的历史消息 + 历史点播卡片）
 *   3. __T.check()   → 一屏看全：新消息收不到？历史消息清掉了？历史卡片清掉了？
 *   4. __T.S.unblock(__T.U)  → 解除后 __T.go() 应又变回 true
 *
 * 若第 1 步就是 false：那是"假帧格式/通道"的问题，不是拉黑没生效 —— 这两件事必须先分开。
 */
(() => {
  const U = 'bltest000001';
  const S = window.__IIROSE_BLACKLIST__;
  if (!S) { console.warn('[自测] 插件没加载：__IIROSE_BLACKLIST__ 不存在'); return; }
  if (!window.socket || typeof window.socket._onmessage !== 'function') { console.warn('[自测] 还没登录/没有 socket'); return; }

  const TEXT_WORD = '这是房间消息';
  const SONG = '自测歌曲';

  const frame = (uid, priv) => priv
    ? '""1708000002>' + uid + '>测试甲>http://r.iirose.com/i/1.bmp>这是私聊>339f88>>339f88>3>http://r.iirose.com/i/1.png>12345678'
    : '"1708000001>http://r.iirose.com/i/1.bmp>测试甲>' + TEXT_WORD + '>040b02>040b02>1>x>' + uid + ">g'0'1>12345678";

  // 点播卡片：内容用真机同款 m__4 形态（内含 > ，真机是转义成 &gt; 的 —— 这里照做，
  // 顺便验证"名字/内容里带分隔符时 uid 下标不跑偏"）
  const cardFrame = (uid) => '"1708000003>http://r.iirose.com/i/1.bmp>测试甲>'
    + 'm__4@0&gt;' + SONG + '&gt;自测歌手&gt;http://p1.music.126.net/self-test.jpg&gt;dce8f6&gt;320'
    + '>dce8f6>ffffff>0>>' + uid + ">g'0'1>12345679";

  const seen = (word) => document.documentElement.innerText.indexOf(word) >= 0;

  const go = (priv) => {
    const word = priv ? '这是私聊' : TEXT_WORD;
    window.socket._onmessage(frame(U, priv));
    setTimeout(() => {
      console.log('[自测] ' + (priv ? '私聊' : '房间') + '文字帧 → 界面出现？', seen(word),
        '| hooked =', S.hooked, '| counters =', JSON.stringify(S.store.counters));
    }, 500);
  };

  const goCard = () => {
    window.socket._onmessage(cardFrame(U));
    setTimeout(() => {
      console.log('[自测] 点播卡片帧 → 界面出现卡片（找歌名「' + SONG + '」）？', seen(SONG),
        '| 当前卡片行数 =', document.querySelectorAll('[class*="systemCardMediaShare"]').length);
    }, 700);
  };

  // 拉黑后一屏看全三件事（默认口径：历史消息 + 卡片都该被清）
  const check = () => {
    setTimeout(() => {
      const cards = document.querySelectorAll('[class*="systemCardMediaShare"]').length;
      const keep = S.store.conf.keepHistory !== false;
      const clear = S.store.conf.clearCards !== false;
      console.log('[自测] 拉黑后 → 新文字帧可见？', seen(TEXT_WORD),
        '｜历史卡片仍在？（找歌名）', seen(SONG),
        '｜页面卡片行总数 =', cards,
        '｜开关：保留历史消息=', keep, ' 清卡片=', clear,
        '｜counters =', JSON.stringify(S.store.counters));
      console.log('[自测] 期望：新文字/新卡片都传不进来（看不到）；若第 1 步渲染正常，则历史里那个 uid 的卡片应已被清掉。'
        + ' 逐行判定可用 __T.S.debugSweep()');
    }, 400);
  };

  window.__T = {
    U, S, go, goCard, check,
    tip: '步骤：__T.go() 与 __T.goCard()（未拉黑，都应看到）→ __T.S.block(__T.U,\'测试甲\') → __T.check()（新消息/新卡片应看不到）→ __T.S.unblock(__T.U) 后 __T.go() 应又看到',
  };
  console.log('[自测] 就绪。' + window.__T.tip);
})();
