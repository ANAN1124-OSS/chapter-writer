const test = require('node:test');
const assert = require('node:assert/strict');
const formatUi = require('../renderer/format-ui');
const formatLib = require('../core/format');
const rendererSource = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'renderer', 'format-ui.js'),
  'utf8'
);

test('整理文案：默认规则与 core/format.js 完全一致（两边不许漂移）', () => {
  assert.deepEqual(formatUi.DEFAULT_OPTIONS, formatLib.DEFAULT_OPTIONS);
  assert.deepEqual(formatUi.mergeOptions(null), formatLib.DEFAULT_OPTIONS);
  assert.deepEqual(formatUi.mergeOptions({}), formatLib.DEFAULT_OPTIONS);
  // 模块是 UMD 纯逻辑，不许碰 DOM / 文件系统 / Electron
  assert.equal(/document\.|window\.api|require\(['"]electron/.test(rendererSource), false);
  // 默认规则摘要是固定的一串（顺序也要稳）
  assert.equal(
    formatUi.describeRules(),
    '段首缩进 2 字符 · 段间空一行 · 删行尾空白 · 中文旁标点转全角'
  );
});

test('规则摘要：缩进三挡 + 旧布尔写法、段间四种、四个可选开关按顺序补', () => {
  assert.equal(
    formatUi.describeRules({ indent: '0', blankLines: 'keep', trimTrailing: false, normalizePunct: false }),
    '段首缩进 0 字符 · 段间保持原样'
  );
  assert.equal(formatUi.describeRules({ indent: 'none' }), '缩进不处理 · 段间空一行 · 删行尾空白 · 中文旁标点转全角');
  // 旧配置里的布尔缩进：true = 缩进两格，false = 不处理
  assert.equal(
    formatUi.describeRules({ indent: true, trimTrailing: false, normalizePunct: false }),
    '段首缩进 2 字符 · 段间空一行'
  );
  assert.equal(
    formatUi.describeRules({ indent: false, trimTrailing: false, normalizePunct: false }),
    '缩进不处理 · 段间空一行'
  );
  // 坏值：缩进 / 段间空行都回默认，不抛异常
  assert.equal(
    formatUi.describeRules({ indent: '9', blankLines: 'wat', trimTrailing: false, normalizePunct: false }),
    '缩进不处理 · 段间空一行'
  );
  assert.equal(
    formatUi.describeRules({
      blankLines: 'singleIndent',
      removeCjkSpaces: true,
      curlyQuotes: true,
      ellipsis: true
    }),
    '段首缩进 2 字符 · 段间空一行（含缩进） · 删行尾空白 · 中文旁标点转全角 · 直引号转弯引号 · 省略号转中文 · 删中文间空格'
  );
  assert.equal(formatUi.describeRules({ blankLines: 'none', trimTrailing: false, normalizePunct: false }), '段首缩进 2 字符 · 段间不空行');
  // 不传 / 传坏值都按默认规则讲，不抛
  assert.equal(formatUi.describeRules('bad'), formatUi.describeRules());
});

test('改动统计：五个固定项 + 三个可选项（只在真的改过时出现），坏数字按 0', () => {
  assert.equal(
    formatUi.statsText({
      paragraphs: 12,
      indentFixed: 3,
      trailingTrimmed: 2,
      blankCollapsed: 1,
      punctFixed: 4
    }),
    '共 12 段 · 缩进调整 3 段 · 行尾空白 2 处 · 空行整理 1 处 · 标点转全角 4 处'
  );
  assert.equal(
    formatUi.statsText({
      paragraphs: 3,
      indentFixed: 1,
      trailingTrimmed: 0,
      blankCollapsed: 0,
      punctFixed: 0,
      cjkSpacesRemoved: 5,
      quotesFixed: 2,
      ellipsisFixed: 1
    }),
    '共 3 段 · 缩进调整 1 段 · 行尾空白 0 处 · 空行整理 0 处 · 标点转全角 0 处 · 中文间空格 5 处 · 直引号转弯引号 2 处 · 省略号转中文 1 处'
  );
  // 统计缺字段 / 传坏值：全按 0 讲，不出现 NaN / undefined
  assert.equal(formatUi.statsText(null), '共 0 段 · 缩进调整 0 段 · 行尾空白 0 处 · 空行整理 0 处 · 标点转全角 0 处');
  assert.equal(formatUi.statsText('bad'), formatUi.statsText());
  assert.equal(
    formatUi.statsText({ paragraphs: -3, indentFixed: NaN, trailingTrimmed: 'x', blankCollapsed: 1.9 }),
    '共 0 段 · 缩进调整 0 段 · 行尾空白 0 处 · 空行整理 1 处 · 标点转全角 0 处'
  );
});

test('成功提示：带规则摘要 + 改动统计 + 「仍在编辑区」的保存 / 撤销说明', () => {
  const toast = formatUi.successToast(
    { indent: '2', blankLines: 'single' },
    { paragraphs: 2, indentFixed: 2, trailingTrimmed: 2, blankCollapsed: 1, punctFixed: 2 }
  );
  assert.ok(toast.startsWith('已整理本章（段首缩进 2 字符 · 段间空一行'));
  assert.ok(toast.includes('共 2 段'));
  assert.ok(toast.includes('标点转全角 2 处'));
  assert.ok(toast.includes('仍在编辑区'));
  assert.ok(toast.includes('Ctrl+S 保存'));
  assert.ok(toast.includes('Ctrl+Z 撤销'));
  // 规则是作者自己记住的那套：关掉的开关不能出现在摘要里
  const custom = formatUi.successToast(
    { indent: 'none', blankLines: 'keep', trimTrailing: false, normalizePunct: false },
    { paragraphs: 1 }
  );
  assert.ok(custom.includes('缩进不处理 · 段间保持原样'));
  assert.equal(custom.includes('标点转全角'), true); // 统计里仍有这一项（数值 0）
  assert.equal(custom.includes('删行尾空白'), false);
});

test('无改动提示：说清「已经是整理后的格式，没有可改的地方」并带这次用的规则', () => {
  const toast = formatUi.noChangeToast({ indent: '0', blankLines: 'single' });
  assert.equal(
    toast,
    '本章已经是整理后的格式，没有可改的地方（规则：段首缩进 0 字符 · 段间空一行 · 删行尾空白 · 中文旁标点转全角）'
  );
  assert.equal(
    formatUi.noChangeToast(),
    '本章已经是整理后的格式，没有可改的地方（规则：' + formatUi.describeRules() + '）'
  );
  // 对话框里的预览面板和 toast 用同一句结论，只差句末标点（以前是两种说法）
  assert.equal(formatUi.noChangePanelText(), '本章已经是整理后的格式，没有可改的地方。');
  assert.equal(formatUi.noChangePanelText(), formatUi.NO_CHANGE_TEXT + '。');
  assert.equal(formatUi.noChangeToast({}).startsWith(formatUi.NO_CHANGE_TEXT), true);
});

test('空章提示：toast 与预览面板同一句，只有面板带句号', () => {
  assert.equal(formatUi.EMPTY_TEXT, '本章还没有内容，没什么可整理的');
  assert.equal(formatUi.emptyToast(), formatUi.EMPTY_TEXT);
  assert.equal(formatUi.emptyPanelText(), formatUi.EMPTY_TEXT + '。');
  // 空章和无改动是两件事，别又写成同一句（作者靠这句判断「要不要再点一次整理」）
  assert.notEqual(formatUi.emptyToast(), formatUi.NO_CHANGE_TEXT);
});

test('文案闸门：renderer.js 不许再自己拼这两句（只能从 format-ui.js 拿）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  // 「本章还没有内容」「本章已经是整理后的格式」只允许出现在 format-ui.js 里
  assert.equal(rendererJs.includes('本章还没有内容'), false);
  assert.equal(rendererJs.includes('本章已经是整理后的格式'), false);
  // 三个调用点都要走模块（快速整理 / 对话框套用 / 对话框预览）
  assert.equal(rendererJs.includes('formatUi.emptyToast()'), true);
  assert.equal(rendererJs.includes('formatUi.emptyPanelText()'), true);
  assert.equal(rendererJs.includes('formatUi.noChangePanelText()'), true);
  assert.equal((rendererJs.match(/formatUi\.noChangeToast\(/g) || []).length, 2);
  // 对话框「套用到本章」和点「整理」用同一句成功提示（规则 + 统计 + 仍在编辑区）
  assert.equal((rendererJs.match(/formatUi\.successToast\(/g) || []).length, 2);
});

test('「撤销上次整理」文案：0 步不带数字，正数带「可撤销 N 步」，坏值按 0', () => {
  assert.equal(formatUi.undoLabel(0), '撤销上次整理');
  assert.equal(formatUi.undoLabel(1), '撤销上次整理（可撤销 1 步）');
  assert.equal(formatUi.undoLabel(50), '撤销上次整理（可撤销 50 步）');
  assert.equal(formatUi.undoLabel('3'), '撤销上次整理（可撤销 3 步）');
  assert.equal(formatUi.undoLabel(-5), '撤销上次整理');
  assert.equal(formatUi.undoLabel(NaN), '撤销上次整理');
  assert.equal(formatUi.undoLabel(null), '撤销上次整理');
  assert.equal(formatUi.undoLabel(undefined), '撤销上次整理');
  assert.equal(formatUi.undoLabel(2.9), '撤销上次整理（可撤销 2 步）');
});

test('合并规则：调用方传进来的配置对象不被改写，缺项补默认', () => {
  const raw = { indent: '0' };
  const merged = formatUi.mergeOptions(raw);
  assert.deepEqual(raw, { indent: '0' });
  assert.equal(merged.indent, '0');
  assert.equal(merged.blankLines, 'single');
  assert.equal(merged.trimTrailing, true);
  assert.equal(merged.normalizePunct, true);
  assert.equal(merged.removeCjkSpaces, false);
  assert.equal(merged.curlyQuotes, false);
  assert.equal(merged.ellipsis, false);
  assert.equal(Object.isFrozen(formatUi.DEFAULT_OPTIONS), true);
});
