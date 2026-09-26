/* 探针「信箱3 · 真帧」——抓「点赞/转账/关注/踩」的真实通知帧，并当场算出插件为什么会/不会拦它
 *
 * 为什么要有这个：插件在协议层丢帧时加了一道「形状守卫」（第 3 格必须是 1~3、第 5 格是 9~11 位时间戳、
 * 第 6 格是 6 位颜色），守卫不过就把整条记录当"形状不认识"原样放行（宁可漏、不误伤）。
 * 真机反馈"还是通知了"，最可能就是真实帧的这几格跟假设不一样 —— 这台探针就是把真帧和判定一起带回来。
 *
 * 怎么用（手机/电脑都行，只要是你已经注入过拉黑插件的那个页面）：
 *   1) 在房间页（有 socket 的那层）打开控制台，把本文件全部内容粘贴进去、回车；
 *   2) 让对方给你**点一次赞**（或转一次账）；也可以自己先随便发条消息确认探针活着；
 *   3) 看到控制台打「【已存文件】」就说明拿到手了 —— json 会存进「下载」目录，文件名 blk-mail3-*.json；
 *   4) 等 90 秒什么都没抓到也会自动存一份（那种情况说明帧压根没到这一层）。
 *
 * 它只读：包一层收包函数做记录，不改数据、不发包、不动插件状态。
 */
