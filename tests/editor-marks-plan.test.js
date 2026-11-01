/* 编辑器标记层「节点计划」（v0.9 A-3，编辑器手感 A3）的自检
 *
 * 这一轮只做一件低风险的事：影子层 #editor-marks 不再「一行一个 <span class="marks-line">」。
 * 逐行 span 只是 .long-para / .caret-para 的锚点，干净行根本不需要；而 10 万字 / 约 1500 行时
 * 那 1500 个行内盒占了整层重建成本的一大半（基准：一次整层重画 14.0ms → 8.7ms，单文本节点的
 * 布局下限是 6.5ms）。切法抽成纯逻辑 editorLogic.marksPlan()，渲染层只按计划建节点。
 *
 * 因此这里的闸门分两类：
 * - 纯逻辑（marksPlan）：干净行必须合并成文本节点、需要样式的行才单独成 span、标记按行裁剪并
 *   换算成本行内偏移、**拼回正文逐字等于原文**（这条不变量最重要：影子层只要差一个字，
 *   标记位置就会整段错位）。
 * - 静态闸门（行为在 E2E 第 65 组里真跑）：renderEditorMarks 必须走 marksPlan、不许再自己
 *   split('\n') 逐行建 span；光标移到「没有 span 的干净行」时必须能整层重建补上 span；
 *   拼字（IME）过程中不许重画。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const editorLogic = require('../renderer/editor-logic.js');
const RENDERER_SOURCE = read('renderer/renderer.js');

/** 去掉注释（保留字符串）：静态闸门要看代码本身，不能被说明文字误导 */
function stripComments(src) {
  let out = '';
  let mode = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === '//') {
      if (ch === '\n') {
        mode = null;
        out += ch;
      }
      continue;
    }
    if (mode === '/*') {
      if (ch === '*' && next === '/') {
        mode = null;
        i += 1;
      }
      continue;
    }
    if (mode) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] || '';
        i += 1;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = '//';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = '/*';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') mode = ch;
    out += ch;
  }
  return out;
}

