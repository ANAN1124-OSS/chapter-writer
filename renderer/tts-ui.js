/* 朗读（TTS）的播放状态机与朗读条（v0.9 B-6：从 renderer.js 按域整段搬出来）。
 *
 * 为什么搬：renderer.js 已到 9600 行闸门，而这一域「输入输出最清楚」——它只碰
 * state.tts、6 个 DOM 元素、1 个 IPC（tts:chunks），E2E 第 49 组本来就整组覆盖；
 * 搬出来以后播放状态机终于能在 Node 里直接单测（以前只能靠真实 Electron 的假语音引擎）。
 *
 * 契约：createTtsUi(host) 由渲染层调用一次，host 只提供它真正用到的 7 样东西——
 *   host = { api, $, call, state, toast, editorEl, scrollCaretIntoView }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到朗读时才 ReferenceError）。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 计时都照旧）：
 *   - 真实 speechSynthesis 引擎适配（语音列表 / 语速夹紧 / pause / resume / cancel）；
 *   - 朗读条渲染：状态文案、按钮禁用、语速 / 跟随勾选、当前段落预览、语音下拉；
 *   - 播放：从光标处开始（光标在全文末尾时按「从头念」）、一段读完自动接下一段、
 *     停顿后换语速只重念当前段、12 秒无响应的 watchdog；
 *   - 步进 / 暂停 / 继续 / 停止 / 切章自动停 / 跟随高亮（只改选区，不改文字、不 focus）。
 *
 * 红线不变：只说不动 —— 不修改编辑区文字、不写盘、不切章、不改 dirty。
 * 浏览器里挂成全局 CWTtsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 * 「测试专用假语音引擎」留在 renderer.js（那是 ?test=1 的调试通道，不是产品逻辑），
 * 通过 setSpeechEngine() 换进本模块。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWTtsUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['api', '$', 'call', 'state', 'toast', 'editorEl', 'scrollCaretIntoView'];

  function createTtsUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createTtsUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createTtsUi 的 host 缺少 ' + key);
      }
    }
    const { api, $, call, state, toast, editorEl, scrollCaretIntoView } = host;
  // ---------- 朗读（提案 5.3） ----------
  // 用 Electron 自带的 speechSynthesis（Windows 上走本地 SAPI 语音）朗读当前章正文。
  // 原则：只说不动 —— 不修改编辑区、不写盘、不切章、不改 dirty；改字 / 切章 / 收起朗读条立刻停止。
  // 正文怎么切成「一段一段」由主进程 core/tts.js 算（单测覆盖），这里只管按顺序念。
  const realSpeechEngine = {
    available: () =>
      typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined',
    voices: () => {
      try {
        return window.speechSynthesis.getVoices() || [];
      } catch {
        return [];
      }
    },
    speak({ text, rate, voiceURI }, handlers) {
      const utter = new window.SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = ttsClampRate(rate);
      const voice = voiceURI
        ? Array.from(realSpeechEngine.voices()).find((item) => (item.voiceURI || item.name) === voiceURI)
        : null;
      if (voice) {
        utter.voice = voice;
        utter.lang = voice.lang || utter.lang;
      }
      utter.onstart = () => handlers.start && handlers.start();
      utter.onend = () => handlers.end && handlers.end();
      utter.onerror = (event) => handlers.error && handlers.error(event);
      window.speechSynthesis.speak(utter);
      return utter;
    },
    pause() {
      try {
        window.speechSynthesis.pause();
      } catch { /* 没有语音就当已暂停 */ }
    },
    resume() {
      try {
        window.speechSynthesis.resume();
      } catch { /* 没有语音就当已继续 */ }
    },
    cancel() {
      try {
        window.speechSynthesis.cancel();
      } catch { /* 没有语音就当已停止 */ }
    }
  };

  // 测试模式可以把引擎换成假的：E2E 不依赖机器上装没装语音，也绝不会真的出声。
  // 正常使用（没有 ?test=1 的钩子调用）永远是 realSpeechEngine。
  let engine = realSpeechEngine; // 正常使用就是真实 speechSynthesis；?test=1 可换成假引擎
  const speechEngine = () => engine;
  let ttsToken = 0; // 每次发声 +1：cancel 之后迟到的回调一律忽略
  let ttsWatchdog = null;

  function ttsClampRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(2, Math.max(0.5, n));
  }

  function currentTtsChunk() {
    return state.tts.chunks[state.tts.index] || null;
  }

  function ttsSummaryText() {
    const tts = state.tts;
    const total = tts.chunks.length;
    if (tts.error) return { text: tts.error, error: true };
    if (tts.loading) return { text: '正在准备正文…', error: false };
    if (!total) return { text: '本章没有可朗读的正文', error: true };
    const position = `第 ${tts.index + 1}/${total} 段`;
    if (tts.status === 'playing') {
      const percent = Math.round(((tts.index + 1) / total) * 100);
      return { text: `正在朗读 ${position} · ${percent}%`, error: false };
    }
    if (tts.status === 'paused') return { text: `已暂停 · ${position}`, error: false };
    if (tts.status === 'done') return { text: `已读完（共 ${total} 段）`, error: false };
    return { text: `已停止 · ${position}`, error: false };
  }

  function renderTtsBar() {
    const bar = $('tts-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !state.tts.open);
    if (!state.tts.open) return;
    const hasChunks = state.tts.chunks.length > 0;
    const playing = state.tts.status === 'playing';
    $('btn-tts-play').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    $('btn-tts-play').disabled = state.tts.loading || !hasChunks;
    $('btn-tts-stop').disabled = !hasChunks;
    $('btn-tts-prev').disabled = !hasChunks || state.tts.index <= 0;
    $('btn-tts-next').disabled = !hasChunks || state.tts.index >= state.tts.chunks.length - 1;
    $('tts-rate').disabled = !hasChunks;
    $('tts-rate').value = String(state.tts.rate);
    $('tts-follow').checked = state.tts.follow;
    const summary = ttsSummaryText();
    const statusEl = $('tts-status');
    statusEl.textContent = summary.text;
    statusEl.classList.toggle('error', Boolean(summary.error));
    const chunk = currentTtsChunk();
    const preview = $('tts-preview');
    preview.textContent = chunk ? chunk.text.slice(0, 60) + (chunk.text.length > 60 ? '…' : '') : '';
    preview.title = chunk ? chunk.text : '';
  }

  function renderTtsVoices() {
    const select = $('tts-voice');
    if (!select) return;
    const voices = Array.from(speechEngine().voices() || []);
    const wanted = state.tts.voiceURI;
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = voices.length ? '系统默认' : '（系统没有报告语音）';
    select.appendChild(def);
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI || voice.name || '';
      option.textContent = `${voice.name || '语音'}${voice.lang ? `（${voice.lang}）` : ''}`;
      select.appendChild(option);
    }
    if (wanted && voices.some((voice) => (voice.voiceURI || voice.name) === wanted)) {
      select.value = wanted;
    } else {
      select.value = '';
      state.tts.voiceURI = '';
    }
    select.disabled = !voices.length;
  }

  // 跟随高亮：只改编辑区选区，不 focus、不改文字；编辑区有焦点时才看得见高亮
  function selectTtsChunk(index) {
    const chunk = state.tts.chunks[index];
    if (!chunk) return false;
    editorEl.setSelectionRange(chunk.start, chunk.end);
    scrollCaretIntoView(chunk.start);
    return true;
  }

  function clearTtsWatchdog() {
    if (ttsWatchdog) {
      clearTimeout(ttsWatchdog);
      ttsWatchdog = null;
    }
  }

  function stopTtsEngine() {
    clearTtsWatchdog();
    ttsToken += 1;
    try {
      speechEngine().cancel();
    } catch { /* 停不下来也不影响界面状态 */ }
  }

  function stopTts({ error = '', keepOpen = true } = {}) {
    stopTtsEngine();
    state.tts.status = error ? 'error' : 'idle';
    state.tts.error = error;
    if (!keepOpen) state.tts.open = false;
    renderTtsBar();
  }

  function closeTtsBar() {
    if (!state.tts.open && !state.tts.chunks.length) return;
    stopTts({ keepOpen: false });
  }

  function failTts(message) {
    stopTts({ error: message });
    toast(`朗读失败：${message}`, 'error');
  }

  async function openTtsBar({ autoplay = true } = {}) {
    if (!state.bookPath || !state.chapters.length) {
      toast('先打开一本书再朗读', 'warn');
      return { ok: false, message: '没有打开的书' };
    }
    if (!speechEngine().available()) {
      toast('这个运行环境不支持语音朗读（没有系统语音）', 'warn');
      return { ok: false, message: '没有系统语音' };
    }
    // 「从光标处开始念」：刚打开章节时光标停在全文末尾（textarea 的默认行为），
    // 这时按「从头念」处理，免得点开朗读直接从最后一段开始；用户自己把光标放到中间 / 末尾就按光标算。
    const selectionStart = editorEl.selectionStart || 0;
    const collapsed = selectionStart === (editorEl.selectionEnd || 0);
    const atVeryEnd = collapsed && selectionStart >= editorEl.value.length;
    const caret = atVeryEnd ? 0 : selectionStart;
    const requestId = state.tts.requestId + 1;
    state.tts.requestId = requestId;
    stopTtsEngine();
    state.tts.open = true;
    state.tts.loading = true;
    state.tts.status = 'idle';
    state.tts.error = '';
    state.tts.chunks = [];
    state.tts.index = 0;
    renderTtsBar();
    renderTtsVoices();
    let result;
    try {
      result = await call(api.ttsChunks, editorEl.value, { caret });
    } catch (err) {
      if (requestId !== state.tts.requestId) return { ok: false, stale: true };
      state.tts.loading = false;
      state.tts.error = `切分正文失败：${err.message}`;
      renderTtsBar();
      toast(`切分正文失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
    // 等主进程期间可能已经切章 / 收起：结果作废
    if (requestId !== state.tts.requestId || !state.tts.open) return { ok: false, stale: true };
    state.tts.loading = false;
    state.tts.chunks = result.chunks || [];
    state.tts.index = result.startIndex >= 0 ? result.startIndex : 0;
    if (!state.tts.chunks.length) {
      state.tts.status = 'error';
      state.tts.error = '本章没有可朗读的正文';
      renderTtsBar();
      toast('本章没有可朗读的正文', 'warn');
      return { ok: false, message: '没有正文' };
    }
    renderTtsBar();
    if (autoplay) speakTtsChunk();
    return { ok: true, chunks: state.tts.chunks.length, index: state.tts.index };
  }

  function speakTtsChunk() {
    const chunk = currentTtsChunk();
    if (!chunk) return;
    stopTtsEngine(); // 先取消上一段，并让它的回调失效
    state.tts.status = 'playing';
    state.tts.error = '';
    renderTtsBar();
    if (state.tts.follow) selectTtsChunk(state.tts.index);
    const token = ttsToken;
    try {
      speechEngine().speak(
        { text: chunk.text, rate: state.tts.rate, voiceURI: state.tts.voiceURI },
        {
          start: () => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
          },
          end: () => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
            advanceTts(token);
          },
          error: (event) => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
            const code = event && event.error ? String(event.error) : '';
            if (code === 'canceled' || code === 'interrupted') return; // 自己 cancel 的不算失败
            failTts(`系统语音出错（${code || '未知原因'}）`);
          }
        }
      );
    } catch (err) {
      failTts(err.message || '系统语音不可用');
      return;
    }
    if (engine === realSpeechEngine) {
      // 真实语音没有反应（没装语音 / 音频设备不可用）时，别一直显示「朗读中」
      ttsWatchdog = setTimeout(() => {
        if (token !== ttsToken || state.tts.status !== 'playing') return;
        const synth = window.speechSynthesis;
        if (synth && (synth.speaking || synth.pending || synth.paused)) return;
        failTts('系统语音没有响应（可能没有安装语音或音频设备不可用）');
      }, 12000);
    }
  }

  function advanceTts(token) {
    if (token !== ttsToken) return;
    if (state.tts.status !== 'playing') return;
    const next = state.tts.index + 1;
    if (next < state.tts.chunks.length) {
      state.tts.index = next;
      speakTtsChunk();
      return;
    }
    ttsToken += 1;
    state.tts.status = 'done';
    renderTtsBar();
  }

  function toggleTtsPlay() {
    if (!state.tts.open) return { ok: false };
    const status = state.tts.status;
    if (status === 'playing') {
      try {
        speechEngine().pause();
      } catch { /* 当已暂停 */ }
      state.tts.status = 'paused';
      renderTtsBar();
      return { ok: true, action: 'pause' };
    }
    if (status === 'paused') {
      try {
        speechEngine().resume();
      } catch { /* 当已继续 */ }
      state.tts.status = 'playing';
      renderTtsBar();
      return { ok: true, action: 'resume' };
    }
    if (!state.tts.chunks.length) return { ok: false };
    if (status === 'done') state.tts.index = 0;
    speakTtsChunk();
    return { ok: true, action: 'play' };
  }

  function ttsStep(delta) {
    if (!state.tts.open || !state.tts.chunks.length) return { ok: false };
    const next = Math.min(Math.max(0, state.tts.index + delta), state.tts.chunks.length - 1);
    const active = state.tts.status === 'playing' || state.tts.status === 'paused';
    state.tts.index = next;
    if (active) {
      speakTtsChunk();
    } else {
      state.tts.status = 'idle';
      state.tts.error = '';
      renderTtsBar();
      if (state.tts.follow) selectTtsChunk(next);
    }
    return { ok: true, index: next };
  }

  // 语速 / 语音只对「之后发声」的 utterance 生效：正在读的这一段重念一遍
  function setTtsRate(rate) {
    state.tts.rate = ttsClampRate(rate);
    renderTtsBar();
    if (state.tts.status === 'playing' || state.tts.status === 'paused') speakTtsChunk();
    return state.tts.rate;
  }

  function setTtsVoice(voiceURI) {
    state.tts.voiceURI = String(voiceURI || '');
    renderTtsBar();
    if (state.tts.status === 'playing' || state.tts.status === 'paused') speakTtsChunk();
    return state.tts.voiceURI;
  }

  function setTtsFollow(follow) {
    state.tts.follow = Boolean(follow);
    $('tts-follow').checked = state.tts.follow;
    if (state.tts.follow) selectTtsChunk(state.tts.index);
    return state.tts.follow;
  }

  // 切章 / 回书架：正在读的内容已经不是眼前这一章了，立刻停
  function stopTtsForChapterChange() {
    if (!state.tts.open && !state.tts.chunks.length) return;
    closeTtsBar();
    toast('已切换章节，朗读已停止');
  }

    // 渲染层只拿走这些；渲染 / 总结这类内部函数不外露（E2E 用 DOM 断言，不用钩子）。
    return {
      renderTtsBar,
      renderTtsVoices,
      openTtsBar,
      closeTtsBar,
      toggleTtsPlay,
      stopTts,
      ttsStep,
      setTtsRate,
      setTtsVoice,
      setTtsFollow,
      stopTtsForChapterChange,
      ttsSummaryText,
      currentTtsChunk,
      speechEngine,
      // 测试专用：把假语音引擎换进来（null = 换回真实引擎）
      setSpeechEngine(next) {
        engine = next || realSpeechEngine;
        return engine;
      }
    };
  }

  return { create: createTtsUi, REQUIRED_HOST };
});
