/*!
 * iirose 拉黑屏蔽 · 加载器（loader）v1 · 2026-09-25
 * 作者：Corvin Hermes（为北海做）
 *
 * 作用：**只注入这一个地址，就永远是最新版**。
 *   主脚本更新后，你不需要重新粘贴地址、不需要改 ?v= 数字、不需要手动刷 CDN 缓存 —— 刷新页面即可。
 *
 * 自己怎么用：站点里 `js` 粘贴下面这一行（和以前一样存在 extJs 里，可与其他插件地址空格分隔）：
 *   https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js
 *
 * 原理（三件事）：
 *   1. 相对【本文件所在的目录】取主脚本 —— 所以放在 jsdelivr 上就拉 jsdelivr，放在本地就拉本地，一份逻辑两处可用；
 *   2. 请求主脚本时带 `?t=时间戳` —— 浏览器/CDN 视为新地址，绕开 jsdelivr 分支地址那 7 天的缓存；
 *   3. 主脚本拉不到时自动换备用域名（fastly / gcore）再试一次。
 *
 * 不做的（刻意的）：
 *   - 不做"后台静默热更新"：脚本一旦执行就不该被替换，刷新页面才换版（和任何注入脚本一样）；
 *   - 不写 localStorage（官方规范：存储交给插件自己的双形态适配层）。
 */
(function () {
  'use strict';

  // 已经在跑了就别再来一份（重复注入会被主脚本的幂等守卫挡掉，但这里先省一次请求）
  if (window.__IIROSE_BLACKLIST__ || window.__IIROSE_BLACKLIST_INITED__) {
    try { console.log('[拉黑/loader] 插件已在运行，跳过加载'); } catch (e) { }
    return;
  }

  var MAIN = 'iirose-blacklist.js';
  var FALLBACK_HOSTS = ['fastly.jsdelivr.net', 'gcore.jsdelivr.net'];

  function selfUrl() {
    var s = document.currentScript;
    if (!s) {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/loader\.js(\?|$)/.test(all[i].src || '')) { s = all[i]; break; }
      }
    }
    return (s && s.src) || '';
  }

  var base = (function () {
    var u = selfUrl();
    if (u) return u.replace(/[^/]*$/, '');          // 去掉文件名，保留目录（含协议与主机）
    return 'https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/';
  })();

  var tried = 0;
  function candidates() {
    var list = [base];
    var host = base.match(/^https?:\/\/([^/]+)\//);
    if (host) {
      FALLBACK_HOSTS.forEach(function (h) {
        if (h !== host[1]) list.push(base.replace(/^https?:\/\/[^/]+\//, location.protocol + '//' + h + '/'));
      });
    }
    return list;
  }

  function inject(url, next) {
    var s = document.createElement('script');
    s.async = true;
    s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    s.onerror = function () {
      try { console.warn('[拉黑/loader] 加载失败：' + s.src); } catch (e) { }
      next();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function tryNext() {
    var list = candidates();
    if (tried >= list.length) {
      try {
        console.warn('[拉黑/loader] 所有地址都加载失败（网络被拦或 CDN 不可达）。'
          + '可临时改用直连地址：' + base + MAIN + '?v=' + Date.now());
      } catch (e) { }
      return;
    }
    var url = list[tried++] + MAIN;
    inject(url, tryNext);
  }

  tryNext();
})();
