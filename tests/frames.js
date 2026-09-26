// 帧样本：全部取自官方文档 XCWQW1/iirose-docs（markdown/event/event_message.md）+ iiroseForge 协议实现。
// 浏览器里挂在 window.FRAMES；Node 里 module.exports。
(function (root, factory) {
  const F = factory();
  if (typeof module === 'object' && module.exports) module.exports = F;
  if (root) root.FRAMES = F;
})(typeof window !== 'undefined' ? window : null, function () {
  const ROOM_UID = '6533df3d933bf';        // 文档例子里房间发言者的 uid
  const PRIV_UID = '5b0fe8a3b1ff2';        // 文档例子里私聊发送者的 uid
  const OTHER_UID = 'aabbccdd11223';       // 假想的另一个用户
  const THIRD_UID = 'zz99887766554';

  // 房间消息记录（8 个字段）：id>头像>用户名>内容>颜色>颜色>1>空>uid>头衔>随机数
  function roomRec(uid, name, text, id) {
    return [id, 'https://static.codemao.cn/i/23/10/21/22/2620-Z1.bmp', name, text,
      '040b02', '040b02', '1', '', uid, "g'91'2325", '406380554446'].join('>');
  }
  // 私聊记录：id>uid>用户名>头像>内容>颜色>空>颜色>3>背景图>随机数
  function privRec(uid, name, text, id) {
    return [id, uid, name, 'http://r.iirose.com/i/24/1/14/20/3912-02.jpg', text,
      '339f88', '', '339f88', '3', 'http://r.iirose.com/i/21/4/7/15/4636-YT.png', '958460378768'].join('>');
  }
  // 弹幕记录（单条）：用户名>内容>颜色>颜色>1>头像>消息id>uid>头衔>2325>f590
  function danmakuRec(uid, name, text) {
    return [name, text, '040b02', '040b02', '1',
      'https://static.codemao.cn/i/23/10/21/22/2620-Z1.bmp', '1706776052', uid, 'g', '2325', 'f590'].join('>');
  }

  // 信箱（通知）记录（7 字段）：用户名>头像>性别>标记(+附言)>背景>时间>颜色
  // 标记：'^ 关注 / '*' 点赞 / 'h 点踩 / '$ 转账（打赏）
  // 注意：信箱帧【没有 uid】—— 这正是它只能按 名字/头像 认人的原因
  function mailRec(name, avatar, marker, extra) {
    return [name, avatar, '2', "'" + marker + (extra || ''), '', '1762613079', 'd28ad2'].join('>');
  }
  // 房间公告（3 字段）：公告文本>背景>时间
  function noticeRec(text, bg, ts) {
    return [text, bg || 'bg.png', ts || '1762613000'].join('>');
  }

  return {
    ROOM_UID, PRIV_UID, OTHER_UID, THIRD_UID,
    roomRec, privRec, danmakuRec, mailRec, noticeRec,

    // 官方文档原样样本（回归对照，别改）
    docRoom: '"1706775936>https://static.codemao.cn/i/23/10/21/22/2620-Z1.bmp>XCWQW233>test>040b02>040b02>1>>6533df3d933bf>g\'91\'2325>406380554446',
    docPrivate: '""1706776691>5b0fe8a3b1ff2>春风萧落☾.‎˖٭𓂃>http://r.iirose.com/i/24/1/14/20/3912-02.jpg>test>339f88>>339f88>3>http://r.iirose.com/i/21/4/7/15/4636-YT.png>958460378768',
    docDanmaku: '=XCWQW233>test>040b02>040b02>1>https://static.codemao.cn/i/23/10/21/22/2620-Z1.bmp>1706776052>6533df3d933bf>g>2325>f590',
    docMailLike: "@*anata baka？>cartoon/600264>2>'*>>1762613079>d28ad2",   // 官方 docs/markdown/event/event_message.md 点赞样本

    // 信箱帧构造器（'@' + 子类型字符）
    MAIL_NAME: 'XCWQW233',                                   // 用房间样本里的名字做被拉黑者
    MAIL_NAME_CART: 'anata baka？',                           // 官方样本里的名字（卡通头像）
    MAIL_AVATAR_CART_DOM: 'https://s.iirose.com/images/icon/cartoon/600264.jpg',   // DOM 里同一头像的形态
    mailLike: (name, avatar) => '@*' + mailRec(name, avatar, '*'),
    mailFollower: (name, avatar) => '@*' + mailRec(name, avatar, '^'),
    mailDislike: (name, avatar) => '@*' + mailRec(name, avatar, 'h'),
    mailPayment: (name, avatar, money, note) => '@*' + mailRec(name, avatar, '$' + (money || 1) + ' ' + (note || '谢谢')),
    mailNotice: (text) => '@*' + noticeRec(text),
    mailTwo: (nameA, avatarA, nameB, avatarB) => '@*' + mailRec(nameA, avatarA, '*') + '<' + mailRec(nameB, avatarB, '^'),
    mailWeird: "@*不是信箱形状的东西>只有两个字段",

    // 多记录帧
    room3: '"' + [roomRec(OTHER_UID, '甲', 'AAA', '1700000001'),
      roomRec(ROOM_UID, 'XCWQW233', 'BBB', '1700000002'),
      roomRec(THIRD_UID, '丙', 'CCC', '1700000003')].join('<'),
    priv2: '""' + [privRec(PRIV_UID, '春风萧落', 'hello', '1700000101'),
      privRec(OTHER_UID, '甲', 'yo', '1700000102')].join('<'),

    // 应当原样透传的其它帧
    snapshot: '%*"cartoon/xxx>yyy<zzz',
    snapshot2: '%{"t":1,"u":[{"n":"甲"}]}',
    mediaEvent: '&1{"s":"//music.163.com/song/media/outer/url?id=1.mp3","d":240,"c":"http://x/y.jpg","n":"歌名","r":"歌手","b":"@0"}',
    danmakuSend: '~{"t":"test","c":"040b02","v":0}',
    unknownFrame: '`~1',
    heartbeat: 'c',
    garbage: ['"', '""', '="', 'not a frame', '%'],
  };
});
