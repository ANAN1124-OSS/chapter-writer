const test = require('node:test');
const assert = require('node:assert/strict');
const {
  composeBook,
  resolveExportRange,
  exportFileName,
  exportBuffer,
  exportBufferFromText,
  chapterIndexOf,
  chapterRefIndex,
  platformChapterText,
  PLATFORM_FORMAT_OPTIONS,
  resolveExportDir,
  BOM
} = require('../core/exporter');

function metaOf(...names) {
  return {
    title: '测试书',
    titleTemplate: '第{num}章：{name}',
    chapters: names.map((name, i) => ({ id: `ch_${i}`, file: `${i}.txt`, name }))
  };
}

test('整本拼接：标题行 + 空行 + 正文，章间一空行，\\r\\n', () => {
  const meta = metaOf('起风', '夜雨');
  const text = composeBook(meta, ['风从海面吹来。\n', '\n雨下了一夜。\n']);
  assert.equal(
    text,
    '第1章：起风\r\n\r\n风从海面吹来。\r\n\r\n第2章：夜雨\r\n\r\n雨下了一夜。\r\n'
  );
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), '不应出现裸 \\n');
});

test('空章只输出标题行，不留半截格式', () => {
  const meta = metaOf('起风', '', '夜雨');
  const text = composeBook(meta, ['正文', '', '']);
  assert.equal(text, '第1章：起风\r\n\r\n正文\r\n\r\n第2章\r\n\r\n第3章：夜雨\r\n');
});

test('原文自带章节标题的章节导出时原样保留', () => {
  const meta = metaOf('第1章 关于本作品', '第2章');
  const text = composeBook(meta, ['甲', '乙']);
  assert.equal(text, '第1章 关于本作品\r\n\r\n甲\r\n\r\n第2章\r\n\r\n乙\r\n');
});

test('正文首尾多余空行被去掉，中间空行保留', () => {
  const meta = metaOf('起风');
  const text = composeBook(meta, ['\n\n第一段\n\n第二段\n\n']);
  assert.equal(text, '第1章：起风\r\n\r\n第一段\r\n\r\n第二段\r\n');
});

test('导出文件：UTF-8 带 BOM', () => {
  const meta = metaOf('起风');
  const buf = exportBuffer(meta, ['内容']);
  assert.equal(buf[0], 0xef);
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
  assert.equal(buf.toString('utf8'), BOM + composeBook(meta, ['内容']));
});

test('单章也能正确拼接（不依赖章节数）', () => {
  const meta = metaOf('唯一章');
  assert.equal(composeBook(meta, ['内容']), '第1章：唯一章\r\n\r\n内容\r\n');
});

test('导出缓冲可以直接用拼好的文本生成（避免重复拼接）', () => {
  const meta = metaOf('起风');
  const text = composeBook(meta, ['内容']);
  assert.deepEqual(exportBufferFromText(text), exportBuffer(meta, ['内容']));
  assert.equal(exportBufferFromText(text).toString('utf8'), BOM + text);
  assert.equal(exportBufferFromText('').toString('utf8'), BOM);
});

test('当前章覆盖：按 id 找到章节下标', () => {
  const meta = metaOf('起风', '夜雨');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_1', text: '未保存内容' }), 1);
});

test('当前章覆盖：id 对不上时按文件名兜底', () => {
  const meta = metaOf('起风', '夜雨');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_x', chapterFile: '0.txt', text: 'x' }), 0);
});

test('当前章覆盖：匹配不到 / 文本不是字符串时返回 -1（按磁盘内容导出）', () => {
  const meta = metaOf('起风');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_nope', text: 'x' }), -1);
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0', text: null }), -1);
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0' }), -1);
  assert.equal(chapterIndexOf(meta, null), -1);
  assert.equal(chapterIndexOf(null, { chapterId: 'ch_0', text: 'x' }), -1);
});

test('当前章覆盖：空文本也算覆盖（导出成空章而不是旧内容）', () => {
  const meta = metaOf('起风');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0', text: '' }), 0);
});

test('导出目录：记得上次的目录就用上次的', () => {
  assert.equal(resolveExportDir('D:\\xxs', 'C:\\Users\\x\\Documents'), 'D:\\xxs');
});

