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

// STORAGE 区块（官方外壳 + 存储适配）单独 extract 跑：可注入假的 Ext / localStorage
function loadStorage(opts) {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/\/\/ #region STORAGE([\s\S]*?)\/\/ #endregion/);
  if (!m) { console.error('未找到 // #region STORAGE 段'); process.exit(1); }
  const sandbox = { console: { warn() {}, log() {}, error() {} }, Date, JSON, Object, Array, String, Number, RegExp, Math,
    STORE_KEY: 'iirose_blacklist_v1', TAG: '[拉黑]', VERSION: '9.9.9', VERSION_CODE: 99 };
  if (opts && opts.Ext) sandbox.Ext = opts.Ext;
  if (opts && opts.localStorage) sandbox.localStorage = opts.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(m[1] + '\n__exp = { PKG_META, PKG_NAME, storageRead, storageWrite, storageRemove, storageText, storageMode, storageLabel };', sandbox);
  return sandbox.__exp;
}

function fakeLocal() {
  const data = {}; const calls = { get: 0, set: 0, remove: 0 };
  return {
    data, calls,
    getItem(k) { calls.get++; return k in data ? data[k] : null; },
    setItem(k, v) { calls.set++; data[k] = String(v); },
    removeItem(k) { calls.remove++; delete data[k]; },
  };
}
function fakeExt(opts) {
  const rec = { installs: [], settings: {}, removes: [] };
  const o = opts || {};
  const instance = {
    settings(k, v) {
      if (v === undefined) { if (o.readThrows) throw new Error('read boom'); return k in rec.settings ? rec.settings[k] : undefined; }
      if (o.writeThrows) throw new Error('write boom');
      rec.settings[k] = v; return v;
    },
    removeSettings(k) { rec.removes.push(k); delete rec.settings[k]; },
  };
  return { Ext: { Service: { install(name, meta) { rec.installs.push({ name, meta }); return instance; } } }, rec };
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

t('normalizeStore 保留新增的记录保留开关（否则用户关掉后刷新又变回默认）', () => {
  const d = L.normalizeStore({});
  eq(d.conf.keepHistory, false, '默认应为"拉黑时清掉他的历史消息"（2026-09-25 需求重新界定）');
  eq(d.conf.hideSession, true, '默认隐藏会话条目');
  eq(d.conf.clearCards, true, '默认应清掉被拉黑者的历史点播卡片');
  const a = L.normalizeStore({ conf: { confVersion: 2, keepHistory: true, hideSession: false, clearCards: false } });
  eq(a.conf.keepHistory, true); eq(a.conf.hideSession, false); eq(a.conf.clearCards, false);
  const b = L.normalizeStore({ conf: { keepHistory: 'yes', hideSession: 1, clearCards: 0 } });
  eq(b.conf.keepHistory, false, '非法值应回落默认 false（默认即清历史）');
  eq(b.conf.hideSession, true, '非法值应回落默认 true');
  eq(b.conf.clearCards, true, '非法值应回落默认 true（绝不因误传变成"保留卡片"）');
});

t('配置迁移：老落盘（没有 confVersion）的 keepHistory=true 视作旧默认值，迁到新默认；已迁移过的显式选择必须尊重', () => {
  const leg = L.normalizeStore({ conf: { keepHistory: true } });
  eq(leg.conf.keepHistory, false, '老配置应迁到"拉黑即清历史"');
  eq(leg.conf.clearCards, true, '老配置应带上"清卡片"新默认');
  eq(leg.__migrated, true, '老配置应打迁移标记（loadStore 据此回写 + 打日志）');
  eq(leg.conf.confVersion, 2, '迁移后要写上新配置版本号');

  const v2 = L.normalizeStore({ conf: { confVersion: 2, keepHistory: true, clearCards: false } });
  eq(v2.conf.keepHistory, true, '有 confVersion 的显式选择不能被迁移顶掉');
  eq(v2.conf.clearCards, false, '同上：显式关掉清卡片也要尊重');
  eq(!!v2.__migrated, false, '已迁移过的配置不该再迁移');

  const fresh = L.normalizeStore({});
  eq(fresh.conf.confVersion, 2, '新配置应带 confVersion');
  eq(!!fresh.__migrated, false, '空输入（新用户）不算迁移');
  const noConf = L.normalizeStore({ uids: { abcde123456: { name: '甲', ts: 1 } } });
  eq(!!noConf.__migrated, false, '连 conf 都没有的落盘也不该打迁移标记');
  eq(!!noConf.uids.abcde123456, true, '迁移逻辑不能弄丢名单');
});

t('发布件与源码一致：仓库根/release 的 iirose-blacklist.js 必须等于 src（防"发布件落后于源码"）', () => {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..');
  const norm = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const src = norm('src/iirose-blacklist.js');
  eq(norm('release/iirose-blacklist.js') === src, true, 'release/ 里的发布件落后于 src/（跑 node tools/publish.js）');
  eq(norm('iirose-blacklist.js') === src, true, '仓库根目录的发布件落后于 src/（跑 node tools/publish.js）');
});

t('测试页的期望版本文件与源码一致（它由 tools/publish.js 生成，防"发版忘了生成"）', () => {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'src/iirose-blacklist.js'), 'utf8');
  const ver = (src.match(/const VERSION = '([^']+)'/) || [])[1];
  ok(ver, '源码里找不到 VERSION');
  const exp = fs.readFileSync(path.join(root, 'tests/expected-version.js'), 'utf8');
  ok(exp.indexOf('"' + ver + '"') >= 0 || exp.indexOf("'" + ver + "'") >= 0,
    'tests/expected-version.js 没跟上源码版本 ' + ver + '（跑 node tools/publish.js）');
});

