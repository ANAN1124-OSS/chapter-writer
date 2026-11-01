/* 跨模块公共小工具（v0.9 B-3，代码精简 B3）——纯逻辑，不碰 DOM、不读盘、不联网、不 require electron。
 *
 * 为什么单独一个文件：这几个小工具原来在多个模块里各抄一份，改一处得记得改所有份：
 *   - pad2：6 个 core 模块各一份（history / logs / fragments / snapshot / stats / template），
 *     storage.js / repair.js / stats.js 里还有 3 处同样逻辑的内联 `const pad = (n) => …`；
 *   - clampInt：3 个 core 模块（proofread / sensitive / tts）+ 2 个渲染层纯逻辑模块（editor-logic / find-logic）；
 *   - sleep：原子写重试（atomic.js）与截图驱动（scripts/screenshot-driver.js）各一份。
 * 收编的原则是**行为零变化**：每份的字面实现本来就一模一样（见 tests/common.test.js 的回归断言），
 * 这里只是把它挪到一个地方，调用点换成 require / 全局对象。
 *
 * 边界（红线）：
 *   - 只做字符串补位、数字夹紧、等一会儿这类最基础的事，**不含任何业务规则**；
 *   - 不读盘 / 不写盘 / 不 require fs、path、electron，也不碰 process / window（除 UMD 挂载那一行）；
 *   - 主进程（core/*、main.js）、渲染层（index.html 里 <script src="../core/common.js">）与单测三处共用，
 *     所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWCommon。
 *
 * 加载顺序（浏览器）：index.html 里 core/common.js 必须排在 core/template.js、editor-logic.js、
 * find-logic.js 之前；那些模块拿不到 window.CWCommon 会直接抛错，而不是悄悄退回一份旧副本。
 * 新增工具请先问自己：是不是「两个以上模块都要用的纯计算」？只有一个调用方就别放进来。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWCommon = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 两位补零：7 → '07'、12 → '12'。只做字符串补位，不取整、不取模（调用方给什么就写什么）。
  // 注意和 String.prototype.padStart 一致：超过两位的数字原样返回（100 → '100'）。
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // 整数夹紧：先 Math.floor(Number(value))；非有限数（含 undefined / '' / NaN / Infinity）退回 fallback，
  // 其余夹到 range（含两端）。range 的语义就是调用方传的 [下限, 上限]，这里不做校验。
  function clampInt(value, fallback, range) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, range[0]), range[1]);
  }

  // 等一会儿（毫秒）：原子写失败重试的间隔、截图驱动等界面稳定用。永远 resolve，不 reject。
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return { pad2, clampInt, sleep };
});
