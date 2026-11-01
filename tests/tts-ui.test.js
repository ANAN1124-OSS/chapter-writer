const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ttsUi = require('../renderer/tts-ui');

// v0.9 B-6：朗读的播放状态机 / 朗读条从 renderer.js 整段搬到 renderer/tts-ui.js。
// 搬之前这一域只有 E2E 第 49 组（真实 Electron + 假语音引擎）覆盖，状态机在 Node 里一步都测不到；
// 搬出来以后用「假 host + 假引擎」把状态机、光标起点、步进边界、文案逐字钉住。
// 两组静态闸门保证「渲染层不许再长出第二份」「index.html 的加载顺序不许反」。

// 语音下拉要 document.createElement('option')：Node 里给一个最小替身（模块自己不在顶层碰 DOM）。
const realDocument = globalThis.document;
globalThis.document = {
  createElement: (tag) => ({ tag, value: '', textContent: '' })
};
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'tts-ui.js'), 'utf8');

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    innerHTML: '',
    options: [],
    classList: {
      toggle(name, on) {
        if (on === undefined ? !classes.has(name) : on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) {
      this.options.push(child);
      return child;
    }
  };
}

// 假 host：只实现模块真正用到的 7 样东西（api / $ / call / state / toast / editorEl / scrollCaretIntoView）。
function makeHost(options = {}) {
  const els = new Map();
  const toasts = [];
  const calls = [];
  const scrolls = [];
  const state = {
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    chapters: options.chapters || [{ id: 'c1' }],
    tts: {
      open: false,
      status: 'idle',
      chunks: [],
      index: 0,
      rate: 1,
      voiceURI: '',
      follow: Boolean(options.follow),
      error: '',
      loading: false,
      requestId: 0
    }
  };
  const editorEl = {
    value: options.text === undefined ? '第一段。第二段。第三段。' : options.text,
    selectionStart: options.caret === undefined ? 0 : options.caret,
    selectionEnd: options.caret === undefined ? 0 : options.caret,
    ranges: [],
    setSelectionRange(start, end) {
      this.ranges.push([start, end]);
    }
  };
  const host = {
    api: { ttsChunks: 'tts:chunks' },
    $: (id) => {
      if (options.missingElements && options.missingElements.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    call: async (channel, text, payload) => {
      calls.push({ channel, text, payload });
      return options.callResult === undefined
        ? {
            chunks: [
              { start: 0, end: 4, text: '第一段。', paragraph: 0, line: 0 },
              { start: 4, end: 8, text: '第二段。', paragraph: 1, line: 1 },
              { start: 8, end: 12, text: '第三段。', paragraph: 2, line: 2 }
            ],
            startIndex: 0
          }
        : options.callResult;
    },
    state,
    toast: (message, kind) => toasts.push({ message, kind }),
    editorEl,
    scrollCaretIntoView: (pos) => scrolls.push(pos)
  };
  return { host, state, editorEl, els, toasts, calls, scrolls, get: (id) => host.$(id) };
}

// 假语音引擎：记录念了什么、把 handlers 留下来给测试手动「念完」/「出错」。
function makeEngine() {
  const log = { spoken: [], cancelled: 0, paused: 0, resumed: 0, handlers: null };
  return {
    log,
    available: () => true,
    voices: () => [
      { name: '测试语音 A', lang: 'zh-CN', voiceURI: 'fake-voice-a' },
      { name: '测试语音 B', lang: 'zh-CN', voiceURI: 'fake-voice-b' }
    ],
    speak(request, handlers) {
      log.spoken.push({ ...request });
      log.handlers = handlers;
      if (handlers.start) handlers.start();
      return true;
    },
    pause() {
      log.paused += 1;
    },
    resume() {
      log.resumed += 1;
    },
    cancel() {
      log.cancelled += 1;
    }
  };
}

async function openWith(host, engine, opts = {}) {
  const tts = ttsUi.create(host);
  tts.setSpeechEngine(engine);
  const result = await tts.openTtsBar(opts);
  return { tts, result };
}

test('host 契约：缺一个必需项就抛 TypeError（宁可启动时炸，不要朗读时才 ReferenceError）', () => {
  assert.throws(() => ttsUi.create(), /host/);
  const full = makeHost().host;
  for (const key of ['api', '$', 'call', 'state', 'toast', 'editorEl', 'scrollCaretIntoView']) {
    const partial = { ...full };
    delete partial[key];
    assert.throws(() => ttsUi.create(partial), new RegExp(key), '少 ' + key + ' 没抛错');
  }
  assert.equal(typeof ttsUi.create(full).openTtsBar, 'function');
});

test('语速夹紧：0.5–2 之间；非数字回到 1，0 / 空串 / null 夹到下限 0.5（不是静音，也不是 1）', () => {
  const { host, state } = makeHost();
  const tts = ttsUi.create(host);
  assert.equal(tts.setTtsRate(0.2), 0.5);
  assert.equal(tts.setTtsRate(5), 2);
  assert.equal(tts.setTtsRate('1.5'), 1.5);
  assert.equal(tts.setTtsRate('abc'), 1);
  // Number('') / Number(null) 都是 0 —— 夹到下限 0.5（搬之前就是这个行为，本轮不改语义）
  assert.equal(tts.setTtsRate(''), 0.5);
  assert.equal(tts.setTtsRate(null), 0.5);
  assert.equal(state.tts.rate, 0.5);
});

test('状态文案逐字：error / loading 优先，其余按播放状态给百分比与段号', () => {
  const { host, state } = makeHost();
  const tts = ttsUi.create(host);
  const texts = [];
  const push = () => texts.push(tts.ttsSummaryText().text);

  state.tts.chunks = [];
  state.tts.error = '';
  state.tts.loading = false;
  push(); // 没有正文
  state.tts.loading = true;
  push();
  state.tts.loading = false;
  state.tts.chunks = [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }];
  state.tts.index = 0;
  state.tts.status = 'playing';
  push();
  state.tts.status = 'paused';
  push();
  state.tts.status = 'done';
  push();
  state.tts.status = 'idle';
  push();
  state.tts.error = '系统语音出错（not-allowed）';
  push();
  assert.deepEqual(texts, [
    '本章没有可朗读的正文',
    '正在准备正文…',
    '正在朗读 第 1/4 段 · 25%',
    '已暂停 · 第 1/4 段',
    '已读完（共 4 段）',
    '已停止 · 第 1/4 段',
    '系统语音出错（not-allowed）'
  ]);
});

test('打开朗读条：没打开书 / 没有系统语音时只 toast 一句，不动编辑区', async () => {
  const noBook = makeHost({ bookPath: null });
  const tts1 = ttsUi.create(noBook.host);
  const res1 = await tts1.openTtsBar();
  assert.equal(res1.ok, false);
  assert.deepEqual(noBook.toasts, [{ message: '先打开一本书再朗读', kind: 'warn' }]);
  assert.equal(noBook.state.tts.open, false);

  const noChapter = makeHost({ chapters: [] });
  const res2 = await ttsUi.create(noChapter.host).openTtsBar();
  assert.equal(res2.ok, false);
  assert.equal(noChapter.toasts.length, 1);

  // 引擎说没有系统语音：只 toast，不开朗读条、不发 IPC
  const engine = makeEngine();
  engine.available = () => false;
  const { host: host2, toasts: toasts2, calls: calls2 } = makeHost();
  const tts2 = ttsUi.create(host2);
  tts2.setSpeechEngine(engine);
  const res3 = await tts2.openTtsBar();
  assert.equal(res3.ok, false);
  assert.deepEqual(toasts2, [{ message: '这个运行环境不支持语音朗读（没有系统语音）', kind: 'warn' }]);
  assert.equal(calls2.length, 0);
});

test('光标在全文末尾（刚载入章节的默认位置）→ 按「从头念」传 caret 0；光标在中间 → 传真实位置', async () => {
  const tail = makeHost({ text: '第一段。第二段。', caret: 9 });
  const a = await openWith(tail.host, makeEngine());
  assert.deepEqual(tail.calls[0].payload, { caret: 0 });
  assert.equal(a.result.ok, true);

  const middle = makeHost({ text: '第一段。第二段。', caret: 3 });
  await openWith(middle.host, makeEngine());
  assert.deepEqual(middle.calls[0].payload, { caret: 3 });

  // 有选区（未折叠）时也按光标位置算，不看结尾
  const selected = makeHost({ text: '第一段。第二段。', caret: 2 });
  selected.editorEl.selectionEnd = 7;
  await openWith(selected.host, makeEngine());
  assert.deepEqual(selected.calls[0].payload, { caret: 2 });
});

test('打开成功：状态 playing、按钮变「暂停」、念的是当前段；念完自动接下一段，最后一段念完变已读完', async () => {
  const { host, state, editorEl, get } = makeHost({ follow: true });
  const engine = makeEngine();
  const { tts, result } = await openWith(host, engine);

  assert.equal(result.ok, true);
  assert.deepEqual({ chunks: result.chunks, index: result.index }, { chunks: 3, index: 0 });
  assert.equal(state.tts.status, 'playing');
  assert.equal(get('btn-tts-play').textContent, '⏸ 暂停');
  assert.equal(get('btn-tts-prev').disabled, true); // 第一段不能再上一段
  assert.equal(get('btn-tts-next').disabled, false);
  assert.equal(get('tts-status').textContent, '正在朗读 第 1/3 段 · 33%');
  assert.equal(get('tts-preview').textContent, '第一段。');
  assert.deepEqual(engine.log.spoken.map((item) => item.text), ['第一段。']);
  // 跟随高亮：只改选区 + 滚动，不改文字、不 focus
  assert.deepEqual(editorEl.ranges, [[0, 4]]);
  assert.equal(editorEl.value, '第一段。第二段。第三段。');

  engine.log.handlers.end();
  assert.equal(state.tts.index, 1);
  assert.deepEqual(engine.log.spoken.map((item) => item.text), ['第一段。', '第二段。']);

  engine.log.handlers.end();
  engine.log.handlers.end();
  assert.equal(state.tts.status, 'done');
  assert.equal(state.tts.index, 2);
  assert.equal(get('tts-status').textContent, '已读完（共 3 段）');
});

test('暂停 / 继续：调引擎 pause / resume，状态与按钮跟着变', async () => {
  const { host, state, get } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'pause' });
  assert.equal(state.tts.status, 'paused');
  assert.equal(engine.log.paused, 1);
  assert.equal(get('btn-tts-play').textContent, '▶ 播放');
  assert.equal(get('tts-status').textContent, '已暂停 · 第 1/3 段');

  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'resume' });
  assert.equal(state.tts.status, 'playing');
  assert.equal(engine.log.resumed, 1);
  assert.equal(get('btn-tts-play').textContent, '⏸ 暂停');
});

