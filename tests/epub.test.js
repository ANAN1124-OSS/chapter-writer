const test = require('node:test');
const assert = require('node:assert/strict');
const epub = require('../core/epub');
const { readZip, crc32: checkCrc32, assertWellFormedXml } = require('../scripts/export-check');

const FIXED = '2026-10-31T12:00:00Z';

function metaOf(overrides = {}) {
  return {
    title: '测试书',
    id: 'b_test',
    titleTemplate: '第{num}章：{name}',
    chapters: [
      { id: 'c1', file: '001-起风.txt', name: '起风' },
      { id: 'c2', file: '002-夜雨.txt', name: '夜雨' }
    ],
    ...overrides
  };
}

// 一次构建出 zip 视图，省得每个用例重复解包
function build(input = {}) {
  const res = epub.buildEpub({
    meta: metaOf(),
    texts: ['风从海面吹来。', '雨下了一夜。'],
    modified: FIXED,
    ...input
  });
  const zip = readZip(res.buffer);
  const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));
  return { res, buffer: res.buffer, zip, byName };
}

function textOf(byName, name) {
  const entry = byName.get(name);
  assert.ok(entry, `缺少条目 ${name}`);
  return entry.data.toString('utf8');
}

test('CRC32：和标准校验值一致（zip 写坏会在这里先暴露）', () => {
  assert.equal(epub.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(checkCrc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP：mimetype 是第一个条目、不压缩、没有扩展字段', () => {
  const { buffer, zip } = build();
  assert.equal(zip.entries[0].name, 'mimetype');
  assert.equal(zip.entries[0].method, 0);
  assert.equal(zip.entries[0].data.toString('utf8'), 'application/epub+zip');
  // 本地文件头：签名 / 标志位 / 压缩方式 / 扩展字段长度
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(buffer.readUInt16LE(6), 0);
  assert.equal(buffer.readUInt16LE(8), 0);
  assert.equal(buffer.readUInt16LE(28), 0);
  // 所有条目都能正常解压且 CRC 对得上（readZip 内部已经逐条校验）
  assert.ok(zip.entries.length >= 7, `条目太少：${zip.names.join(', ')}`);
});

test('ZIP：所有条目路径都是 ASCII（避免老阅读器不认中文文件名）', () => {
  const { zip } = build();
  for (const entry of zip.entries) {
    assert.match(entry.name, /^[\x20-\x7e]+$/, `条目名不是 ASCII：${entry.name}`);
  }
});

test('EPUB 结构：container.xml 指向 OEBPS/content.opf', () => {
  const { byName } = build();
  const container = textOf(byName, 'META-INF/container.xml');
  assert.ok(container.includes('full-path="OEBPS/content.opf"'));
  assert.ok(container.includes('media-type="application/oebps-package+xml"'));
  assertWellFormedXml(container, 'container.xml');
});

test('OPF：书名 / 语言 / 唯一标识 / 修改时间都写对了', () => {
  const { byName } = build();
  const opf = textOf(byName, 'OEBPS/content.opf');
  assert.ok(opf.includes('<dc:title>测试书</dc:title>'));
  assert.ok(opf.includes('<dc:language>zh-CN</dc:language>'));
  assert.ok(opf.includes('<meta property="dcterms:modified">2026-10-31T12:00:00Z</meta>'));
  assert.match(opf, /<dc:identifier id="pub-id">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/);
});

test('OPF：manifest 与 spine 一致（idref 都有 item、href 都有文件、id/href 不重复）', () => {
  const { byName, zip } = build();
  const opf = textOf(byName, 'OEBPS/content.opf');
  const ids = [...opf.matchAll(/<item id="([^"]+)"/g)].map((match) => match[1]);
  const hrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1]);
  const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'manifest id 重复了');
  assert.equal(new Set(hrefs).size, hrefs.length, 'manifest href 重复了');
  assert.ok(opf.includes('properties="nav"'), 'nav.xhtml 必须带 properties="nav"');
  for (const idref of idrefs) assert.ok(ids.includes(idref), `spine 里的 ${idref} 不在 manifest 里`);
  for (const href of hrefs) assert.ok(byName.has(`OEBPS/${href}`), `manifest 里的 ${href} 没有对应文件`);
  // spine 第一项是封面，后面按书目顺序
  assert.equal(idrefs[0], 'cover');
  assert.ok(zip.names.includes('OEBPS/cover.xhtml'));
});

