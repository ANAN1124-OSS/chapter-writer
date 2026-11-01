// E2E 第 56 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组自足：期望值只有一处来源 core/security-policy.js（单测断言同一份常量）；单实例锁那条
// 真的再启动一个进程（同 userData），它拿不到锁就退出，不碰临时书库、不跑第二份场景。
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = async function group56SecuritySwitches(t) {
  const {
    exec,
    check,
    sleep,
    userData,
    booksRoot,
    // 窗口登记 / 安全策略探针由主进程侧注入（场景里的 ctx.windowsInfo / securityInfo / securityProbe），
    // 组文件不 require 产品代码，只把这些能力当参数拿进来。
    windowsInfo,
    securityInfo,
    securityProbe,
    registryCounts,
    // webPreferences 的期望值只有一处来源：core/security-policy.js 的只读常量（场景侧 require 后交进来）。
    securityPolicy,
    // 单实例锁那条按仓库根目录启动第二个进程（场景里的 __dirname = scripts，组文件在 groups/ 下更深一层）。
    appRoot,
    // 本组最后要把自动化窗口重新拿回系统焦点（场景里的本地 helper，不在 harness）。
    ensureWindowFocus
  } = t;

  // 56. Electron 安全开关与窗口行为（v0.9 C-1）：
  //     在真实 Electron 里复核窗口 webPreferences（sandbox / contextIsolation / nodeIntegration / webSecurity…）、
  //     渲染层确实拿不到 Node、window.open / 外部导航 / <webview> 都被拦、浏览器权限一律拒绝
  //     （含「被拒请求的日志字段不含本机路径」）、单实例锁生效（再启动一个进程不多开窗口）、
  //     页面 CSP 真的在拦（内联脚本不执行 + eval 被拒，v0.9 C-10 补；object-src / base-uri /
  //     frame-src 收紧到 none 且动态 <base> 改不了文档基地址，v0.9 C-4 收尾；form-action 也补了
  //     'none'，页面本来就没有 <form>，零行为变化）。
  //     期望值只有一处来源：core/security-policy.js（单测断言同一份常量）。
  //     放在多窗口组之前：那一组最后会关掉最后一个窗口让应用退出。
  const liveWindowCount = () => windowsInfo().filter((item) => !item.destroyed).length;
  const secInfo = securityInfo();
  // Electron 回读 webPreferences 时少 preload / spellcheck（见 PREFERENCES_NOT_READ_BACK），
  // 所以对账口径走 policy.preferenceDiff()：preload 另用「渲染层真的能用到 window.api」证明。
  const prefDiff = securityPolicy.preferenceDiff(secInfo.webPreferences);
  check(
    '安全开关：真实窗口的 webPreferences 与 core/security-policy 逐项一致',
    prefDiff.length === 0,
    { prefDiff, readBack: secInfo.webPreferences, notReadBack: securityPolicy.PREFERENCES_NOT_READ_BACK }
  );
  const bridgeProbe = JSON.parse(
    await exec(
      `JSON.stringify({ api: typeof window.api, readFont: typeof window.api.readFont, getConfig: typeof window.api.getConfig })`
    )
  );
  check(
    '安全开关：preload 桥接就位（Electron 不回读 preload，用 window.api 实测）',
    bridgeProbe.api === 'object' &&
      bridgeProbe.readFont === 'function' &&
      bridgeProbe.getConfig === 'function',
    bridgeProbe
  );
  check('安全开关：单实例锁已拿到', secInfo.singleInstanceLock === true);
  check('安全开关：权限请求 / 检查两个处理器都已注册', secInfo.sessionHandlers === true);
  check(
    '安全开关：进程里只有窗口这一类 webContents（没有隐藏的 webview / 后台页）',
    Array.isArray(secInfo.contentTypes) &&
      secInfo.contentTypes.length === liveWindowCount() &&
      secInfo.contentTypes.every((type) => type === 'window'),
    secInfo.contentTypes
  );
  const nodeGlobals = JSON.parse(
    await exec(
      `JSON.stringify({ require: typeof require, module: typeof module, api: typeof window.api, process: typeof process })`
    )
  );
  check(
    '安全开关：渲染层拿不到 Node（require / module / process 都不存在），只能走 preload 的 window.api',
    nodeGlobals.require === 'undefined' &&
      nodeGlobals.module === 'undefined' &&
      nodeGlobals.process === 'undefined' &&
      nodeGlobals.api === 'object',
    nodeGlobals
  );
  const windowsBeforeOpen = liveWindowCount();
  const openProbe = JSON.parse(
    await exec(
      `(() => { try { const opened = window.open('https://example.com/cw-window-open'); return JSON.stringify({ returned: opened === null ? 'null' : typeof opened }); } catch (err) { return JSON.stringify({ error: String(err && err.name) }); } })()`
    )
  );
  check('安全开关：window.open 被拒绝（返回 null，不开新窗口）', openProbe.returned === 'null', openProbe);
  await sleep(300);
  check(
    '安全开关：window.open 之后没有多出窗口 / webContents',
    liveWindowCount() === windowsBeforeOpen &&
      securityInfo().contentTypes.every((type) => type === 'window')
  );
  const navProbe = JSON.parse(
    await exec(
      `(async () => { const before = location.href; try { location.href = 'https://example.com/cw-nav-blocked'; } catch (err) { /* 拦下时可能抛 */ } await new Promise((resolve) => setTimeout(resolve, 500)); return JSON.stringify({ before, after: location.href, app: typeof window.__cwTest }); })()`
    )
  );
  check(
    '安全开关：外部导航被拦在本页（location 没变，应用还在）',
    navProbe.before === navProbe.after && navProbe.app === 'object',
    navProbe
  );
  const webviewProbe = JSON.parse(
    await exec(
      `(() => { const el = document.createElement('webview'); return JSON.stringify({ tag: String(el.tagName), loadURL: typeof el.loadURL }); })()`
    )
  );
  check(
    '安全开关：渲染层没有 <webview> 能力（webviewTag 关闭）',
    webviewProbe.loadURL === 'undefined',
    webviewProbe
  );
  // CSP（v0.9 C-10 补的运行时复核）：meta 只是声明，这里在真实页面里证明它真的在拦——
  // 内联 <script> 不执行且收到 script-src 违规事件、eval / new Function 被 script-src 拒绝。
  const cspProbe = JSON.parse(
    await exec(
      `(async () => {
        const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        const script = document.createElement('script');
        script.textContent = 'window.__cwCspInlineRan = true';
        const violation = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 3000);
          document.addEventListener('securitypolicyviolation', function once(event) {
            clearTimeout(timer);
            document.removeEventListener('securitypolicyviolation', once);
            resolve({ directive: event.effectiveDirective || event.violatedDirective || '', sample: event.sample || '' });
          });
          document.body.appendChild(script);
        });
        script.remove();
        let evalError = null;
        try { new Function('return 1')(); } catch (err) { evalError = err && err.name; }
        // base-uri 'none'（v0.9 C-4 收尾）：动态插一个 <base> 改不了文档基地址——同步读、插完立刻摘掉，无副作用。
        const baseBefore = document.baseURI;
        const baseTag = document.createElement('base');
        baseTag.href = 'https://example.invalid/csp-probe/';
        document.head.appendChild(baseTag);
        const baseAfter = document.baseURI;
        baseTag.remove();
        const baseRestored = document.baseURI === baseBefore;
        return JSON.stringify({ meta: meta ? meta.getAttribute('content') : null, inlineRan: window.__cwCspInlineRan === true, violation, evalError, baseBefore, baseAfter, baseRestored });
      })()`
    )
  );
  check(
    '安全开关：页面带着 CSP（default-src / script-src / style-src 只认 self，connect-src 只为字体多 data:）',
    typeof cspProbe.meta === 'string' &&
      cspProbe.meta.includes("default-src 'self'") &&
      cspProbe.meta.includes("script-src 'self'") &&
      cspProbe.meta.includes("connect-src 'self' data:") &&
      !/unsafe-|https?:|ws:|\*/i.test(cspProbe.meta),
    cspProbe.meta
  );
  check(
    '安全开关：CSP 真的拦下内联脚本（没执行，且收到 script-src 违规事件）',
    cspProbe.inlineRan === false &&
      Boolean(cspProbe.violation) &&
      /^script-src/.test(cspProbe.violation.directive),
    cspProbe
  );
  check(
    '安全开关：CSP 拦下 eval / new Function（script-src 没有 unsafe-eval）',
    cspProbe.evalError === 'EvalError',
    cspProbe.evalError
  );
  check(
    "安全开关：CSP 再收紧（object-src / base-uri / frame-src 一律 'none'）",
    typeof cspProbe.meta === 'string' &&
      cspProbe.meta.includes("object-src 'none'") &&
      cspProbe.meta.includes("base-uri 'none'") &&
      cspProbe.meta.includes("frame-src 'none'"),
    cspProbe.meta
  );
  check(
    '安全开关：base-uri 真的生效（动态插入 <base> 改不了文档基地址）',
    cspProbe.baseRestored === true && cspProbe.baseAfter === cspProbe.baseBefore,
    { before: cspProbe.baseBefore, after: cspProbe.baseAfter, restored: cspProbe.baseRestored }
  );
  check(
    "安全开关：CSP 也带 form-action 'none'（页面没有 <form>，零行为变化的纯兜底）",
    typeof cspProbe.meta === 'string' && cspProbe.meta.includes("form-action 'none'"),
    cspProbe.meta
  );
  const secProbe = securityProbe();
  check(
    '安全开关：权限请求处理器一律 callback(false)',
    secProbe.request.callbackCalled === true && secProbe.request.granted === false,
    secProbe.request
  );
  check('安全开关：权限检查处理器一律返回 false', secProbe.check === false, secProbe.check);
  const denialText = JSON.stringify(secProbe.lastDenial || null);
  check(
    '安全开关：被拒权限的日志字段不含本机路径（来源只剩 file://）',
    Boolean(secProbe.lastDenial) &&
      secProbe.lastDenial.permission === 'geolocation' &&
      secProbe.lastDenial.origin === 'file://' &&
      secProbe.lastDenial.denied === true &&
      !denialText.includes('fake') &&
      !denialText.includes('C:'),
    secProbe.lastDenial
  );
  const permQuery = JSON.parse(
    await exec(
      `(async () => { try { const status = await navigator.permissions.query({ name: 'geolocation' }); return JSON.stringify({ ok: true, state: status.state }); } catch (err) { return JSON.stringify({ ok: false, error: String(err && err.name) }); } })()`
    )
  );
  check(
    '安全开关：Chromium 的权限查询也是 denied（Permissions API 走同一套处理器）',
    permQuery.ok === true && permQuery.state === 'denied',
    permQuery
  );
  // 单实例锁：用同一份 userData 再启动一个进程 —— 它拿不到锁、立刻退出，本进程不多开窗口。
  // 万一锁失效，子进程会走 --screenshot 流程并打印「[screenshot]」，用它兜底判定（不会真的把
  // 第二个 E2E 场景跑起来，也就不会两边抢同一个临时书库）。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  const secondInstance = spawn(
    process.execPath,
    [
      appRoot,
      `--user-data=${userData}`,
      `--books-root=${booksRoot}`,
      `--screenshot=${path.join(userData, 'single-instance-probe.png')}`
    ],
    { cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  let secondStdout = '';
  secondInstance.stdout.on('data', (chunk) => {
    secondStdout += chunk.toString();
  });
  const secondExit = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        secondInstance.kill();
      } catch {
        /* 已经退了 */
      }
      finish({ timedOut: true, code: null, stdout: secondStdout });
    }, 30000);
    secondInstance.on('close', (code) => finish({ timedOut: false, code, stdout: secondStdout }));
    secondInstance.on('error', (err) =>
      finish({ error: String(err && err.message), stdout: secondStdout })
    );
  });
  check(
    '安全开关：再启动一个实例会立刻退出（单实例锁生效，没有真的再开一个窗口）',
    secondExit.timedOut === false &&
      secondExit.code === 0 &&
      !secondExit.error &&
      !secondStdout.includes('[screenshot]') &&
      !secondStdout.includes('E2E_RESULT'),
    { ...secondExit, stdout: secondStdout.slice(0, 200) }
  );
  check(
    '安全开关：第二个实例没有多开窗口 / 没有动窗口登记',
    liveWindowCount() === windowsBeforeOpen && registryCounts().windows === windowsBeforeOpen,
    { windows: registryCounts() }
  );
  await ensureWindowFocus();
};
