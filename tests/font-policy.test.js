const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../core/font-policy');

// 代码审计 F1：font:read 不再接受渲染层传的任意路径。
// 主进程只认三种「自己知道的」字体路径：本次窗口刚 pick 的、当前书的 bookDisplay、全局配置。
// 这里锁住「用哪个路径」的优先级与合并规则（跟渲染层 effectiveConfig 的叠加规则必须一致），
// 以及扩展名 / 24MB 上限的判定（主进程真正读盘前用它挡）。

test('字体路径：本次 pick 的路径优先级最高（选中后立刻预览那一趟）', () => {
  const book = { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\book.ttf' };
  const global = { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\global.ttf' };
  assert.deepEqual(policy.resolveFontSource({ picked: 'D:\\fonts\\picked.ttf', book, global }), {
    path: 'D:\\fonts\\picked.ttf',
    source: 'picked'
  });
  // pick 的路径前后空白会被清掉（和配置里的清洗口径一致）
  assert.deepEqual(policy.resolveFontSource({ picked: '  D:\\fonts\\picked.ttf  ', book, global }), {
    path: 'D:\\fonts\\picked.ttf',
    source: 'picked'
  });
  // 非字符串 / 只有空白 = 没有 pick，继续按书 / 全局解析
  assert.equal(policy.resolveFontSource({ picked: 123, book, global }).source, 'book');
  assert.equal(policy.resolveFontSource({ picked: '   ', book, global }).source, 'book');
  assert.equal(policy.resolveFontSource({ picked: null, book, global }).source, 'book');
});

test('字体路径：没有 pick 时按书 -> 全局（和「全局 + 本书覆盖」的合并规则一致）', () => {
  const global = { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\global.ttf' };
  // 本书单独设了自定义字体
  assert.deepEqual(
    policy.resolveFontSource({
      book: { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\book.ttf' },
      global
    }),
    { path: 'D:\\fonts\\book.ttf', source: 'book' }
  );
  // 本书只覆盖了路径、字体档位还是全局的 custom（界面也是这么叠的）
  assert.deepEqual(policy.resolveFontSource({ book: { editorCustomFontPath: 'D:\\fonts\\book.ttf' }, global }), {
    path: 'D:\\fonts\\book.ttf',
    source: 'book'
  });
  // 本书没有覆盖：用全局
  assert.deepEqual(policy.resolveFontSource({ book: {}, global }), {
    path: 'D:\\fonts\\global.ttf',
    source: 'global'
  });
  assert.deepEqual(policy.resolveFontSource({ book: null, global }), {
    path: 'D:\\fonts\\global.ttf',
    source: 'global'
  });
  // 本书显式空路径 = 覆盖成「没有自定义字体」（界面会退回内置宋体，这里也不该去读全局那份）
  assert.deepEqual(policy.resolveFontSource({ book: { editorCustomFontPath: '' }, global }), {
    path: '',
    source: 'none'
  });
});

test('字体路径：只有生效档位是 custom、路径非空才读（否则没有任何可用路径）', () => {
  // 全局是宋体 / 黑体 / 楷体：配置里就算残留路径也不读
  assert.deepEqual(
    policy.resolveFontSource({ global: { editorFont: 'serif', editorCustomFontPath: 'D:\\fonts\\global.ttf' } }),
    { path: '', source: 'none' }
  );
  // 本书把档位改回 serif：全局的 custom 不再生效
  assert.deepEqual(
    policy.resolveFontSource({
      book: { editorFont: 'serif' },
      global: { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\global.ttf' }
    }),
    { path: '', source: 'none' }
  );
  // custom 但没有路径（配置坏了 / 刚清空）：没有可用路径
  assert.deepEqual(policy.resolveFontSource({ global: { editorFont: 'custom', editorCustomFontPath: '' } }), {
    path: '',
    source: 'none'
  });
  // 什么都没有 / 参数不是对象：不报错，返回「没有」
  for (const input of [undefined, null, {}, 'font', 42, []]) {
    assert.deepEqual(policy.resolveFontSource(input), { path: '', source: 'none' });
  }
  assert.deepEqual(policy.effectiveFont(null, null), { font: '', path: '', source: 'global' });
});

test('字体路径：全局 / 本书的坏值不会串进来（只认字符串）', () => {
  assert.deepEqual(policy.effectiveFont({ editorFont: 123, editorCustomFontPath: 456 }, {}), {
    font: '',
    path: '',
    source: 'book'
  });
  assert.deepEqual(
    policy.effectiveFont({}, { editorFont: 'custom', editorCustomFontPath: ' D:\\fonts\\g.ttf ' }),
    { font: 'custom', path: 'D:\\fonts\\g.ttf', source: 'global' }
  );
  // bookDisplay 里的条目按对象处理；数组 / 字符串当作没有覆盖
  assert.equal(policy.effectiveFont([], { editorFont: 'custom', editorCustomFontPath: 'D:\\g.ttf' }).source, 'global');
  assert.equal(policy.effectiveFont('x', { editorFont: 'custom', editorCustomFontPath: 'D:\\g.ttf' }).path, 'D:\\g.ttf');
});

test('字体文件：只认 .ttf / .otf / .ttc（大小写不敏感）', () => {
  assert.equal(policy.isFontFile('C:\\Windows\\Fonts\\consola.ttf'), true);
  assert.equal(policy.isFontFile('C:\\fonts\\MYFONT.TTF'), true);
  assert.equal(policy.isFontFile('D:\\字体\\楷体.otf'), true);
  assert.equal(policy.isFontFile('D:\\字体\\宋体.ttc'), true);
  assert.equal(policy.fontExtension('C:\\fonts\\A.OtF'), '.otf');
  // 其它文件类型 / 没有扩展名 / 坏输入一律不认
  for (const bad of [
    'C:\\Windows\\win.ini',
    'C:\\fonts\\font.woff',
    'C:\\fonts\\font.woff2',
    'C:\\fonts\\font.eot',
    'C:\\fonts\\font',
    '',
    '   ',
    null,
    undefined,
    123,
    {}
  ]) {
    assert.equal(policy.isFontFile(bad), false, `应该拒绝：${String(bad)}`);
  }
  // 扩展名只对字符串有意义：换行 / 空串 / 非字符串一律空串
  assert.equal(policy.fontExtension('C:\\Windows\\win.ini'), '.ini');
  assert.equal(policy.fontExtension('C:\\fonts\\font'), '');
  assert.equal(policy.fontExtension(''), '');
  assert.equal(policy.fontExtension(null), '');
  assert.equal(policy.fontExtension(123), '');
  assert.equal(policy.fontExtension({}), '');
});

test('字体大小：24MB 上限（正好 24MB 仍允许，和改前的>判断一致）', () => {
  assert.equal(policy.FONT_MAX_BYTES, 24 * 1024 * 1024);
  assert.equal(policy.isFontSizeAllowed(0), true);
  assert.equal(policy.isFontSizeAllowed(1024), true);
  assert.equal(policy.isFontSizeAllowed(policy.FONT_MAX_BYTES), true);
  assert.equal(policy.isFontSizeAllowed(policy.FONT_MAX_BYTES + 1), false);
  assert.equal(policy.isFontSizeAllowed(-1), false);
  assert.equal(policy.isFontSizeAllowed(NaN), false);
  assert.equal(policy.isFontSizeAllowed(Infinity), false);
  assert.equal(policy.isFontSizeAllowed('2048'), true);
  assert.equal(policy.isFontSizeAllowed(null), true); // Number(null) === 0：空文件也允许读，交给 FontFace 判
  assert.deepEqual(policy.FONT_EXTS, ['.ttf', '.otf', '.ttc']);
});

test('字体策略是纯逻辑：不碰磁盘 / 全局状态，重复调用结果稳定', () => {
  const input = {
    picked: '',
    book: { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\b.ttf' },
    global: { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\g.ttf' }
  };
  const first = policy.resolveFontSource(input);
  const second = policy.resolveFontSource(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input.book, { editorFont: 'custom', editorCustomFontPath: 'D:\\fonts\\b.ttf' }, '不改调用方对象');
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof policy.isFontFile, 'function');
});