test('章节 XHTML：标题沿用 formatTitle，正文按段拆、CRLF 归一、空行丢弃', () => {
  const { byName } = build({ texts: ['\n第一段\r\n\r\n第二段。\r\n　\r\n第三段  \r\n', '乙'] });
  const html = textOf(byName, 'OEBPS/text/chapter-0001.xhtml');
  assert.ok(html.includes('<h1 class="chapter-title">第1章：起风</h1>'));
  assert.ok(html.includes('<p>第一段</p>\n  <p>第二段。</p>\n  <p>第三段</p>'));
  assert.ok(!html.includes('<p></p>'));
  assertWellFormedXml(html, 'chapter-0001');
});

test('段落切分：CRLF / CR / 纯空白行 / 首尾空白', () => {
  assert.deepEqual(epub.paragraphsFromText('\r\n第一段\r第二段\n\n  \n第三段  \n'), [
    '第一段',
    '第二段',
    '第三段'
  ]);
  assert.deepEqual(epub.paragraphsFromText(''), []);
  assert.deepEqual(epub.paragraphsFromText(null), []);
});

test('章名和正文里的 XML 特殊字符全部转义', () => {
  const meta = metaOf({
    chapters: [{ id: 'c1', file: '001.txt', name: 'A&B <夜> "雨" \'风\'' }]
  });
  const { byName } = build({ meta, texts: ['1 < 2 & 3 > 2'] });
  const html = textOf(byName, 'OEBPS/text/chapter-0001.xhtml');
  assert.ok(html.includes('A&amp;B &lt;夜&gt; &quot;雨&quot; &apos;风&apos;'), html);
  assert.ok(html.includes('<p>1 &lt; 2 &amp; 3 &gt; 2</p>'), html);
  assert.ok(!html.includes('1 < 2 & 3 >'), '正文没有转义');
  assertWellFormedXml(html, 'chapter-0001');
});

test('XML 非法控制字符被剔除（否则整本书在阅读器里打不开）', () => {
  const { byName } = build({ texts: ['正文\u0000有\u0007控制符\u000b'] });
  const html = textOf(byName, 'OEBPS/text/chapter-0001.xhtml');
  assert.ok(html.includes('<p>正文有控制符</p>'), JSON.stringify(html.slice(0, 200)));
  assertWellFormedXml(html, 'chapter-0001');
});

test('分卷：有名字的卷生成卷名页 + 二级目录，未分卷章节留在顶层', () => {
  const meta = {
    title: '分卷书',
    id: 'b_volume',
    volumes: [{ id: 'v1', name: '上卷' }],
    chapters: [
      { id: 'c1', file: '001.txt', name: '楔子' },
      { id: 'c2', file: '002.txt', name: '上卷一', volumeId: 'v1' },
      { id: 'c3', file: '003.txt', name: '上卷二', volumeId: 'v1' }
    ]
  };
  const { byName } = build({ meta, texts: ['甲', '乙', '丙'] });
  const cover = textOf(byName, 'OEBPS/text/volume-0001.xhtml');
  assert.ok(cover.includes('<h1 class="part-title">上卷</h1>'));
  assertWellFormedXml(cover, 'volume-0001');

  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  // 「楔子」属于原文自带标题（core/chapters.RAW_TITLE_RE），显示时原样保留
  assert.match(nav, /<li><a href="text\/chapter-0001\.xhtml">楔子<\/a><\/li>/);
  assert.match(nav, /<a href="text\/volume-0001\.xhtml">上卷<\/a>/);
  assert.match(nav, /<li><a href="text\/chapter-0002\.xhtml">第2章：上卷一<\/a><\/li>/);
  // 卷名页在 spine 里排在该卷第一章前面
  const opf = textOf(byName, 'OEBPS/content.opf');
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(spine, ['cover', 'ch1', 'vol1', 'ch2', 'ch3']);
  assert.equal((nav.match(/<ol>/g) || []).length, 2, '分卷目录应该有二层 ol');
});

test('NCX：playOrder 按文档顺序连续、分卷嵌套、depth = 2', () => {
  const meta = {
    title: '分卷书',
    volumes: [{ id: 'v1', name: '上卷' }],
    chapters: [
      { id: 'c1', file: '001.txt', name: '楔子' },
      { id: 'c2', file: '002.txt', name: '上卷一', volumeId: 'v1' }
    ]
  };
  const { byName } = build({ meta, texts: ['甲', '乙'] });
  const ncx = textOf(byName, 'OEBPS/toc.ncx');
  const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(orders, [1, 2, 3]);
  assert.ok(ncx.includes('<meta name="dtb:depth" content="2"/>'));
  // 上卷的 navPoint 里套着章节的 navPoint
  assert.match(ncx, /<navPoint id="np2" playOrder="2">[\s\S]*?<navPoint id="np3" playOrder="3">/);
  assertWellFormedXml(ncx, 'toc.ncx');
});

