/* 自定义字体的字节解码（代码审计 F11）——纯逻辑，不碰 DOM、不依赖 Electron。
 *
 * 改前：渲染层拿到主进程返回的 base64 后，用 atob() 得到一个巨大的 JS 字符串，再逐字节塞进
 *       Uint8Array。24MB 的字体要循环两千多万次，主线程会明显卡一下，而且 base64 字符串 +
 *       二进制字符串 + 字节数组三份数据同时在内存里。
 * 改后：优先把 base64 交给浏览器自己的 data: URL 解码（fetch → arrayBuffer，原生实现，快且省
 *       内存）；任何一步失败（环境里没有 fetch / data: 被 CSP 拦 / 返回的不是 Response）才回退到
 *       原来的 atob 循环，字体加载的结果与以前完全一致。返回 { bytes, mode }，mode 只给自检
 *       断言用（'fetch' = 走原生解码，'atob' = 回退）。
 *       注意：index.html 的 CSP 里 connect-src 要带 data:，否则这条 fetch 会被拦、永远走回退。
 *
 * 浏览器挂 window.CWFontLogic（index.html 在 renderer.js 之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFontLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FONT_DATA_URL_PREFIX = 'data:font/ttf;base64,';

  async function decodeFontBase64(base64, options) {
    const opts = options || {};
    const raw = base64 == null ? '' : String(base64);
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl === 'function') {
      try {
        const response = await fetchImpl(FONT_DATA_URL_PREFIX + raw);
        if (!response || typeof response.arrayBuffer !== 'function') {
          throw new Error('字体数据不可用');
        }
        const buffer = await response.arrayBuffer();
        if (!buffer || typeof buffer.byteLength !== 'number') throw new Error('字体数据不可用');
        return { bytes: new Uint8Array(buffer), mode: 'fetch' };
      } catch {
        /* 原生解码失败：回退到下面的 atob 循环（字体加载行为不能因此变差） */
      }
    }
    const atobImpl = opts.atobImpl || (typeof atob === 'function' ? atob : null);
    if (typeof atobImpl !== 'function') throw new Error('当前环境不支持解码字体数据');
    const binary = atobImpl(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, mode: 'atob' };
  }

  return { FONT_DATA_URL_PREFIX, decodeFontBase64 };
});
