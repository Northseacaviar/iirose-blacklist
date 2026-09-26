/* CDN 清缓存 + 复核脚本（发版后必跑）
 *
 * 为什么非有它不可（2026-09-26 真机事故）：
 *   jsdelivr 对 **分支引用**（@main）的缓存是 s-maxage=43200（12 小时）。
 *   loader 请求主脚本时带的 `?t=时间戳` 只能绕开**浏览器**缓存 —— CDN 忽略查询串，
 *   照旧把它那份旧快照发回来。于是 v0.3.0/0.3.1/0.3.2 三次发版，
 *   用户页面一直跑着 v0.2.4（实测 = tag v0.2.6 的快照，md5 完全相同），新版功能自然"没实现"。
 *   gcore 那份缓存 jsdelivr 的 purge 接口覆盖不到（providers 只报 CF + FY），只能等它过期。
 *
 * 用法：node tools/purge-cdn.js         清缓存 → 逐主机复核版本 → 有落后就退出码 1
 *       node tools/purge-cdn.js --check 只复核不清
 * 说明：需要代理时设 HTTPS_PROXY 环境变量；带 --ssl-no-revoke（Windows schannel 吊销检查常报离线，会让请求假失败）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Northseacaviar/iirose-blacklist';
const HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net'];
// 要清的路径：'@ref/文件' 表示挂在版本引用上，'/文件' 表示走默认分支。
// 注意拼接是 gh/<user>/<repo> + <p>（p 自带 @ref 或前导斜杠），中间不要多一个斜杠 ——
// 多一个斜杠 jsdelivr 会当成"仓库名 + 子路径"，回 "Couldn't find the requested file"，
// 而 purge 接口照样回 finished，于是清缓存看起来成功、缓存其实没动（2026-09-26 踩过）。
const PATHS = ['@main/iirose-blacklist.js', '@main/loader.js', '/iirose-blacklist.js', '/loader.js'];
// loader 实际注入的是 tag 路径（@vX.Y.Z/iirose-blacklist.js），tag 不可变、缓存天然安全，但要确认线上拿得到
const TAG = (function () {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch (e) { return ''; }
})();
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
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
      const body = curl('https://purge.jsdelivr.net/gh/' + REPO + p);
      const ok = /"status":\s*"finished"/.test(body) || /"CF":\s*true/.test(body);
      console.log('purge ' + (ok ? '已提交  ' : '失败/未响应  ') + p);
    }
    await new Promise((r) => setTimeout(r, 3000));    // 等各 provider 生效
  }
  let bad = 0;
  for (const h of HOSTS) {
    for (const p of PATHS) {
      if (!/iirose-blacklist\.js$/.test(p)) continue;
      let got = '', lastBody = '';
      const url = 'https://' + h + '/gh/' + REPO + p + '?t=' + Date.now();   // 重试复用同一地址：
      // 第一次成功后 CDN 就有这份缓存了；每次换时间戳会逼 CDN 反复回源，反倒容易被它回 "Couldn't find the requested file"
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        const body = curl(url);
        got = (body.match(/const VERSION = '([^']+)'/) || [])[1] || '';
        if (!got) { lastBody = body; await new Promise((r) => setTimeout(r, 6000)); }
      }
      const okv = got === want;
      // gcore 那份 jsdelivr 的 purge 接口覆盖不到（providers 只报 CF + FY），只能等它过期；
      // loader 把 fastly 排在 gcore 前面，所以 gcore 落后只提示、不算失败
      const soft = (h === 'gcore.jsdelivr.net');
      if (!okv && !soft) bad++;
      console.log((okv ? '一致  ' : (soft ? '参考  ' : '落后  ')) + h + ' / ' + p + ' → '
        + (got || ('取不到（' + (lastBody ? lastBody.replace(/\s+/g, ' ').slice(0, 80) : '空响应') + '）')));
      await new Promise((r) => setTimeout(r, 1200));   // 别连发，jsdelivr 对突发请求会限流
    }
  }
  // loader 真正注入的是 tag 路径，单独核一遍（tag 不可变，正常应立刻一致）
  if (TAG) {
    let got = '';
    const url = 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + TAG + '/iirose-blacklist.js?t=' + Date.now();
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      got = (curl(url).match(/const VERSION = '([^']+)'/) || [])[1] || '';
      if (!got) await new Promise((r) => setTimeout(r, 4000));
    }
    const okv = got === want;
    if (!okv) bad++;
    console.log((okv ? '一致  ' : '落后  ') + 'cdn.jsdelivr.net / @' + TAG + '/iirose-blacklist.js（loader 用的就是这条）→ ' + (got || '取不到'));
  }
  console.log('期望版本 ' + want + (bad
    ? '：有 ' + bad + ' 处落后'
    : '：全部一致'));
  if (bad) process.exit(1);
})();