test('步进：夹在第 1–N 段之间；播放中换段会重念，停止状态只切预览不改引擎', async () => {
  const { host, state, get } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  assert.deepEqual(tts.ttsStep(-1), { ok: true, index: 0 }); // 已在第一段，夹住
  assert.deepEqual(tts.ttsStep(1), { ok: true, index: 1 });
  assert.equal(engine.log.spoken.at(-1).text, '第二段。');
  assert.deepEqual(tts.ttsStep(99), { ok: true, index: 2 }); // 已到最后一段，夹住
  assert.equal(get('btn-tts-next').disabled, true);

  tts.stopTts();
  assert.equal(state.tts.status, 'idle');
  const spokenBefore = engine.log.spoken.length;
  assert.deepEqual(tts.ttsStep(-1), { ok: true, index: 1 });
  assert.equal(engine.log.spoken.length, spokenBefore); // 停止状态只切预览
  assert.equal(get('tts-preview').textContent, '第二段。');
});

test('停止 / 收起 / 切章：清错误与状态，切章还会 toast 一句', async () => {
  const { host, state, toasts } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  tts.stopTts({ error: '系统语音出错（未知原因）' });
  assert.equal(state.tts.status, 'error');
  assert.equal(state.tts.error, '系统语音出错（未知原因）');
  assert.equal(tts.ttsSummaryText().error, true);

  tts.closeTtsBar();
  assert.equal(state.tts.open, false);
  assert.equal(state.tts.status, 'idle');

  state.tts.open = true;
  state.tts.chunks = [{ text: 'a', start: 0, end: 1 }];
  tts.stopTtsForChapterChange();
  assert.equal(state.tts.open, false);
  assert.deepEqual(toasts.at(-1), { message: '已切换章节，朗读已停止', kind: undefined });
  // 已经收起来、也没有段落时再切章不再重复提示（判空条件 = 两条都成立）
  const toastCount = toasts.length;
  state.tts.chunks = [];
  tts.stopTtsForChapterChange();
  assert.equal(toasts.length, toastCount);
});

