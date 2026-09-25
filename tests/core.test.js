// 单测：把插件源码里 // #region CORE 段抽出来，在 Node vm 里跑真实源码（不复制实现）。
// 用法：node tests/core.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'iirose-blacklist.js');
const F = require('./frames.js');

const EXPORTS = ['defaultStore', 'normalizeStore', 'isBlockedIn', 'hasUid', 'unescapeHtml',
  'recordSeen', 'looksLikeUid', 'filterFrame', 'findUidByName', 'isRecordShaped', 'findBlockedToken', 'MAX_SEEN'];

function loadCore() {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/\/\/ #region CORE([\s\S]*?)\/\/ #endregion/);
  if (!m) { console.error('未找到 // #region CORE 段'); process.exit(1); }
  const sandbox = { console, Date, JSON, Object, Array, String, Number, RegExp, Math };
  vm.createContext(sandbox);
  vm.runInContext(m[1] + '\n__exp = {' + EXPORTS.join(',') + '};', sandbox);
  const L = sandbox.__exp;
  const missing = EXPORTS.filter((n) => !(n in L));
  if (missing.length) { console.error('CORE 导出缺失:', missing.join(', ')); process.exit(1); }
  return L;
}

const L = loadCore();

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + (e && e.message)); console.log('  FAIL ' + name + ' -> ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'eq') + ': 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'ok 失败'); }

function storeWith(uids) {
  const s = L.defaultStore();
  (uids || []).forEach((u) => { s.uids[u] = { name: 'x', ts: Date.now() }; });
  return s;
}

console.log('\n== 协议层：房间消息帧 ==');
t('房间里黑名单用户的记录被剔除、其余原样保序', () => {
  const s = storeWith([F.ROOM_UID]);
  const r = L.filterFrame(F.room3, s, null);
  eq(r.changed, true);
  eq(r.data, '"' + F.roomRec(F.OTHER_UID, '甲', 'AAA', '1700000001') + '<' + F.roomRec(F.THIRD_UID, '丙', 'CCC', '1700000003'));
  eq(r.blocked.length, 1);
  eq(r.blocked[0].uid, F.ROOM_UID);
  eq(r.blocked[0].name, 'XCWQW233');
  eq(r.blocked[0].kind, 'room');
});
t('无黑名单命中时帧字节级透传', () => {
  const r = L.filterFrame(F.room3, storeWith([]), null);
  eq(r.changed, false);
  eq(r.data, F.room3);
});
t('整帧只有一条且被拉黑 -> 整帧丢弃（data=null）', () => {
  const r = L.filterFrame(F.docRoom, storeWith([F.ROOM_UID]), null);
  eq(r.data, null);
});
t('官方文档样例未拉黑时原样通过', () => {
  const r = L.filterFrame(F.docRoom, storeWith([]), null);
  eq(r.data, F.docRoom);
});

console.log('\n== 协议层：私聊帧 ==');
t('私聊帧里被拉黑发送者的记录被剔除', () => {
  const s = storeWith([F.PRIV_UID]);
  const r = L.filterFrame(F.priv2, s, null);
  eq(r.data, '""' + F.privRec(F.OTHER_UID, '甲', 'yo', '1700000102'));
  eq(r.blocked[0].kind, 'priv');
});
t('私聊整帧被拉黑 -> 丢弃', () => {
  const r = L.filterFrame(F.docPrivate, storeWith([F.PRIV_UID]), null);
  eq(r.data, null);
  eq(r.changed, true);
});
t('私聊帧无命中 -> 透传', () => {
  const r = L.filterFrame(F.docPrivate, storeWith([F.OTHER_UID]), null);
  eq(r.data, F.docPrivate);
  eq(r.changed, false);
});

console.log('\n== 协议层：弹幕帧 ==');
t('弹幕帧被拉黑 -> 丢弃', () => {
  const r = L.filterFrame(F.docDanmaku, storeWith([F.ROOM_UID]), null);
  eq(r.data, null);
  eq(r.blocked[0].kind, 'danmaku');
});
t('弹幕帧未拉黑 -> 透传（单条不按 < 拆分）', () => {
  const r = L.filterFrame(F.docDanmaku, storeWith([]), null);
  eq(r.data, F.docDanmaku);
});

