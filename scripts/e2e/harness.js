// E2E 公共工具（v0.9 B-7 拆组时从 scripts/e2e-scenario.js 抽出来的）。
//
// 为什么单独一个文件：以前 check / waitFor / 删书重试 / 读日志这些工具都长在场景那个
// 1.2 万行的巨型函数里，按组拆到 scripts/e2e/groups/*.js 之后每一组都要用同一份，
// 不能各写一套（否则「超时带现场」「删书重试 10 次」这类口径会慢慢分叉）。
//
// 边界：只给 E2E 用（scripts/ 不进安装包，见 package.json 的 build.files），
// 这里不 require 任何产品代码；等待 / 重试的次数与拆分前逐字相同——拆分不改断言。
const fs = require('node:fs/promises');
const path = require('node:path');

// ctx 就是 e2e-scenario.js 拿到的那个 ctx（主进程侧注入的执行 / 存储 / 临时 userData）。
function createHarness(ctx) {
  const { exec, sleep, userData } = ctx;
  // 全部断言的结果（e2e-scenario.js 最后原样交回主进程，按条打印 PASS / FAIL）
  const checks = [];

  const check = (name, cond, detail) => {
    checks.push({ name, ok: Boolean(cond) });
    if (!cond) {
      throw new Error(`检查失败：${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    }
  };

  const waitFor = async (expr, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await exec(expr);
      } catch { /* 页面切换间隙可能短暂失败 */ }
      if (value) return value;
      if (Date.now() - startedAt > timeout) {
        // 超时带上一点现场（2026-11-01 v0.9 R0）：键盘 / 焦点类断言偶尔受窗口系统焦点影响，
        // 只记 activeElement 与 document.hasFocus()，方便下次偶发失败时定位，不做任何补救动作。
        let diag = '';
        try {
          diag = await exec(
            'JSON.stringify({ activeId: document.activeElement && document.activeElement.id, hasFocus: document.hasFocus() })'
          );
        } catch { /* 页面刚好在切换，忽略 */ }
        throw new Error(`等待超时：${expr}${diag ? `（现场：${diag}）` : ''}`);
      }
      await sleep(120);
    }
  };

  const logDir = path.join(userData, 'logs');
  const logNamePattern = /^chapter-writer-\d{4}-\d{2}-\d{2}(\.\d{1,3})?\.log$/;
  const readLogs = async () => {
    let names = [];
    try {
      names = await fs.readdir(logDir);
    } catch {
      return { names: [], text: '' };
    }
    const logs = names.filter((name) => logNamePattern.test(name)).sort();
    let text = '';
    for (const name of logs) {
      try {
        text += await fs.readFile(path.join(logDir, name), 'utf8');
      } catch {
        /* 正在滚动 / 被占用：下一轮再读 */
      }
    }
    return { names, text };
  };
  const waitForLog = async (needle, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      const { text } = await readLogs();
      if (text.includes(needle)) return text;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待日志超时：${needle} :: ${text.slice(-800)}`);
      }
      await sleep(120);
    }
  };

  const deleteBookWithRetry = async (bookPath, attempts = 10) => {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      last = JSON.parse(
        await exec(`window.api.deleteBook(${JSON.stringify(bookPath)}).then((r) => JSON.stringify(r))`)
      );
      if (last && last.ok === true) return last;
      await sleep(200);
    }
    return last;
  };

  return { checks, check, waitFor, readLogs, waitForLog, deleteBookWithRetry, logDir, logNamePattern };
}

module.exports = { createHarness };
