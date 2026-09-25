/*!
 * iirose 拉黑屏蔽 · 加载器（loader）v1.1 · 2026-09-25
 * 作者：Corvin Hermes（为北海做）
 *
 * 作用：**只注入这一个地址，就永远是最新版**。
 *   主脚本更新后，你不需要重新粘贴地址、不需要改 ?v= 数字、不需要手动刷 CDN 缓存 —— 刷新页面即可。
 *
 * 自己怎么用：站点里 `js` 粘贴下面这一行（和以前一样存在 extJs 里，可与其他插件地址空格分隔）：
 *   https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/loader.js
 *
 * 原理（四件事）：
 *   1. 相对【本文件所在的目录】取主脚本 —— 所以放在 jsdelivr 上就拉 jsdelivr，放在本地就拉本地，一份逻辑两处可用；
 *   2. 在 jsdelivr 上**显式取 `@main` 分支**（实测坑：无 ref 的默认地址解析到「最新 tag 的快照」，
 *      只要没打 tag，推到 main 的修复就送不到用户手里）；本文件地址若自己带了版本（如 `@v0.2.1/loader.js`），
 *      则尊重它、不插 `@main` —— 一句话：你钉版本就跟着钉，不钉就跟着 main；
 *   3. 请求主脚本时带 `?t=时间戳` —— 浏览器视为新地址，绕开那 7 天的缓存（jsdelivr 实测忽略查询串，照常返回文件）；
 *   4. 主脚本拉不到时自动换备用域名（fastly / gcore）再试一次。
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

  var self_src = selfUrl();
  var base = (function () {
    if (!self_src) return 'https://cdn.jsdelivr.net/gh/Northseacaviar/iirose-blacklist/';
    return self_src.replace(/[^/]*$/, '');          // 去掉文件名，保留目录（含协议与主机）
  })();

  // 主脚本取址：jsdelivr 上显式钉 @main（本文件地址若已带 @版本，则尊重它）
  var mainSrc = (function () {
    var dir = base.replace(/\/$/, '');
    if (/jsdelivr\.net/.test(base) && !/@[^/]+\/?$/.test(dir)) return dir + '@main/' + MAIN;
    return base + MAIN;
  })();

  var tried = 0;
  function candidates() {
    var list = [mainSrc];
    var host = mainSrc.match(/^https?:\/\/([^/]+)\//);
    if (host) {
      FALLBACK_HOSTS.forEach(function (h) {
        if (h !== host[1]) list.push(mainSrc.replace(/^https?:\/\/[^/]+\//, location.protocol + '//' + h + '/'));
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
          + '可临时改用直连地址：' + mainSrc + '?v=' + Date.now());
      } catch (e) { }
      return;
    }
    var url = list[tried++];
    inject(url, tryNext);
  }

  tryNext();
})();