console.log('\n== 协议层：其它帧必须零影响 ==');
[['快照 %*"', F.snapshot], ['快照 %{', F.snapshot2], ['媒体事件 &1', F.mediaEvent],
['弹幕发送 ~{', F.danmakuSend], ['协议回包 `~1', F.unknownFrame], ['心跳 c', F.heartbeat]].forEach(([label, frame]) => {
  t('透传 ' + label, () => {
    const r = L.filterFrame(frame, storeWith([F.ROOM_UID, F.PRIV_UID, F.OTHER_UID]), null);
    eq(r.changed, false, 'changed');
    eq(r.data, frame);
  });
});
t('畸形输入不抛异常且不改内容', () => {
  F.garbage.concat(['', null, undefined, 123, {}]).forEach((g) => {
    const r = L.filterFrame(g, storeWith([F.ROOM_UID]), null);
    eq(r.data, g);
    eq(r.changed, false);
  });
});

console.log('\n== 开关 / 回调 / 转义 ==');
t('总开关关闭时不过滤', () => {
  const s = storeWith([F.ROOM_UID, F.PRIV_UID]); s.enabled = false;
  eq(L.filterFrame(F.room3, s, null).data, F.room3);
  eq(L.filterFrame(F.priv2, s, null).data, F.priv2);
  eq(L.filterFrame(F.docDanmaku, s, null).data, F.docDanmaku);
});
t('onSeen 对每条记录都回调，onBlock 只对命中回调', () => {
  const seen = [], blocked = [];
  L.filterFrame(F.room3, storeWith([F.ROOM_UID]), {
    onSeen: (uid, name, kind) => seen.push([uid, name, kind]),
    onBlock: (uid, kind) => blocked.push([uid, kind]),
  });
  eq(seen.length, 3);
  eq(seen[0][0], F.OTHER_UID); eq(seen[0][2], 'room');
  eq(blocked.length, 1); eq(blocked[0][0], F.ROOM_UID);
});
t('名字里的 HTML 实体被还原后再展示', () => {
  const frame = '"' + F.roomRec(F.ROOM_UID, '&lt;b&gt;&amp;x', 'hi', '1700000009');
  const r = L.filterFrame(frame, storeWith([F.ROOM_UID]), null);
  eq(r.blocked[0].name, '<b>&x');
});

console.log('\n== uid 识别 / 存储 / 名字查找 ==');
t('looksLikeUid 边界', () => {
  eq(L.looksLikeUid(''), false);
  eq(L.looksLikeUid('abc'), false);
  eq(L.looksLikeUid('12345'), true);
  eq(L.looksLikeUid('6533df3d933bf'), true);
  eq(L.looksLikeUid('a b'), false);
  eq(L.looksLikeUid('x'.repeat(41)), false);
  eq(L.looksLikeUid(null), false);
});
t('normalizeStore 容错：垃圾输入回落默认值，局部数据合并保留', () => {
  const d = L.normalizeStore(null);
  eq(d.enabled, true); eq(Object.keys(d.uids).length, 0); eq(d.counters.room, 0);
  const s = L.normalizeStore({ enabled: false, uids: { a1: { name: 'n', ts: 5 } }, seen: { b2: { name: 'm' } }, counters: { room: 7 }, conf: { debug: true } });
  eq(s.enabled, false); eq(s.uids.a1.name, 'n'); eq(s.uids.a1.ts, 5);
  eq(s.seen.b2.name, 'm'); eq(s.counters.room, 7); eq(s.counters.priv, 0); eq(s.conf.debug, true);
  eq(L.normalizeStore({ uids: { '': { name: 'x' } } }).uids[''], undefined);
});
t('recordSeen 有上限，最旧的被淘汰', () => {
  const s = L.defaultStore();
  for (let i = 0; i < L.MAX_SEEN + 20; i++) L.recordSeen(s, 'u' + i, 'n' + i);
  eq(Object.keys(s.seen).length, L.MAX_SEEN);
  eq(s.seen.u0, undefined);
  eq(!!s.seen['u' + (L.MAX_SEEN + 19)], true);
});
t('findUidByName 忽略大小写、取最近出现的', () => {
  const s = L.defaultStore();
  s.seen.u1 = { name: 'Alice', ts: 100 };
  s.seen.u2 = { name: 'alice', ts: 200 };
  s.seen.u3 = { name: 'Bob', ts: 300 };
  const r = L.findUidByName(s, 'ALICE');
  eq(r.uid, 'u2');
  eq(r.hits.length, 2);
  eq(L.findUidByName(s, 'nobody').uid, null);
  eq(L.findUidByName(s, '').uid, null);
});