test('没有分卷的书：目录是一层，NCX depth = 1', () => {
  const { byName } = build();
  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  assert.equal((nav.match(/<ol>/g) || []).length, 1);
  const ncx = textOf(byName, 'OEBPS/toc.ncx');
  assert.ok(ncx.includes('<meta name="dtb:depth" content="1"/>'));
});

test('封面页：纯文字封面带书名和章数 / 卷数', () => {
  const { byName } = build();
  const cover = textOf(byName, 'OEBPS/cover.xhtml');
  assert.ok(cover.includes('<h1 class="cover-title">测试书</h1>'));
  assert.ok(cover.includes('<p class="cover-meta">共 2 章</p>'));
  assertWellFormedXml(cover, 'cover');
});

test('封面页：有分卷时章数后面带上卷数', () => {
  const meta = {
    title: '分卷书',
    volumes: [{ id: 'v1', name: '上卷' }],
    chapters: [{ id: 'c1', file: '001.txt', name: '上卷一', volumeId: 'v1' }]
  };
  const { byName } = build({ meta, texts: ['甲'] });
  assert.ok(textOf(byName, 'OEBPS/cover.xhtml').includes('共 1 章 · 1 卷'));
});

test('没有章节的书：明确报错，不产出坏书', () => {
  assert.throws(() => epub.buildEpub({ meta: { title: '空书', chapters: [] }, texts: [] }), /EMPTY_BOOK/);
  assert.throws(() => epub.epubFiles({ meta: { title: '空书' }, texts: [] }), /EMPTY_BOOK/);
});

test('默认文件名：书名.epub，非法字符清洗，空书名兜底', () => {
  assert.equal(epub.epubFileName({ title: '我的:书/名?' }), '我的书名.epub');
  assert.equal(epub.epubFileName({ title: '   ' }), '未命名.epub');
  assert.equal(epub.epubFileName(null), '未命名.epub');
});

// ---------- 按卷 / 按范围导出（v0.8 P0 N8） ----------
function rangeMeta() {
  return {
    title: '范围书',
    id: 'b_range',
    titleTemplate: '第{num}章：{name}',
    volumes: [
      { id: 'v1', name: '上卷' },
      { id: 'v2', name: '下卷' }
    ],
    chapters: [
      { id: 'c1', file: '001.txt', name: '楔子' },
      { id: 'c2', file: '002.txt', name: '上卷一', volumeId: 'v1' },
      { id: 'c3', file: '003.txt', name: '上卷二', volumeId: 'v1' },
      { id: 'c4', file: '004.txt', name: '下卷三', volumeId: 'v2' },
      { id: 'c5', file: '005.txt', name: '下卷四', volumeId: 'v2' }
    ]
  };
}

function rangeTexts() {
  return ['楔子正文。', '上卷第一章正文。', '上卷第二章正文。', '下卷第一章正文。', '下卷第二章正文。'];
}

function buildRange(range) {
  return build({ meta: rangeMeta(), texts: rangeTexts(), range });
}

test('EPUB 按卷导出：只打这一卷的章节，卷名页 / 目录 / spine 都只含这一卷', () => {
  const { res, zip, byName } = buildRange({ mode: 'volume', volumeId: 'v1' });
  assert.equal(res.chapterCount, 2);
  assert.equal(res.volumeCount, 1);
  assert.equal(res.rangeMode, 'volume');
  assert.equal(res.rangeLabel, '上卷');
  assert.deepEqual(zip.names.filter((name) => name.startsWith('OEBPS/text/')).sort(), [
    'OEBPS/text/chapter-0002.xhtml',
    'OEBPS/text/chapter-0003.xhtml',
    'OEBPS/text/volume-0001.xhtml'
  ]);
  const opf = textOf(byName, 'OEBPS/content.opf');
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(spine, ['cover', 'vol1', 'ch2', 'ch3']);
  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  assert.ok(nav.includes('<a href="text/volume-0001.xhtml">上卷</a>'));
  assert.ok(nav.includes('第2章：上卷一') && nav.includes('第3章：上卷二'));
  assert.ok(!nav.includes('楔子') && !nav.includes('下卷'), nav);
  assert.ok(textOf(byName, 'OEBPS/cover.xhtml').includes('上卷 · 共 2 章 · 1 卷'));
  // 章号 / 章名仍按全书顺序（不重新从第 1 章开始）
  assert.ok(
    textOf(byName, 'OEBPS/text/chapter-0003.xhtml').includes('<h1 class="chapter-title">第3章：上卷二</h1>')
  );
  assertWellFormedXml(textOf(byName, 'OEBPS/text/chapter-0003.xhtml'), 'chapter-0003');
});

