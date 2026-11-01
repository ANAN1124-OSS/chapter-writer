// E2E 第 62 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group62CommonTools(t) {
  const { exec, check } = t;

  // 62. 公共小工具收编（v0.9 B-3，代码精简 B3）：
  //     pad2 / clampInt / sleep 收到 core/common.js 之后，真实渲染层的加载顺序不能断
  //     （index.html 里 core/common.js 必须排在 template / editor-logic / find-logic / renderer.js 之前）。
  const b3Common = await exec(
    '({ type: typeof window.CWCommon, pad2: window.CWCommon ? window.CWCommon.pad2(7) : null, clampInt: window.CWCommon ? window.CWCommon.clampInt(999, 0, [0, 100]) : null, sleep: window.CWCommon ? typeof window.CWCommon.sleep : null })'
  );
  check(
    '公共小工具：渲染层真的加载了 core/common.js（pad2 / clampInt / sleep 三个都在）',
    b3Common && b3Common.type === 'object' && b3Common.pad2 === '07' && b3Common.clampInt === 100 && b3Common.sleep === 'function',
    b3Common
  );
  const b3Chain = await exec(
    '({ template: typeof window.CWTemplate, date: window.CWTemplate ? window.CWTemplate.localDateKey(new Date(2026, 0, 5)) : null, stopwatch: window.CWEditorLogic ? window.CWEditorLogic.formatStopwatch(65) : null, threshold: window.CWEditorLogic ? window.CWEditorLogic.sanitizeThreshold(1) : null, maxItems: window.CWFindLogic ? window.CWFindLogic.highlightWindow([{ index: 0, length: 1 }], 0, { max: 999999 }).maxItems : null })'
  );
  check(
    '公共小工具：template / editor-logic / find-logic 都接上了共享实现（浏览器加载链没断）',
    b3Chain && b3Chain.template === 'object' && b3Chain.date === '2026-01-05' && b3Chain.stopwatch === '1:05' && b3Chain.threshold === 50 && b3Chain.maxItems === 2000,
    b3Chain
  );
};