test('换引擎：setSpeechEngine 换进来 / 传空换回真实引擎；语音下拉按引擎给的列表重建', async () => {
  const { host, get } = makeHost();
  const tts = ttsUi.create(host);
  const engine = makeEngine();
  assert.equal(tts.setSpeechEngine(engine), engine);
  assert.equal(tts.speechEngine(), engine);
  const real = tts.setSpeechEngine(null);
  assert.notEqual(real, engine);
  assert.equal(tts.speechEngine(), real);
  tts.setSpeechEngine(engine);

  const select = get('tts-voice');
  tts.renderTtsVoices();
  assert.equal(select.options.length, 3); // 系统默认 + 两个假语音
  assert.equal(select.options[0].textContent, '系统默认');
  assert.equal(select.options[1].value, 'fake-voice-a');
  assert.equal(select.options[2].textContent, '测试语音 B（zh-CN）');
  assert.equal(select.value, '');
  assert.equal(select.disabled, false);
});

test('静态闸门：renderer.js 不再内嵌朗读状态机，只剩接线与假引擎', () => {
  for (const name of ['openTtsBar', 'renderTtsBar', 'ttsSummaryText', 'realSpeechEngine', 'speakTtsChunk']) {
    assert.ok(
      !new RegExp('^  (?:async )?function ' + name + '\\b|^  const ' + name + ' =', 'm').test(rendererSrc),
      'renderer.js 里又有 ' + name + ' 的第二份实现'
    );
  }
  assert.match(rendererSrc, /ttsUi\.create\(\{ api, \$, call, state, toast, editorEl, scrollCaretIntoView \}\)/);
  // 假引擎（?test=1 的调试通道）留在渲染层，且必须真的换进模块
  assert.match(rendererSrc, /function installFakeSpeech\(\)/);
  assert.match(rendererSrc, /tts\.setSpeechEngine\(/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 tts-ui.js，且模块自己是干净的', () => {
  const ttsIdx = indexSrc.indexOf('src="tts-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(ttsIdx > 0, 'index.html 没有加载 tts-ui.js');
  assert.ok(ttsIdx < rendererIdx, 'tts-ui.js 必须排在 renderer.js 之前');
  assert.ok(!/\brequire\s*\(/.test(moduleSrc), 'tts-ui.js 不许 require');
  assert.ok(!/window\.cwApi|\bipcRenderer\b|node:fs/.test(moduleSrc), 'tts-ui.js 不许自己摸 Electron / 文件系统');
  // 模块顶层（2 空格缩进的语句）不许直接查 DOM（Node 里 require 成功已经证明「加载时不碰 DOM」）
  assert.ok(!/^  \$\(/m.test(moduleSrc), '模块顶层不许直接查 DOM');
});