test('EPUB 按章节范围导出：跨卷时两卷的卷名页都在，范围外的章一个都不进包', () => {
  const { res, zip, byName } = buildRange({ mode: 'range', from: 2, to: 4 });
  assert.equal(res.chapterCount, 3);
  assert.equal(res.volumeCount, 2);
  assert.equal(res.rangeLabel, '第2-4章');
  assert.deepEqual(zip.names.filter((name) => name.startsWith('OEBPS/text/')).sort(), [
    'OEBPS/text/chapter-0002.xhtml',
    'OEBPS/text/chapter-0003.xhtml',
    'OEBPS/text/chapter-0004.xhtml',
    'OEBPS/text/volume-0001.xhtml',
    'OEBPS/text/volume-0002.xhtml'
  ]);
  const opf = textOf(byName, 'OEBPS/content.opf');
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(spine, ['cover', 'vol1', 'ch2', 'ch3', 'vol2', 'ch4']);
  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  assert.equal((nav.match(/<ol>/g) || []).length, 3, '两卷 = 两个二级 ol + 一个顶层 ol');
  assert.ok(nav.includes('上卷') && nav.includes('下卷'));
  assert.ok(!nav.includes('楔子') && !nav.includes('下卷四'), nav);
  const cover = textOf(byName, 'OEBPS/cover.xhtml');
  assert.ok(cover.includes('第2-4章 · 共 3 章 · 2 卷'), cover);
  // 正文只取选中章（texts 下标对齐，范围外传空串也不会混进来）
  assert.ok(textOf(byName, 'OEBPS/text/chapter-0002.xhtml').includes('上卷第一章正文。'));
  assert.ok(textOf(byName, 'OEBPS/text/chapter-0004.xhtml').includes('下卷第一章正文。'));
});

test('EPUB 按卷导出：未分卷（volumeId=null）只打未分卷章，不生成卷名页', () => {
  const { res, zip, byName } = buildRange({ mode: 'volume', volumeId: null });
  assert.equal(res.chapterCount, 1);
  assert.equal(res.volumeCount, 0);
  assert.equal(res.rangeLabel, '未分卷');
  assert.deepEqual(zip.names.filter((name) => name.startsWith('OEBPS/text/')), [
    'OEBPS/text/chapter-0001.xhtml'
  ]);
  const opf = textOf(byName, 'OEBPS/content.opf');
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(spine, ['cover', 'ch1']);
  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  assert.equal((nav.match(/<ol>/g) || []).length, 1);
  assert.ok(nav.includes('楔子') && !nav.includes('上卷'));
  assert.ok(textOf(byName, 'OEBPS/cover.xhtml').includes('未分卷 · 共 1 章'));
});

test('EPUB 范围导出：没有章节的范围明确报错，不产出坏书（空书仍是 EMPTY_BOOK）', () => {
  assert.throws(() => buildRange({ mode: 'range', from: 4, to: 2 }), /EMPTY_EXPORT_RANGE/);
  assert.throws(() => buildRange({ mode: 'volume', volumeId: 'nope' }), /EMPTY_EXPORT_RANGE/);
  assert.throws(
    () => epub.buildEpub({ meta: { title: '空书', chapters: [] }, texts: [], range: { mode: 'all' } }),
    /EMPTY_BOOK/
  );
});