console.log('\n== 审查报告回归（分隔符错位 / 原型污染）==');
t('B1-1 房间内容含 < ：不能静默漏过，也不能回拼残片（整帧丢）', () => {
  const frame = '"' + F.roomRec(F.ROOM_UID, '甲', '5<3 is true', '1700000001');
  const r = L.filterFrame(frame, storeWith([F.ROOM_UID]), null);
  eq(r.changed, true, 'changed');
  eq(r.data, null, 'data 应为 null（整帧丢弃）');
  eq(r.abnormal, true, 'abnormal');
});
t('B1-2 私聊内容含 < ：禁止把半截记录交给站点', () => {
  const frame = '""' + F.privRec(F.PRIV_UID, '乙', 'a<b', '1700000101');
  const r = L.filterFrame(frame, storeWith([F.PRIV_UID]), null);
  eq(r.data, null);
  eq(r.abnormal, true);
});
t('B1-3 头衔含 < ：整帧丢弃，绝不回拼畸形帧', () => {
  const rec = F.roomRec(F.ROOM_UID, '甲', 'hi', '1700000001').replace("g'91'2325", "g'<9>'2325");
  const frame = '"' + rec + '<' + F.roomRec(F.OTHER_UID, '乙', 'yo', '1700000002');
  const r = L.filterFrame(frame, storeWith([F.ROOM_UID]), null);
  eq(r.data, null);
  eq(r.abnormal, true);
});
t('B1-4 名字含 > 使 uid 下标错位：令牌级兜底仍能拦下', () => {
  const frame = '"' + F.roomRec(F.ROOM_UID, 'a>b', 'hi', '1700000001');
  const r = L.filterFrame(frame, storeWith([F.ROOM_UID]), null);
  eq(r.changed, true);
  eq(r.data, null);
  eq(r.abnormal, true);
});
t('健康帧不得被误判为可疑（abnormal 必须为假）', () => {
  [[F.docRoom, []], [F.docPrivate, []], [F.room3, []], [F.priv2, []], [F.docDanmaku, []]].forEach(([f, b]) => {
    const r = L.filterFrame(f, storeWith(b), null);
    eq(r.abnormal, false, '误判：' + f.slice(0, 40));
  });
});
t('S2 uid 为 __proto__ 时仍要真的成为 own 键', () => {
  const s = L.defaultStore();
  s.uids['__proto__'] = { name: 'x', ts: 1 };
  eq(Object.keys(s.uids).length, 1);
  eq(L.isBlockedIn(s, '__proto__'), true);
  L.recordSeen(s, '__proto__', 'evil');
  eq(Object.keys(s.seen).length, 1);
  const frame = '"' + F.roomRec('__proto__', 'x', 'hi', '1700000001');
  eq(L.filterFrame(frame, s, null).data, null, '拉黑 __proto__ 应生效');
});
t('normalizeStore 处理含 __proto__ 键的落盘数据', () => {
  const s = L.normalizeStore(JSON.parse('{"v":1,"uids":{"__proto__":{"name":"n","ts":7}}}'));
  eq(Object.keys(s.uids).length, 1);
  eq(s.uids['__proto__'].name, 'n');
});
t('令牌级兜底不误伤：可疑帧里出现的是"别人的 uid"→ 原样透传', () => {
  const frame = '"' + F.roomRec(F.OTHER_UID, 'a>b', 'hi', '1700000001');
  const r = L.filterFrame(frame, storeWith([F.ROOM_UID]), null);
  eq(r.changed, false, 'changed 应为 false');
  eq(r.data, frame, '应原样透传');
  eq(r.abnormal, true, '但应记一笔可疑');
});
t('shape 校验：残片必被识破（消息id 非数字 / uid 位不是 uid）', () => {
  eq(L.isRecordShaped(['b', '339f88', '', '339f88', '3'], 'priv'), false);
  eq(L.isRecordShaped(['3 is true', '040b02', '040b02'], 'room'), false);
  eq(L.isRecordShaped(['1706776691', '5b0fe8a3b1ff2', 'x'], 'priv'), true);
  eq(L.isRecordShaped(['1706775936', 'http://av', 'n', '', '', '', '1', '', '6533df3d933bf'], 'room'), true);
});

t('normalizeStore 保留面板位置（否则拖到的位置落盘后会丢）', () => {
  const a = L.normalizeStore({ conf: { panel: { left: 100, top: 200 } } });
  eq(a.conf.panel.left, 100); eq(a.conf.panel.top, 200);
  const b = L.normalizeStore({ conf: { panel: { left: 'x', top: 1 } } });
  eq(b.conf.panel, null, '非法值应回落 null（自动摆放）');
  const c = L.normalizeStore({});
  eq(c.conf.panel, null);
});

console.log('\n== 结果 ==');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
