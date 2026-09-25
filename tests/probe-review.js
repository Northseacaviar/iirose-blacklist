// 复核独立审查报告的两个「阻塞」项（用真实源码跑，不复制实现）
// 用法：node tests/probe-review.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./frames.js');

const SRC = path.join(__dirname, '..', 'src', 'iirose-blacklist.js');
const EXPORTS = ['defaultStore', 'normalizeStore', 'isBlockedIn', 'hasUid', 'unescapeHtml',
  'recordSeen', 'looksLikeUid', 'filterFrame', 'findUidByName', 'isRecordShaped', 'findBlockedToken', 'MAX_SEEN'];

const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/\/\/ #region CORE([\s\S]*?)\/\/ #endregion/);
const sandbox = { console, Date, JSON, Object, Array, String, Number, RegExp, Math };
vm.createContext(sandbox);
vm.runInContext(m[1] + '\n__exp = {' + EXPORTS.join(',') + '};', sandbox);
const L = sandbox.__exp;

const UID = F.ROOM_UID;           // 6533df3d933bf
const PUID = F.PRIV_UID;          // 5b0fe8a3b1ff2
const st = (uids) => { const s = L.defaultStore(); (uids || []).forEach((u) => { s.uids[u] = { name: 'x', ts: 1 }; }); return s; };

console.log('== B1-1 房间记录「内容」含 < ==');
{
  const rec = F.roomRec(UID, '甲', '5<3 is true', '1700000001');
  const frame = '"' + rec;
  const r = L.filterFrame(frame, st([UID]), null);
  console.log('  命中被拉黑者？ changed =', r.changed, ' blocked =', r.blocked.length, ' data===原帧 =', r.data === frame);
}
console.log('== B1-2 私聊记录「内容」含 <（被拉黑者 uid 在 [1]）==');
{
  const rec = F.privRec(PUID, '乙', 'a<b', '1700000101');
  const frame = '""' + rec;
  const r = L.filterFrame(frame, st([PUID]), null);
  console.log('  changed =', r.changed, ' blocked =', r.blocked.length);
  console.log('  输出 =', JSON.stringify(r.data));
}
console.log('== B1-3 房间记录「头衔」含 < ==');
{
  const rec = F.roomRec(UID, '甲', 'hi', '1700000001').replace("g'91'2325", "g'<9>'2325");
  const tail = F.roomRec(F.OTHER_UID, '乙', 'yo', '1700000002');
  const frame = '"' + rec + '<' + tail;
  const r = L.filterFrame(frame, st([UID]), null);
  console.log('  changed =', r.changed, ' blocked =', r.blocked.length);
  console.log('  输出 =', JSON.stringify(r.data));
  console.log('  输出里还有别人完整记录？', r.data ? r.data.indexOf(tail) >= 0 : false);
}
console.log('== B1-4 房间记录「名字」含 >（使 uid 下标错位）==');
{
  const rec = F.roomRec(UID, 'a>b', 'hi', '1700000001');
  const frame = '"' + rec;
  const r = L.filterFrame(frame, st([UID]), null);
  console.log('  changed =', r.changed, ' blocked =', r.blocked.length, ' data===原帧 =', r.data === frame);
}
console.log('== B2 lastSweepDiag 是否封顶（读源码）==');
{
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes('lastSweepDiag.push('));
  console.log('  push 处:', JSON.stringify(lines[at].trim()));
  console.log('  紧邻下一行:', JSON.stringify((lines[at + 1] || '').trim()));
  console.log('  含封顶语句？', src.includes('lastSweepDiag.length >'));
}
console.log('== S2 uid 为 __proto__ ==');
{
  const s = L.defaultStore();
  s.uids['__proto__'] = { name: 'x', ts: 1 };
  console.log('  写入后 own keys =', Object.keys(s.uids).length, ' isBlockedIn =', L.isBlockedIn(s, '__proto__'));
  L.recordSeen(s, '__proto__', 'evil');
  console.log('  recordSeen 后 seen own keys =', Object.keys(s.seen).length);
  console.log('  looksLikeUid("__proto__") =', L.looksLikeUid('__proto__'));
}
console.log('== 反向复核：正常帧没被误伤 ==');
{
  const s = st([UID, PUID]);
  const cases = [['房间单条', F.docRoom], ['房间多条', F.room3], ['私聊', F.priv2],
  ['弹幕', F.docDanmaku], ['快照', F.snapshot], ['媒体', F.mediaEvent]];
  cases.forEach(([n, f]) => {
    const r = L.filterFrame(f, s, null);
    const hit = /6533df3d933bf|5b0fe8a3b1ff2/.test(f);
    console.log('  ' + n + ': changed=' + r.changed + ' 含被拉黑 uid=' + hit);
  });
}