test('导出目录：没记过就退回默认目录（文档）', () => {
  assert.equal(resolveExportDir('', 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir(undefined, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir(null, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir('   ', 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
});

test('导出目录：上次的目录已经不存在时退回默认目录', () => {
  const exists = (dir) => dir !== 'D:\\删掉了';
  assert.equal(resolveExportDir('D:\\删掉了', 'C:\\Users\\x\\Documents', exists), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir('D:\\还在', 'C:\\Users\\x\\Documents', exists), 'D:\\还在');
});

test('导出目录：不是字符串（配置被手改坏）时退回默认目录', () => {
  assert.equal(resolveExportDir(123, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir({ a: 1 }, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
});

test('章节引用：按 id 找下标，不需要带正文（复制本章用）', () => {
  const meta = metaOf('起风', '夜雨');
  assert.equal(chapterRefIndex(meta, { chapterId: 'ch_1' }), 1);
  assert.equal(chapterRefIndex(meta, { chapterId: 'ch_x', chapterFile: '1.txt' }), 1);
  assert.equal(chapterRefIndex(meta, { chapterId: 'ch_x' }), -1);
  assert.equal(chapterRefIndex(meta, {}), -1);
  assert.equal(chapterRefIndex(meta, null), -1);
  assert.equal(chapterRefIndex(null, { chapterId: 'ch_0' }), -1);
});

test('复制本章：段首缩进两个全角空格、段间空一行（空行里也带缩进），CRLF', () => {
  const result = platformChapterText('风从海面吹来。\n他收起了帆。');
  assert.equal(result.text, '　　风从海面吹来。\r\n　　\r\n　　他收起了帆。\r\n');
  assert.equal(result.empty, false);
  assert.equal(result.paragraphs, 2);
  assert.equal(result.chars, 13);
  assert.ok(!/[^\r]\n/.test(result.text), '不应出现裸 \\n');
});

test('复制本章：已经排好的正文再复制一次结果不变（幂等）', () => {
  const once = platformChapterText('第一段\n\n第二段\n');
  const twice = platformChapterText(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.paragraphs, 2);
});

test('复制本章：原来有几行空行都收成一行（含缩进）', () => {
  const result = platformChapterText('第一段\n\n\n\n第二段');
  assert.equal(result.text, '　　第一段\r\n　　\r\n　　第二段\r\n');
});

test('复制本章：只动排版空白，不转标点 / 引号 / 省略号', () => {
  const source = '他说,"你好..."\n下一段';
  const result = platformChapterText(source);
  assert.ok(result.text.includes('他说,"你好..."'), result.text);
  assert.ok(!result.text.includes('，'), '半角逗号不应被转成全角');
  assert.ok(!result.text.includes('“'), '直引号不应被转成弯引号');
  assert.ok(!result.text.includes('……'), '英文句点不应被转成省略号');
});

test('复制本章：输入 CRLF、开头空行、多余结尾空行都能正常处理', () => {
  const result = platformChapterText('\n\n第一段\r\n第二段\r\n\r\n');
  assert.equal(result.text, '　　第一段\r\n　　\r\n　　第二段\r\n');
});

test('复制本章：空章 / 纯空白章返回空文本（调用方不要覆盖剪贴板）', () => {
  assert.deepEqual(platformChapterText(''), { text: '', paragraphs: 0, chars: 0, empty: true });
  assert.deepEqual(platformChapterText('  \n\u3000\n\t'), {
    text: '',
    paragraphs: 0,
    chars: 0,
    empty: true
  });
  assert.equal(platformChapterText(null).empty, true);
  assert.equal(platformChapterText(undefined).empty, true);
});

test('复制本章：字数和编辑页同一口径（去掉空白/换行，不算标题）', () => {
  const result = platformChapterText('风 从\n海面');
  assert.equal(result.chars, 4);
  assert.ok(!result.text.includes('第1章'), '复制正文不应带章名');
});

test('复制本章的排版规则固定为「缩进两格 + 空一行（含缩进）」，不跟随机型设置', () => {
  assert.equal(PLATFORM_FORMAT_OPTIONS.indent, '2');
  assert.equal(PLATFORM_FORMAT_OPTIONS.blankLines, 'singleIndent');
  assert.equal(PLATFORM_FORMAT_OPTIONS.normalizePunct, false);
  assert.equal(PLATFORM_FORMAT_OPTIONS.curlyQuotes, false);
  assert.equal(PLATFORM_FORMAT_OPTIONS.ellipsis, false);
});

// ---------- 范围 / 分卷导出（v0.5-3） ----------

function volumeMeta() {
  return {
    title: '测试书',
    titleTemplate: '第{num}章：{name}',
    volumes: [
      { id: 'v1', name: '第1卷：单篇' },
      { id: 'v2', name: '第2卷：长篇' }
    ],
    chapters: [
      { id: 'c1', file: '0.txt', name: '楔子' },
      { id: 'c2', file: '1.txt', name: '甲', volumeId: 'v1' },
      { id: 'c3', file: '2.txt', name: '乙', volumeId: 'v1' },
      { id: 'c4', file: '3.txt', name: '丙', volumeId: 'v2' }
    ]
  };
}

test('导出范围：不传 / 全书模式 = 所有章节，从第 1 章到最后一章', () => {
  const meta = volumeMeta();
  for (const range of [null, undefined, { mode: 'all' }, { mode: 'unknown' }]) {
    const plan = resolveExportRange(meta, range);
    assert.equal(plan.mode, 'all');
    assert.deepEqual(plan.indexes, [0, 1, 2, 3]);
    assert.equal(plan.count, 4);
    assert.equal(plan.from, 1);
    assert.equal(plan.to, 4);
    assert.equal(plan.label, '全书');
    assert.equal(plan.empty, false);
  }
});

test('导出范围：按卷只取那一卷的章节，下标仍是全书下标', () => {
  const meta = volumeMeta();
  const plan = resolveExportRange(meta, { mode: 'volume', volumeId: 'v1' });
  assert.equal(plan.mode, 'volume');
  assert.deepEqual(plan.indexes, [1, 2]);
  assert.equal(plan.count, 2);
  assert.equal(plan.from, 2);
  assert.equal(plan.to, 3);
  assert.equal(plan.label, '第1卷：单篇');
  assert.equal(plan.volumeId, 'v1');
  assert.equal(plan.empty, false);
});

test('导出范围：volumeId 为 null（或没传）= 未分卷，单独一组', () => {
  const meta = volumeMeta();
  assert.deepEqual(resolveExportRange(meta, { mode: 'volume', volumeId: null }).indexes, [0]);
  assert.deepEqual(resolveExportRange(meta, { mode: 'volume' }).indexes, [0]);
  assert.equal(resolveExportRange(meta, { mode: 'volume', volumeId: null }).label, '未分卷');
});

test('导出范围：不存在的卷 / 空卷 = 0 章（调用方提示，不写空文件）', () => {
  const meta = volumeMeta();
  meta.volumes.push({ id: 'v3', name: '空卷' });
  for (const volumeId of ['nope', 'v3']) {
    const plan = resolveExportRange(meta, { mode: 'volume', volumeId });
    assert.equal(plan.count, 0);
    assert.equal(plan.empty, true);
    assert.deepEqual(plan.indexes, []);
  }
});

test('导出范围：第 X–Y 章（含两端），章号按全书顺序', () => {
  const meta = volumeMeta();
  const plan = resolveExportRange(meta, { mode: 'range', from: 2, to: 3 });
  assert.equal(plan.mode, 'range');
  assert.deepEqual(plan.indexes, [1, 2]);
  assert.equal(plan.count, 2);
  assert.equal(plan.from, 2);
  assert.equal(plan.to, 3);
  assert.equal(plan.label, '第2-3章');
  assert.equal(resolveExportRange(meta, { mode: 'range', from: 3, to: 3 }).label, '第3章');
});

test('导出范围：越界自动收进 [1, 总章数]，小数向下取整', () => {
  const meta = volumeMeta();
  const plan = resolveExportRange(meta, { mode: 'range', from: 0, to: 99 });
  assert.deepEqual(plan.indexes, [0, 1, 2, 3]);
  assert.equal(plan.label, '第1-4章');
  const fractional = resolveExportRange(meta, { mode: 'range', from: 2.9, to: 3.1 });
  assert.deepEqual(fractional.indexes, [1, 2]);
  const missing = resolveExportRange(meta, { mode: 'range', from: 'x', to: 'y' });
  assert.deepEqual(missing.indexes, [0, 1, 2, 3]);
});

test('导出范围：起始章大于结束章 = 0 章（界面会先拦，核心兜底）', () => {
  const meta = volumeMeta();
  const plan = resolveExportRange(meta, { mode: 'range', from: 3, to: 2 });
  assert.equal(plan.count, 0);
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.indexes, []);
});

test('导出范围：旧书目（没有 volumes / 新字段）也能算，不会抛错', () => {
  const meta = metaOf('起风', '夜雨');
  assert.deepEqual(resolveExportRange(meta, null).indexes, [0, 1]);
  assert.deepEqual(resolveExportRange(meta, { mode: 'volume', volumeId: null }).indexes, [0, 1]);
  assert.deepEqual(resolveExportRange(meta, { mode: 'range', from: 2, to: 2 }).indexes, [1]);
  // 空书 / 没有 chapters 也按 0 章处理
  assert.equal(resolveExportRange({ title: '空书' }, null).count, 0);
  assert.equal(resolveExportRange({ title: '空书', chapters: [] }, { mode: 'range', from: 1, to: 2 }).count, 0);
});

test('导出范围：只读，不改 meta', () => {
  const meta = volumeMeta();
  const before = JSON.stringify(meta);
  resolveExportRange(meta, { mode: 'volume', volumeId: 'v1' });
  resolveExportRange(meta, { mode: 'range', from: 2, to: 3 });
  composeBook(meta, ['a', 'b', 'c', 'd'], { mode: 'range', from: 2, to: 3 });
  assert.equal(JSON.stringify(meta), before);
});

test('拼按卷导出：只输出这一卷，章号仍是全书章号，卷名在开头一行', () => {
  const meta = volumeMeta();
  const texts = ['楔子正文', '甲正文', '乙正文', '丙正文'];
  assert.equal(
    composeBook(meta, texts, { mode: 'volume', volumeId: 'v1' }),
    '第1卷：单篇\r\n\r\n第2章：甲\r\n\r\n甲正文\r\n\r\n第3章：乙\r\n\r\n乙正文\r\n'
  );
  assert.equal(
    composeBook(meta, texts, { mode: 'volume', volumeId: null }),
    '楔子\r\n\r\n楔子正文\r\n'
  );
});

test('拼章节范围：跨卷时每卷前一行卷名，未选中的章不出现在结果里', () => {
  const meta = volumeMeta();
  const texts = ['楔子正文', '甲正文', '乙正文', '丙正文'];
  assert.equal(
    composeBook(meta, texts, { mode: 'range', from: 3, to: 4 }),
    '第1卷：单篇\r\n\r\n第3章：乙\r\n\r\n乙正文\r\n\r\n第2卷：长篇\r\n\r\n第4章：丙\r\n\r\n丙正文\r\n'
  );
  const single = composeBook(meta, texts, { mode: 'range', from: 1, to: 1 });
  assert.equal(single, '楔子\r\n\r\n楔子正文\r\n');
  assert.ok(!single.includes('甲正文'), '范围外的正文不能混进来');
});

test('拼全书：传全书范围和不传范围结果完全一致（旧调用不受影响）', () => {
  const meta = volumeMeta();
  const texts = ['楔子正文', '甲正文', '乙正文', '丙正文'];
  assert.equal(composeBook(meta, texts, { mode: 'all' }), composeBook(meta, texts));
  assert.equal(composeBook(meta, texts, null), composeBook(meta, texts));
});

test('默认文件名：全书 / 按卷 / 章节范围', () => {
  const meta = volumeMeta();
  assert.equal(exportFileName(meta, null), '测试书.txt');
  assert.equal(exportFileName(meta, { mode: 'all' }), '测试书.txt');
  assert.equal(exportFileName(meta, { mode: 'volume', volumeId: 'v1' }), '测试书-第1卷：单篇.txt');
  assert.equal(exportFileName(meta, { mode: 'volume', volumeId: null }), '测试书-未分卷.txt');
  assert.equal(exportFileName(meta, { mode: 'range', from: 2, to: 3 }), '测试书-第2-3章.txt');
  assert.equal(exportFileName(meta, { mode: 'range', from: 2, to: 2 }), '测试书-第2章.txt');
});

test('默认文件名：书名里的非法字符会被清掉（和书文件夹命名规则一致）', () => {
  const meta = { title: 'a/b:c*?', chapters: [] };
  assert.equal(exportFileName(meta, null), 'abc.txt');
  assert.equal(exportFileName({ chapters: [] }, null), '未命名.txt');
});

test('默认文件名：EPUB 复用同一套范围规则，只换后缀（v0.8 P0 N8）', () => {
  const meta = volumeMeta();
  assert.equal(exportFileName(meta, null, 'epub'), '测试书.epub');
  assert.equal(exportFileName(meta, { mode: 'all' }, 'epub'), '测试书.epub');
  assert.equal(
    exportFileName(meta, { mode: 'volume', volumeId: 'v1' }, 'epub'),
    '测试书-第1卷：单篇.epub'
  );
  assert.equal(exportFileName(meta, { mode: 'volume', volumeId: null }, 'epub'), '测试书-未分卷.epub');
  assert.equal(exportFileName(meta, { mode: 'range', from: 2, to: 3 }, 'epub'), '测试书-第2-3章.epub');
  // 不带扩展名 / 传空串 / 传带点的扩展名都兜底成 txt
  assert.equal(exportFileName(meta, null, ''), '测试书.txt');
  assert.equal(exportFileName(meta, null, '  '), '测试书.txt');
  assert.equal(exportFileName(meta, null, '.txt'), '测试书.txt');
});