(function () {
  var TAG = '[探针3·信箱真帧]';
  var W = window, D = document;

  // 站点把 socket 放在房间 iframe（#mainFrame）里；插件在哪一层，探针就跟着去哪一层
  function findSocketWindow() {
    var cands = [window];
    try {
      var f = document.getElementById('mainFrame');
      if (f && f.contentWindow) cands.unshift(f.contentWindow);
      var all = document.getElementsByTagName('iframe');
      for (var i = 0; i < all.length; i++) {
        try { if (all[i].contentWindow && all[i].contentWindow.socket) cands.unshift(all[i].contentWindow); } catch (e) { }
      }
    } catch (e) { }
    for (var j = 0; j < cands.length; j++) {
      try { if (cands[j].socket && typeof cands[j].socket._onmessage === 'function') return cands[j]; } catch (e) { }
    }
    return null;
  }

  var SW = findSocketWindow();
  if (!SW) { console.log(TAG, '没找到 socket（在房间页里跑；页面还没连上就刷新再来一次）'); return; }
  W = SW; D = SW.document;

  var CAP = W.__MAIL3__ = W.__MAIL3__ || { t0: Date.now(), frames: [], cards: [], notes: [], saved: 0 };
  if (CAP.hooked) { console.log(TAG, '已经装过了 —— 直接让对方点赞就行'); return; }

  function PLG() { try { return W.__IIROSE_BLACKLIST__ || window.__IIROSE_BLACKLIST__ || null; } catch (e) { return null; } }
  function DIAG() { try { var p = PLG(); return (p && p._diag) || null; } catch (e) { return null; } }

  /* ---- 判定：把一条记录按插件的规则算一遍，给出"会不会被拦"的每一步 ---- */
  var MARK = { '^': 'follower', '*': 'like', 'h': 'dislike', '$': 'payment' };
  function verdict(recRaw) {
    var rec = String(recRaw == null ? '' : recRaw);
    var quoted = rec.charAt(0) === '"';
    if (quoted) rec = rec.slice(1);
    var f = rec.split('>');
    var marker = String(f[3] || '');
    var v = {
      fields: f.length,
      quoted: quoted,
      name: f[0] || '',
      f2: String(f[2] || ''), f3: String(f[3] || ''), f5: String(f[5] || ''), f6: String(f[6] || ''),
      marker1: marker.charAt(1),
      guardGender: /^[1-3]$/.test(String(f[2] || '')),
      guardTime: /^\d{9,11}$/.test(String(f[5] || '')),
      guardColor: /^[0-9a-fA-F]{6}$/.test(String(f[6] || '')),
      markerOk: marker.charAt(0) === "'",
    };
    v.type = v.markerOk ? (MARK[v.marker1] || null) : null;
    v.blockable = !!v.type && v.type !== 'payment';
    var d = DIAG(), plg = PLG();
    try {
      // 正确调用是 mailHit(store, name)；单参调用会静默返回 null（自己踩过，记在注释里免得再来一次）
      var r = (d && d.mailHit) ? d.mailHit(plg && plg.store, f[0]) : null;
      if (r == null && d && d.mailHit && d.mailHit.length <= 1) r = d.mailHit(f[0]);
      v.nameHit = (d && d.mailHit) ? !!r : null;
    } catch (e) { v.nameHit = null; }
    v.wouldBlock = !!(v.fields === 7 && v.markerOk && v.type && v.guardGender && v.guardTime && v.guardColor && v.blockable && v.nameHit);
    v.why = v.wouldBlock ? '会被协议层丢掉'
      : !v.markerOk ? '第4格不是 "\'X" 形式（形状不认识 → 放行）'
        : !v.type ? '类型字符 ' + JSON.stringify(v.marker1) + ' 不在插件表里（放行）'
          : !v.guardGender ? '第3格不是 1~3（守卫不过 → 放行）'
            : !v.guardTime ? '第5格不是 9~11 位数字（守卫不过 → 放行）'
              : !v.guardColor ? '第6格不是 6 位颜色（守卫不过 → 放行）'
                : !v.blockable ? '转账这类"永远不丢帧"（只在界面层藏）'
                  : !v.nameHit ? '名字没命中黑名单'
                    : '其它';
    return v;
  }

  /* ---- 收包：包在插件钩子**外面**，拿到的是进插件之前的原始帧 ---- */
  /* ---- 收包：包在插件钩子**外面**，拿到的是进插件之前的原始帧 ----
   * 注意顺序：必须等插件自己先挂上（`_onmessage.__blWrapped === true`），我们再包一层。
   * 反过来的话（我们先挂、还带上 __blWrapped 标记）插件会以为"已经有钩子了"从而永不挂载 ——
   * 那等于探针把屏蔽功能关掉了，测出来的结论全是假的。 */
  var CAPHOOK = function (s) {
    var orig = s._onmessage;
    var w = function () {
      try {
        var d = arguments[0];
        if (typeof d === 'string' && d.length) {
          var p = d.charAt(0);
          if (p === '@' || p === '%' || CAP.frames.length < 25) {
            var recs = (p === '@' || p === '%') ? d.slice(2).split('<') : [];
            var item = { t: Date.now(), p: p, len: d.length, text: d.slice(0, 1500), verdicts: recs.map(verdict) };
            CAP.frames.push(item);
            if (CAP.frames.length > 120) CAP.frames.shift();
          }
          if (p === '@' || p === '%') {
            var hit = null;
            try { hit = (d.slice(2).split('<').map(verdict).filter(function (x) { return x.wouldBlock; })[0]) || null; } catch (e) { }
            console.log(TAG, '收到 ' + p + ' 帧（' + d.length + ' 字节）', hit ? ('★ 该被拦：' + hit.name + ' / ' + hit.why) : '（没有可拦的记录，逐条判定见 json）');
            console.log(TAG, '原始文本：', d.slice(0, 600));
            setTimeout(function () { save('收到 ' + p + ' 帧'); }, 2000);
          }
        }
      } catch (e) { try { CAP.notes.push('收包记录出错：' + e.message); } catch (_) { } }
      return orig.apply(this, arguments);
    };
    w.__mail3 = 1;
    w.__blWrapped = true;      // 声明"插件的钩子还在"：我们包的是插件那层，插件就不会再来顶我们
    s._onmessage = w;
    return true;
  };

  var waited = 0;
  (function armWhenPluginReady() {
    var s2 = W.socket;
    if (s2 && typeof s2._onmessage === 'function' && s2._onmessage.__blWrapped === true) {
      CAPHOOK(s2);
      CAP.hooked = 1;
      CAP.notes.push('插件钩子就位后才包（等了 ' + waited + 'ms）');
      console.log(TAG, '已装好（等插件钩子 ' + waited + 'ms）');
      return;
    }
    if (waited > 30000) {
      CAP.notes.push('30 秒内没等到插件的钩子（插件没加载 / 被别的插件顶掉？）—— 这时候探针只记卡片，不记帧');
      console.log(TAG, '没等到插件钩子（30 秒）；探针改为只记录信箱卡片');
      return;
    }
    waited += 200;
    setTimeout(armWhenPluginReady, 200);
  })();


  // 万一站点/插件把 socket._onmessage 又换了一圈（实测插件重挂时会包在探针外面），
  // 每 0.5 秒把探针这层补回到最外层（并记一笔，方便我判断有没有丢帧窗口）
  setInterval(function () {
    try {
      var cs = W.socket;
      if (!cs || typeof cs._onmessage !== 'function') return;
      if (cs._onmessage.__mail3) return;
      var inner = cs._onmessage;
      var w2 = function () {
        try { var d = arguments[0]; if (typeof d === 'string' && d.length && (d.charAt(0) === '@' || d.charAt(0) === '%')) { CAP.frames.push({ t: Date.now(), p: d.charAt(0), len: d.length, text: d.slice(0, 1500), verdicts: d.slice(2).split('<').map(verdict) }); } } catch (e) { }
        return inner.apply(this, arguments);
      };
      w2.__mail3 = 1; w2.__blWrapped = true;
      cs._onmessage = w2;
      CAP.notes.push('重新挂上探针层（socket 被换过）@' + Date.now());
    } catch (e) { }
  }, 500);

  // 兜底证据：信箱面板里新插入的卡片，抓到它的 HTML 和"插件有没有藏它"
  try {
    var panel = D.getElementById('leaveMsgHolder') || D.body;
    var mo = new MutationObserver(function (ms) {
      ms.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          try {
            var cards = [];
            if (n.classList && n.classList.contains('cardTag')) cards.push(n);
            if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('.cardTag'), function (x) { cards.push(x); });
            cards.forEach(function (c) {
              CAP.cards.push({ t: Date.now(), kind: 'dom', name: (function () { var e = c.querySelector ? c.querySelector('.cardTagName') : null; return e ? String(e.textContent || '').trim() : ''; })(),
                hidden: c.hasAttribute('data-bl-mail-hidden'), display: c.style.display || '', text: String(c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), html: String(c.outerHTML || '').slice(0, 1200) });
              if (CAP.cards.length > 40) CAP.cards.shift();
            });
          } catch (e) { }
        });
      });
    });
    mo.observe(panel === D.body ? D.body : panel.parentNode || D.body, { childList: true, subtree: true });
    CAP.notes.push('卡片监听已挂（面板 ' + (D.getElementById('leaveMsgHolder') ? '已在 DOM' : '还没建出来') + '）');
  } catch (e) { CAP.notes.push('卡片监听没挂上：' + e.message); }


  /* ---- 信箱卡片快照（插件认不认得出这张卡）---- */
  function snapCards(why) {
    try {
      var d = DIAG();
      if (!d || !d.mailCards) { CAP.notes.push('插件没提供 _diag.mailCards（版本老的插件就会这样）'); return; }
      var c = d.mailCards();
      var key = JSON.stringify(c.rows);
      if (key !== CAP.lastCards) {
        CAP.lastCards = key;
        CAP.cards.push({ t: Date.now(), why: why, state: c });
        console.log(TAG, '信箱卡片快照：' + c.rows.length + ' 张', c.rows.map(function (r) { return r.name + (r.blocked ? '(名单)' : '') + (r.hidden ? '[已藏]' : '[露着]'); }).join(' / '));
      }
    } catch (e) { try { CAP.notes.push('卡片快照出错：' + e.message); } catch (_) { } }
  }

  /* ---- 落盘（自动下载到「下载」目录）---- */
  function save(why) {
    try {
      var p = PLG();
      var data = JSON.stringify({
        when: new Date().toISOString(),
        why: why,
        url: location.href,
        socketFrame: (function () { try { return W.location.href; } catch (e) { return '?'; } })(),
        plugin: {
          version: p ? p.version : null,
          hooked: p ? p.hooked : null,
          store: p ? JSON.parse(JSON.stringify(p.store)) : null,
          storage: p ? (p.storage ? p.storage() : null) : null,
        },
        frames: CAP.frames,
        cards: CAP.cards,
        notes: CAP.notes,
      }, null, 1);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blk-mail3-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 3000);
      CAP.saved++;
      console.log(TAG + '【已存文件】下载目录里 blk-mail3-*.json（' + data.length + ' 字节）｜原因：' + why);
    } catch (e) { console.log(TAG, '存文件失败：' + e.message); }
  }

  snapCards('装上时');
  var iv = setInterval(function () { if (CAP.saved >= 3) { clearInterval(iv); return; } snapCards('定时'); }, 4000);
  setTimeout(function () { snapCards('90 秒'); if (!CAP.saved) save('90 秒到点'); }, 90000);
  setTimeout(function () { snapCards('3 分钟'); if (CAP.saved < 2) save('3 分钟到点'); }, 180000);

  console.log(TAG, '已装好（插件版本 ' + (PLG() ? PLG().version : '读不到') + '，socket 在 ' + (function () { try { return W.location.href; } catch (e) { return '?'; } })() + '）');
  console.log(TAG, '现在让对方给你点一次赞 —— 抓到就会自动存 json，并在这里打出判定。');
})();
