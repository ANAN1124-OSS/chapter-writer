const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fontLogic = require('../renderer/font-logic');

// 代码审计 F11：字体 base64 解码改成「优先 fetch(data:font/ttf;base64,…) → arrayBuffer()」，
// 失败回退原来的 atob 循环。这里用假 fetch / 假 atob 锁住两条路径的字节完全一致。

const SAMPLE = Buffer.from('任意二进制\x00\x01\x02字体', 'utf8');
const SAMPLE_BASE64 = SAMPLE.toString('base64');

function fakeFetchFrom(bytes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  };
  return { impl, calls };
}

test('字体解码：优先 fetch(data: URL) → arrayBuffer，字节与 base64 完全一致', async () => {
  const { impl, calls } = fakeFetchFrom(SAMPLE);
  const decoded = await fontLogic.decodeFontBase64(SAMPLE_BASE64, { fetchImpl: impl });
  assert.equal(decoded.mode, 'fetch');
  assert.deepEqual(Buffer.from(decoded.bytes), SAMPLE);
  assert.equal(decoded.bytes.length, SAMPLE.length);
  // data URL 前缀固定是 font/ttf（FontFace 只认字节，MIME 只是标签）
  assert.deepEqual(calls, [`${fontLogic.FONT_DATA_URL_PREFIX}${SAMPLE_BASE64}`]);
  assert.equal(fontLogic.FONT_DATA_URL_PREFIX, 'data:font/ttf;base64,');
});

test('字体解码：fetch 失败时才回退 atob 循环，字节与成功路径一致', async () => {
  const seen = [];
  const atobImpl = (raw) => {
    seen.push(raw);
    return SAMPLE.toString('binary');
  };
  const decoded = await fontLogic.decodeFontBase64(SAMPLE_BASE64, {
    fetchImpl: async () => {
      throw new Error('data: 被拦了');
    },
    atobImpl
  });
  assert.equal(decoded.mode, 'atob');
  assert.deepEqual(Buffer.from(decoded.bytes), SAMPLE);
  assert.deepEqual(seen, [SAMPLE_BASE64]);

  // fetch 返回的不是 Response / arrayBuffer 抛错：同样回退
  for (const broken of [
    async () => null,
    async () => ({ ok: true }),
    async () => ({ arrayBuffer: async () => { throw new Error('坏数据'); } }),
    async () => ({ arrayBuffer: async () => null })
  ]) {
    const fallback = await fontLogic.decodeFontBase64(SAMPLE_BASE64, { fetchImpl: broken, atobImpl });
    assert.equal(fallback.mode, 'atob');
    assert.deepEqual(Buffer.from(fallback.bytes), SAMPLE);
  }
});

test('字体解码：环境里没有 fetch 时也能用（只走 atob）', async () => {
  const originalFetch = globalThis.fetch;
  try {
    delete globalThis.fetch;
    const decoded = await fontLogic.decodeFontBase64(SAMPLE_BASE64);
    assert.equal(decoded.mode, 'atob');
    assert.deepEqual(Buffer.from(decoded.bytes), SAMPLE);
  } finally {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
  }
});

test('字体解码：两条路径都不行时报错，不让空数据静默进 FontFace', async () => {
  const originalFetch = globalThis.fetch;
  const originalAtob = globalThis.atob;
  try {
    delete globalThis.fetch;
    delete globalThis.atob;
    await assert.rejects(() => fontLogic.decodeFontBase64(SAMPLE_BASE64), /不支持解码字体数据/);
  } finally {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    if (originalAtob !== undefined) globalThis.atob = originalAtob;
  }
  // base64 本身非法（atob 抛错）：错误照常抛给调用方（loadCustomFont 会 toast「字体加载失败」）
  await assert.rejects(() =>
    fontLogic.decodeFontBase64('不是 base64!!', {
      fetchImpl: async () => {
        throw new Error('失败');
      }
    })
  );
});

test('字体解码：空数据返回 0 字节（不抛错，交给 FontFace 判定）', async () => {
  const empty = await fontLogic.decodeFontBase64('', { fetchImpl: fakeFetchFrom(Buffer.alloc(0)).impl });
  assert.equal(empty.mode, 'fetch');
  assert.equal(empty.bytes.length, 0);
  const emptyFallback = await fontLogic.decodeFontBase64('', {
    fetchImpl: async () => {
      throw new Error('失败');
    }
  });
  assert.equal(emptyFallback.mode, 'atob');
  assert.equal(emptyFallback.bytes.length, 0);
});

test('字体读取重试：只有「读回来的不是要的那份」才重读（大小写 / 斜杠不敏感）', () => {
  // 同一个路径的不同写法都算同一份
  assert.equal(fontLogic.sameFontPath('C:\\Windows\\Fonts\\consola.ttf', 'c:/windows/fonts/CONSOLA.TTF'), true);
  assert.equal(fontLogic.sameFontPath('D:\\fonts\\A.ttf', 'D:\\fonts\\b.ttf'), false);
  assert.equal(fontLogic.sameFontPath('', ''), false);
  assert.equal(fontLogic.sameFontPath(null, undefined), false);
  // 主进程把「刚选的」路径抢先返回了（不是我们要的配置字体）→ 建议重读一次
  assert.equal(
    fontLogic.shouldRetryFontRead('D:\\fonts\\book.ttf', { path: 'D:\\fonts\\picked.ttf', name: 'picked.ttf' }),
    true
  );
  // 读回的就是要的那份 / 没带路径信息 / 没有结果：不重读（不浪费一趟 IPC）
  assert.equal(
    fontLogic.shouldRetryFontRead('D:\\fonts\\book.ttf', { path: 'd:/fonts/BOOK.ttf', name: 'book.ttf' }),
    false
  );
  assert.equal(fontLogic.shouldRetryFontRead('D:\\fonts\\book.ttf', { name: 'book.ttf' }), false);
  assert.equal(fontLogic.shouldRetryFontRead('D:\\fonts\\book.ttf', null), false);
  assert.equal(fontLogic.shouldRetryFontRead('D:\\fonts\\book.ttf', undefined), false);
});

test('UMD：Node require 与浏览器 window.CWFontLogic 是同一套 API', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'font-logic.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'renderer/font-logic.js' });
  const browserFontLogic = sandbox.CWFontLogic;
  assert.equal(typeof browserFontLogic, 'object');
  assert.equal(typeof browserFontLogic.decodeFontBase64, 'function');
  assert.deepEqual(Object.keys(browserFontLogic).sort(), Object.keys(fontLogic).sort());
  assert.equal(browserFontLogic.FONT_DATA_URL_PREFIX, fontLogic.FONT_DATA_URL_PREFIX);
  // 浏览器分支也能按同样的字节解码（注入假 fetch，避免依赖沙箱里的全局）
  const decoded = await browserFontLogic.decodeFontBase64(SAMPLE_BASE64, { fetchImpl: fakeFetchFrom(SAMPLE).impl });
  assert.equal(decoded.mode, 'fetch');
  assert.deepEqual(Buffer.from(decoded.bytes), SAMPLE);
});