t('官方形态：Ext.Service.install 收到合规的包信息，且存储走 settings、绝不碰 localStorage', () => {
  const local = fakeLocal();
  const { Ext, rec } = fakeExt();
  const S = loadStorage({ Ext, localStorage: local });
  eq(S.storageMode, 'service');
  eq(S.storageLabel(), '官方 settings');
  eq(rec.installs.length, 1, '应恰好登记一次');
  eq(rec.installs[0].name, S.PKG_NAME);
  ok(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(S.PKG_NAME), '包名须为 作者名.应用名 且只含英文数字下划线：' + S.PKG_NAME);
  const m = rec.installs[0].meta;
  ['name', 'author', 'privacy', 'versionName', 'versionCode', 'description', 'outerLoad', 'device', 'runAt'].forEach((k) => {
    ok(k in m, '包信息缺字段：' + k);
  });
  ok(typeof m.versionCode === 'number' && m.versionCode >= 1, 'versionCode 须为数字');
  eq(m.runAt, 'allReady');
  eq(m.outerLoad, '', '无外部引用时必须为空串');
  ok(m.privacy && m.privacy.length > 10, 'privacy 必须公示（本插件会读消息内容）');
  // 写读删都走 settings
  eq(S.storageWrite('k', 'v'), null);
  eq(rec.settings.k, 'v');
  eq(S.storageRead('k'), 'v');
  S.storageRemove('k');
  eq(rec.removes.indexOf('k') >= 0, true, '删除应走 removeSettings');
  eq(local.calls.get + local.calls.set + local.calls.remove, 0, '官方形态下不许碰 localStorage');
});

t('注入形态：没有 Ext.Service 时退回 localStorage，mode 标成 local', () => {
  const local = fakeLocal();
  const S = loadStorage({ localStorage: local });
  eq(S.storageMode, 'local');
  eq(S.storageWrite('k', 'v'), null);
  eq(local.data.k, 'v');
  eq(S.storageRead('k'), 'v');
  S.storageRemove('k');
  eq(local.data.k, undefined);
});

t('官方 settings 回对象时也能吃（storageText 统一成字符串）', () => {
  const local = fakeLocal();
  const { Ext } = fakeExt();
  const S = loadStorage({ Ext, localStorage: local });
  eq(S.storageText({ a: 1 }), '{"a":1}');
  eq(S.storageText('x'), 'x');
  eq(S.storageText(null), null);
  eq(S.storageText(undefined), null);
});

t('存储抛异常时不崩：写失败返回错误对象（交给 saveFailed 显示），读失败返回 null', () => {
  const local = fakeLocal();
  const w = loadStorage({ Ext: fakeExt({ writeThrows: true }).Ext, localStorage: local });
  ok(w.storageWrite('k', 'v') instanceof Error, '写失败应返回错误对象');
  eq(w.storageRead('k'), null);
  const r = loadStorage({ Ext: fakeExt({ readThrows: true }).Ext, localStorage: local });
  eq(r.storageRead('k'), null, '读失败应回落 null');
});

console.log('\n== 结果 ==');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
