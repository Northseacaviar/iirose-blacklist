/* 发布件同步脚本：src/iirose-blacklist.js → release/ 与仓库根目录
 *
 * 为什么要它：jsdelivr 的默认地址取的是仓库根目录那个文件，以前靠手工复制，
 * 忘了复制就会"测试全过但朋友拿到的是旧版"（实测到过一次）。
 *
 * 用法：node tools/publish.js        复制并校验
 *       node tools/publish.js --check 只校验不复制（CI/提交前用）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = 'src/iirose-blacklist.js';
const COPIES = ['release/iirose-blacklist.js', 'iirose-blacklist.js'];
// 测试页要断言"拿到的就是当前发布件"，版本号不能手写在测试里（发版就得改测试 = 早晚漏改，
// 2026-09-25 实测漏过一次：loader 两个测试页都钉着 '0.2.0'）。这里由脚本生成期望值。
const EXPECT_FILE = 'tests/expected-version.js';
const checkOnly = process.argv.indexOf('--check') >= 0;

const norm = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = norm(SRC);
const ver = (src.match(/const VERSION = '([^']+)'/) || [])[1] || '?';
const expectJs = '/* 由 tools/publish.js 自动生成 —— 别手改。loader 测试页用它断言"拿到的版本 = 当前发布件版本" */\n'
  + 'window.__EXPECTED_VERSION__ = ' + JSON.stringify(ver) + ';\n';

let bad = 0;
const curExpect = fs.existsSync(path.join(root, EXPECT_FILE)) ? norm(EXPECT_FILE) : null;
if (curExpect === expectJs) { console.log('一致  ' + EXPECT_FILE); }
else if (checkOnly) { console.log('落后  ' + EXPECT_FILE + '  ← 需要 node tools/publish.js'); bad++; }
else { fs.writeFileSync(path.join(root, EXPECT_FILE), expectJs); console.log('已同步 ' + EXPECT_FILE + '（期望版本 ' + ver + '）'); }
for (const c of COPIES) {
  const cur = fs.existsSync(path.join(root, c)) ? norm(c) : null;
  if (cur === src) { console.log('一致  ' + c); continue; }
  if (checkOnly) { console.log('落后  ' + c + '  ← 需要 node tools/publish.js'); bad++; continue; }
  fs.writeFileSync(path.join(root, c), src);
  console.log('已同步 ' + c);
}
if (checkOnly && bad) { console.log('有 ' + bad + ' 份发布件落后（版本 ' + ver + '）'); process.exit(1); }
console.log('发布件版本 ' + ver + ' —— 完成');