/** 取一个顶层 function 的源码：从 `function 名字(` 到下一个同缩进的 function 声明为止 */
function functionSource(src, name) {
  const pattern = new RegExp(`(?:^|\\n)  (?:async )?function ${name}\\(`);
  const match = pattern.exec(src);
  assert.ok(match, `renderer.js 里找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const rest = src.slice(start + 1);
  const next = /\n  (?:async )?function [A-Za-z_$][\w$]*\(/.exec(rest);
  return next ? src.slice(start, start + 1 + next.index) : src.slice(start);
}

const textOf = (plan) => plan.map((item) => item.text).join('');
const lineSegments = (plan) => plan.filter((item) => item.kind === 'line');

test('marksPlan：干净正文只出一个文本节点（不再一行一个 span）', () => {
  const text = '第一段\n第二段\n第三段';
  const plan = editorLogic.marksPlan(text, {});
  assert.strictEqual(plan.length, 1, `干净正文应当只有 1 个节点计划，实际 ${plan.length}`);
  assert.deepStrictEqual(plan[0], { kind: 'text', text });
  assert.deepStrictEqual(lineSegments(plan), [], '没有标记 / 超长段 / 光标行时不该有行 span');
});

test('marksPlan：1500 行的干净长正文 → 1 个文本节点、0 个行 span（大章省的就是这个）', () => {
  const lines = [];
  for (let i = 0; i < 1500; i += 1) lines.push(`第${i + 1}段：这是一行普通的正文，长度和日常章节差不多。`);
  const text = lines.join('\n');
  const plan = editorLogic.marksPlan(text, { caretLine: 0, marks: [] });
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(lineSegments(plan).length, 0);
  assert.strictEqual(textOf(plan), text);
});

test('marksPlan：当前段落高亮那一行单独成 span，其余行仍合并', () => {
  const text = '第一段\n第二段\n第三段';
  const plan = editorLogic.marksPlan(text, { caretLine: 2 });
  const spans = lineSegments(plan);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].line, 2);
  assert.strictEqual(spans[0].caret, true);
  assert.strictEqual(spans[0].long, false);
  assert.deepStrictEqual(spans[0].marks, []);
  assert.strictEqual(textOf(plan), text);
  // 前后两段还是文本节点（合并成一个）
  const texts = plan.filter((item) => item.kind === 'text');
  assert.deepStrictEqual(texts.map((item) => item.text), ['第一段\n', '\n第三段']);
});

test('marksPlan：超长段落那一行单独成 span 并带 long 标记', () => {
  const text = '短段\n' + '长'.repeat(600) + '\n短段';
  const plan = editorLogic.marksPlan(text, { longLines: new Set([2]) });
  const spans = lineSegments(plan);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].line, 2);
  assert.strictEqual(spans[0].long, true);
  assert.strictEqual(spans[0].caret, false);
  assert.strictEqual(textOf(plan), text);
});

test('marksPlan：不可见字符标记按行裁剪，offsets 换成本行内偏移', () => {
  // 第 2 行：行首全角空格（下标 3）、行尾空白（下标 8..10）
  const text = 'abc\n\u3000def  \nghi';
  const first = 4; // 第 2 行起点（"abc\n" 是 4 个字符）
  const marks = [
    { type: 'fullwidth', start: first, end: first + 1 },
    { type: 'trailing', start: first + 4, end: first + 6 }
  ];
  const plan = editorLogic.marksPlan(text, { marks });
  const spans = lineSegments(plan);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].line, 2);
  assert.strictEqual(spans[0].text, '\u3000def  ');
  assert.deepStrictEqual(spans[0].marks, [
    { type: 'fullwidth', start: 0, end: 1 },
    { type: 'trailing', start: 4, end: 6 }
  ]);
  assert.strictEqual(textOf(plan), text);
});

test('marksPlan：跨行的标记（理论情况）按行拆开，每行只拿自己那一段', () => {
  const text = 'abc\ndef';
  const plan = editorLogic.marksPlan(text, { marks: [{ type: 'trailing', start: 2, end: 5 }] });
  const spans = lineSegments(plan);
  assert.strictEqual(spans.length, 2);
  assert.deepStrictEqual(spans[0].marks, [{ type: 'trailing', start: 2, end: 3 }]);
  assert.deepStrictEqual(spans[1].marks, [{ type: 'trailing', start: 0, end: 1 }]);
  assert.strictEqual(textOf(plan), text);
});

test('marksPlan：标记正好在行首 / 行尾边界（不越到相邻行）', () => {
  const text = 'ab\ncd';
  const plan = editorLogic.marksPlan(text, {
    marks: [
      { type: 'fullwidth', start: 0, end: 2 }, // 第 1 行整行
      { type: 'fullwidth', start: 3, end: 5 } // 第 2 行整行
    ]
  });
  const spans = lineSegments(plan);
  assert.strictEqual(spans.length, 2);
  assert.deepStrictEqual(spans[0].marks, [{ type: 'fullwidth', start: 0, end: 2 }]);
  assert.deepStrictEqual(spans[1].marks, [{ type: 'fullwidth', start: 0, end: 2 }]);
  assert.strictEqual(textOf(plan), text);
});

test('marksPlan：空行 / 纯空白行 / 空正文都不丢换行，拼回原文逐字一致', () => {
  const cases = ['', '\n', '\n\n\n', 'a\n\nb\n', '\n开头空行\n\n中间空行\n', '   \n\t\n  '];
  for (const text of cases) {
    const plan = editorLogic.marksPlan(text, { caretLine: 1, longLines: new Set([1, 2]) });
    assert.strictEqual(textOf(plan), text, `拼回后与原文不一致：${JSON.stringify(text)}`);
  }
});

test('marksPlan：拼回正文恒等于原文（含标记 / 超长段 / 光标行混合）', () => {
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 7 === 0) lines.push('');
    else if (i % 5 === 0) lines.push(`段落${i}\u3000带全角空格  `);
    else lines.push(`段落${i}：普通正文一行。`);
  }
  const text = lines.join('\n');
  // 每行都造一批标记：全角空格 / 行尾空白各一个（位置从行起点算）
  const marks = [];
  let start = 0;
  for (const line of lines) {
    const fw = line.indexOf('\u3000');
    if (fw >= 0) marks.push({ type: 'fullwidth', start: start + fw, end: start + fw + 1 });
    const trail = / +$/.exec(line);
    if (trail) marks.push({ type: 'trailing', start: start + trail.index, end: line.length });
    start += line.length + 1;
  }
  const plan = editorLogic.marksPlan(text, {
    longLines: new Set([3, 9]),
    caretLine: 11,
    marks
  });
  assert.strictEqual(textOf(plan), text);
  const spans = lineSegments(plan);
  // 只有「超长段 2 行 + 光标 1 行 + 带标记的行」才是 span，远少于 40 行
  const markedLines = new Set(marks.map((item) => text.slice(0, item.start).split('\n').length));
  assert.strictEqual(spans.length, new Set([3, 9, 11, ...markedLines]).size);
  for (const span of spans) {
    assert.strictEqual(span.text, lines[span.line - 1], `第 ${span.line} 行的正文切片不对`);
    assert.strictEqual(span.caret, span.line === 11);
    assert.strictEqual(span.long, span.line === 3 || span.line === 9);
  }
});

test('marksPlan：参数缺失 / 坏形状不崩（按干净正文处理）', () => {
  assert.deepStrictEqual(editorLogic.marksPlan('abc').map((item) => item.text), ['abc']);
  assert.strictEqual(textOf(editorLogic.marksPlan('abc', { longLines: 'x', marks: 'y', caretLine: 'z' })), 'abc');
  assert.deepStrictEqual(editorLogic.marksPlan(null, {}), []);
  assert.deepStrictEqual(editorLogic.marksPlan(undefined), []);
});

test('静态闸门：renderEditorMarks 走 marksPlan，不再自己逐行建 span', () => {
  const code = stripComments(RENDERER_SOURCE);
  const renderSrc = functionSource(code, 'renderEditorMarks');
  assert.match(renderSrc, /editorLogic\.marksPlan\(/, 'renderEditorMarks 必须按 marksPlan 建节点');
  assert.doesNotMatch(renderSrc, /text\.split\('\\n'\)/, 'renderEditorMarks 不许再自己 split(换行) 逐行建 span');
  assert.match(renderSrc, /segment\.kind === 'text'/, '文本段要直接建文本节点');
  assert.match(renderSrc, /'marks-line'/, '需要样式的行仍然要有 .marks-line span（E2E / 其它逻辑按它定位）');
});

test('静态闸门：光标移到没有 span 的干净行时能整层重建补上高亮', () => {
  const code = stripComments(RENDERER_SOURCE);
  const updateSrc = functionSource(code, 'updateCaretParagraph');
  assert.match(updateSrc, /marks-line\[data-line=/, '先找现成的行 span');
  assert.match(updateSrc, /renderEditorMarks\(\)/, '找不到 span 时必须整层重建（否则高亮会静默消失）');
  assert.match(updateSrc, /state\.marks\.composing/, '拼字（IME）过程中不许重画');
  // 重建必须发生在「摘掉旧高亮 + 记录新行号」之后，否则重建出来的仍是旧行
  const removeAt = updateSrc.indexOf("previous.classList.remove('caret-para')");
  const rebuildAt = updateSrc.indexOf('renderEditorMarks()');
  assert.ok(removeAt > 0 && rebuildAt > removeAt, '顺序：先摘旧高亮，再按新行号重建');
});

test('静态闸门：editor-logic 导出 marksPlan（Node 单测与浏览器共用同一份）', () => {
  assert.strictEqual(typeof editorLogic.marksPlan, 'function');
  const logicSrc = stripComments(read('renderer/editor-logic.js'));
  assert.match(logicSrc, /function marksPlan\(/, '纯逻辑模块里要有 marksPlan');
  assert.match(logicSrc, /\n    marksPlan,/, 'marksPlan 要出现在导出列表里');
  // 纯逻辑：不许碰 DOM / 定时器 / 盘
  const planSrc = functionSource(logicSrc, 'marksPlan');
  for (const forbidden of ['document', 'window', 'setTimeout', 'require(', 'fs.']) {
    assert.ok(!planSrc.includes(forbidden), `marksPlan 是纯逻辑，不许出现 ${forbidden}`);
  }
});