test('EPUB 范围导出：只读，不改 meta；同样范围导出的 identifier 稳定，不同范围不同', () => {
  const meta = rangeMeta();
  const before = JSON.stringify(meta);
  const volume = epub.buildEpub({
    meta,
    texts: rangeTexts(),
    range: { mode: 'volume', volumeId: 'v1' },
    modified: FIXED
  });
  const range = epub.buildEpub({
    meta,
    texts: rangeTexts(),
    range: { mode: 'range', from: 2, to: 3 },
    modified: FIXED
  });
  const again = epub.buildEpub({
    meta,
    texts: rangeTexts(),
    range: { mode: 'volume', volumeId: 'v1' },
    modified: FIXED
  });
  const full = epub.buildEpub({ meta, texts: rangeTexts(), modified: FIXED });
  assert.equal(JSON.stringify(meta), before, '范围解析 / 导出不能改 meta');
  assert.equal(volume.identifier, again.identifier, '同样的范围每次导出 identifier 要一样');
  assert.notEqual(volume.identifier, range.identifier);
  assert.notEqual(volume.identifier, full.identifier, '按卷导出不能和整本书共用一个 identifier');
  for (const id of [volume.identifier, range.identifier, full.identifier]) {
    assert.match(id, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('EPUB 全书导出：不传范围与 {mode:"all"} 字节完全一样（旧调用不受影响）', () => {
  const meta = rangeMeta();
  const first = epub.buildEpub({ meta, texts: rangeTexts(), modified: FIXED });
  const second = epub.buildEpub({ meta, texts: rangeTexts(), modified: FIXED, range: { mode: 'all' } });
  assert.ok(first.buffer.equals(second.buffer), '全书导出的字节不该因为新增 range 参数而变化');
  assert.equal(first.identifier, second.identifier);
  assert.equal(first.rangeMode, 'all');
});

test('EPUB 默认文件名：按卷 / 按范围复用 TXT 的范围命名规则，只换后缀', () => {
  const meta = rangeMeta();
  assert.equal(epub.epubFileName(meta), '范围书.epub');
  assert.equal(epub.epubFileName(meta, { mode: 'all' }), '范围书.epub');
  assert.equal(epub.epubFileName(meta, { mode: 'volume', volumeId: 'v1' }), '范围书-上卷.epub');
  assert.equal(epub.epubFileName(meta, { mode: 'volume', volumeId: null }), '范围书-未分卷.epub');
  assert.equal(epub.epubFileName(meta, { mode: 'range', from: 2, to: 4 }), '范围书-第2-4章.epub');
  assert.equal(epub.epubFileName(meta, { mode: 'range', from: 3, to: 3 }), '范围书-第3章.epub');
  assert.equal(epub.epubFileName({ title: 'a/b:c*?', chapters: [] }), 'abc.epub');
});

test('同样内容 + 同样时间：导出的字节完全一样（便于校验与回归）', () => {
  const first = epub.buildEpub({ meta: metaOf(), texts: ['甲', '乙'], modified: FIXED });
  const second = epub.buildEpub({ meta: metaOf(), texts: ['甲', '乙'], modified: FIXED });
  assert.ok(first.buffer.equals(second.buffer), '同样的输入不该导出不同的字节');
});

test('正文数量少于章节：缺的章仍然生成一张只有标题的页面', () => {
  const { byName } = build({ texts: ['只有第一章'] });
  const second = textOf(byName, 'OEBPS/text/chapter-0002.xhtml');
  assert.ok(second.includes('<h1 class="chapter-title">第2章：夜雨</h1>'));
  assert.ok(!second.includes('<p>'));
});

test('章节指向不存在的卷：按未分卷平铺，不生成卷名页', () => {
  const meta = {
    title: '坏卷书',
    volumes: [],
    chapters: [{ id: 'c1', file: '001.txt', name: '甲', volumeId: 'missing' }]
  };
  const { byName } = build({ meta, texts: ['正文'] });
  assert.ok(!byName.has('OEBPS/text/volume-0001.xhtml'));
  const nav = textOf(byName, 'OEBPS/nav.xhtml');
  assert.equal((nav.match(/<ol>/g) || []).length, 1);
  assert.ok(nav.includes('第1章：甲'));
});

test('导进来的原文标题（第1章 关于本作品）原样当章名，不叠加「第N章：」', () => {
  const meta = { title: '原文书', chapters: [{ id: 'c1', file: '001.txt', name: '第1章 关于本作品' }] };
  const { byName } = build({ meta, texts: ['正文'] });
  assert.ok(textOf(byName, 'OEBPS/text/chapter-0001.xhtml').includes('<h1 class="chapter-title">第1章 关于本作品</h1>'));
});

test('所有 XML 文件都通过合法性检查（含特殊字符的正文）', () => {
  const { zip } = build({ texts: ['第一段 & 第二段。\n\n「引号」<尖括号> "双引号"', '乙'] });
  let checked = 0;
  for (const entry of zip.entries) {
    if (!/\.(xhtml|opf|ncx|xml)$/.test(entry.name)) continue;
    assertWellFormedXml(entry.data.toString('utf8'), entry.name);
    checked += 1;
  }
  assert.ok(checked >= 7, `XML 文件太少：${checked}`);
});

test('自检工具能发现没转义的 & 和没闭合的标签', () => {
  assert.throws(() => assertWellFormedXml('<p>a & b</p>', 't'), /没有转义的 &/);
  assert.throws(() => assertWellFormedXml('<p><b>x</p></b>', 't'), /不匹配/);
  assert.throws(() => assertWellFormedXml('<p>x', 't'), /没有闭合/);
  assert.doesNotThrow(() => assertWellFormedXml('<p>a &amp; b <br/></p>', 't'));
});
