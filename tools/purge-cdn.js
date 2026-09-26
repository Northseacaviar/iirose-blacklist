/* CDN 清缓存 + 复核脚本（发版后必跑）
 *
 * 为什么非有它不可（2026-09-26 真机事故）：
 *   jsdelivr 对 **分支引用**（@main）的缓存是 s-maxage=43200（12 小时）。
 *   loader 请求主脚本时带的 `?t=时间戳` 只能绕开**浏览器**缓存 —— CDN 忽略查询串，
 *   照旧把它那份旧快照发回来。于是 v0.3.0/0.3.1/0.3.2 三次发版，
 *   北海的页面一直跑着 v0.2.4（实测 = tag v0.2.6 的快照，md5 完全相同），信箱通知自然"没实现"。
 *   gcore 那份缓存 jsdelivr 的 purge 接口覆盖不到（providers 只报 CF + FY），只能等它过期。
 *
 * 用法：node tools/purge-cdn.js         清缓存 → 逐主机复核版本 → 有落后就退出码 1
 *       node tools/purge-cdn.js --check 只复核不清
 * 说明：走本机 Clash 代理、带 --ssl-no-revoke（本机 schannel 吊销检查常报离线，会让请求假失败）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Northseacaviar/iirose-blacklist';
const HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net'];
const PATHS = ['iirose-blacklist@main/iirose-blacklist.js', 'iirose-blacklist@main/loader.js',
  'iirose-blacklist/iirose-blacklist.js', 'iirose-blacklist/loader.js'];
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';
const checkOnly = process.argv.indexOf('--check') >= 0;

const want = (fs.readFileSync(path.join(__dirname, '..', 'src', 'iirose-blacklist.js'), 'utf8')
  .match(/const VERSION = '([^']+)'/) || [])[1];

function curl(url) {
  const args = ['-s', '--ssl-no-revoke', '--max-time', '30'];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  try { return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 << 20 }); }
  catch (e) { return ''; }
}

(async function () {
  if (!checkOnly) {
    for (const p of PATHS) {
      const body = curl('https://purge.jsdelivr.net/gh/' + REPO + '/' + p);
      const ok = /"status":\s*"finished"/.test(body) || /"CF":\s*true/.test(body);
      console.log('purge ' + (ok ? '已提交  ' : '失败/未响应  ') + p);
    }
    await new Promise((r) => setTimeout(r, 3000));    // 等各 provider 生效
  }
  let bad = 0;
  for (const h of HOSTS) {
    for (const p of PATHS) {
      if (!/iirose-blacklist\.js$/.test(p)) continue;
      const body = curl('https://' + h + '/gh/' + REPO + '/' + p + '?t=' + Date.now());
      const got = (body.match(/const VERSION = '([^']+)'/) || [])[1];
      const okv = got === want;
      if (!okv) bad++;
      console.log((okv ? '一致  ' : '落后  ') + h + ' / ' + p + ' → '
        + (got || ('取不到（' + (body ? body.replace(/\s+/g, ' ').slice(0, 80) : '空响应，可能被限流') + '）')));
      await new Promise((r) => setTimeout(r, 1200));   // 别连发，jsdelivr 对突发请求会限流
    }
  }
  console.log('期望版本 ' + want + (bad
    ? '：有 ' + bad + ' 处落后（gcore 的 @main 只能等它自己过期；loader 已把 fastly 排在它前面）'
    : '：全部一致'));
  if (bad) process.exit(1);
})();
