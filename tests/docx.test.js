const test = require('node:test');
const assert = require('node:assert/strict');
const docx = require('../core/docx');
const { readZip, assertWellFormedXml } = require('../scripts/export-check');

const FIXED = '2026-11-01T08:00:00Z';
const ZIP_DATE = new Date('2026-11-01T08:00:00Z');
const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/_rels/document.xml.rels',
  'docProps/core.xml',
  'docProps/app.xml'
];

function metaOf(overrides = {}) {
  return {
    title: '测试书',
    id: 'b_test',
    chapters: [
      { id: 'c1', file: '001-起风.txt', name: '起风' },
      { id: 'c2', file: '002-夜雨.txt', name: '夜雨' }
    ],
    ...overrides
  };
}

function rangeMeta() {
  return {
    title: '范围书',
    id: 'b_range',
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

// 一次构建出 zip 视图，省得每个用例重复解包
function build(input = {}) {
  const res = docx.buildDocx({
    meta: metaOf(),
    texts: ['风从海面吹来。', '雨下了一夜。'],
    modified: FIXED,
    zipDate: ZIP_DATE,
    ...input
  });
  const zip = readZip(res.buffer);
  const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));
  return { res, buffer: res.buffer, zip, byName };
}

function buildRange(range) {
  return build({ meta: rangeMeta(), texts: rangeTexts(), range });
}

function textOf(byName, name) {
  const entry = byName.get(name);
  assert.ok(entry, `缺少条目 ${name}`);
  return entry.data.toString('utf8');
}

test('DOCX 包结构：最小 OOXML 部件齐全、内容类型 / 关系指向真实存在的部件', () => {
  const { res, zip, byName } = build();
  assert.deepEqual(zip.names, REQUIRED_PARTS);
  assert.equal(res.chapterCount, 2);
  assert.equal(res.volumeCount, 0);
  assert.equal(res.title, '测试书');
  assert.equal(res.bytes, res.buffer.length);
  assert.ok(res.bytes > 1000, `包太小：${res.bytes}`);
  assert.equal(res.buffer.readUInt32LE(0), 0x04034b50, 'DOCX 应该是一个 zip 包');

  const types = textOf(byName, '[Content_Types].xml');
  assert.ok(types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'));
  assert.ok(types.includes('/word/styles.xml'));
  assert.ok(types.includes('/docProps/core.xml'));
  const rels = textOf(byName, '_rels/.rels');
  assert.ok(rels.includes('Target="word/document.xml"'));
  assert.ok(rels.includes('Target="docProps/core.xml"'));
  const docRels = textOf(byName, 'word/_rels/document.xml.rels');
  assert.ok(docRels.includes('Target="styles.xml"'));

  for (const entry of zip.entries) {
    if (!/\.(xml|rels)$/.test(entry.name)) continue;
    assertWellFormedXml(entry.data.toString('utf8'), entry.name);
  }
});

test('DOCX 正文：标题页（书名 / 作者 / 章数）、分页、卷 / 章标题与正文都在', () => {
  const { byName } = build({
    meta: metaOf({ author: '示例作者', volumes: [{ id: 'v1', name: '第一卷' }] }),
    texts: ['第一段。\n\n第二段。', '第二章正文。']
  });
  const document = textOf(byName, 'word/document.xml');
  assert.ok(document.includes('<w:pStyle w:val="Title"/>'));
  assert.ok(document.includes('>测试书</w:t>'));
  assert.ok(document.includes('>作者：示例作者</w:t>'));
  assert.ok(document.includes('>共 2 章</w:t>'));
  assert.ok(document.includes('<w:br w:type="page"/>'), '标题页之后要分页');
  assert.ok(document.includes('<w:pStyle w:val="Heading2"/>'));
  assert.ok(document.includes('>第1章：起风</w:t>'));
  assert.ok(document.includes('>第2章：夜雨</w:t>'));
  assert.ok(document.includes('>第一段。</w:t>'));
  assert.ok(document.includes('>第二段。</w:t>'));
  assert.ok(document.includes('>第二章正文。</w:t>'));
  // 正文里的空行不生成空段落（段间留白交给样式）
  assert.equal((document.match(/<w:p>/g) || []).length, 9, document);
});

test('DOCX 样式：正文段首缩进 2 字、1.5 倍行距、宋体 / 黑体，标题居中加粗', () => {
  const { byName } = build();
  const styles = textOf(byName, 'word/styles.xml');
  assert.ok(styles.includes('<w:style w:type="paragraph" w:styleId="BodyText">'));
  assert.ok(styles.includes('<w:ind w:firstLineChars="200" w:firstLine="480"/>'));
  assert.ok(styles.includes(`w:line="${docx.WORD_LINE_SPACING}" w:lineRule="auto"`));
  assert.ok(styles.includes(`w:eastAsia="${docx.WORD_FONT}"`));
  assert.ok(styles.includes(`w:eastAsia="黑体"`));
  assert.ok(styles.includes('<w:style w:type="paragraph" w:styleId="Heading2">'));
  assert.ok(styles.includes('<w:jc w:val="center"/>'));
  assert.ok(styles.includes('<w:b/>'));
  const core = textOf(byName, 'docProps/core.xml');
  assert.ok(core.includes('<dc:title>测试书</dc:title>'));
  assert.ok(core.includes(`<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED}</dcterms:modified>`));
  assertWellFormedXml(styles, 'styles.xml');
});

test('DOCX 正文：特殊字符转义、控制字符剔除，包仍然合法', () => {
  const nasty = '第一段 & 第二段。\n\n「引号」<尖括号> "双引号" \u0000\u0008 结尾';
  const { zip, byName } = build({
    meta: metaOf({ title: 'A & B <书>', chapters: [{ id: 'c1', file: '001.txt', name: '甲 & 乙 <章>' }] }),
    texts: [nasty]
  });
  const document = textOf(byName, 'word/document.xml');
  assert.ok(document.includes('A &amp; B &lt;书&gt;'));
  assert.ok(document.includes('甲 &amp; 乙 &lt;章&gt;'));
  assert.ok(document.includes('&amp;'));
  assert.ok(document.includes('&lt;尖括号&gt;'));
  assert.ok(!document.includes('\u0000'));
  assert.ok(!document.includes('\u0008'));
  for (const entry of zip.entries) {
    if (/\.(xml|rels)$/.test(entry.name)) {
      assertWellFormedXml(entry.data.toString('utf8'), entry.name);
    }
  }
});

test('DOCX 按卷导出：只写选中卷的章，章号 / 章名仍按全书，卷标题只生成选中卷', () => {
  const { res, byName } = buildRange({ mode: 'volume', volumeId: 'v1' });
  assert.equal(res.chapterCount, 2);
  assert.equal(res.volumeCount, 1);
  assert.equal(res.rangeMode, 'volume');
  assert.equal(res.rangeLabel, '上卷');
  const document = textOf(byName, 'word/document.xml');
  assert.ok(document.includes('>上卷</w:t>'));
  assert.ok(document.includes('>第2章：上卷一</w:t>'));
  assert.ok(document.includes('>第3章：上卷二</w:t>'));
  assert.ok(!document.includes('楔子'));
  assert.ok(!document.includes('下卷'));
  assert.ok(document.includes('>上卷 · 共 2 章 · 1 卷</w:t>'), document);
  assert.ok(document.includes('>上卷第一章正文。</w:t>'));
  assert.ok(!document.includes('下卷第一章正文。'));
});

test('DOCX 按章节范围导出：跨卷时两个卷标题都在，范围外一章不进文档', () => {
  const { res, byName } = buildRange({ mode: 'range', from: 2, to: 4 });
  assert.equal(res.chapterCount, 3);
  assert.equal(res.volumeCount, 2);
  assert.equal(res.rangeLabel, '第2-4章');
  const document = textOf(byName, 'word/document.xml');
  assert.ok(document.includes('>第2章：上卷一</w:t>'));
  assert.ok(document.includes('>第3章：上卷二</w:t>'));
  assert.ok(document.includes('>第4章：下卷三</w:t>'));
  assert.ok(!document.includes('楔子'));
  assert.ok(!document.includes('第5章'));
  assert.ok(document.includes('>第2-4章 · 共 3 章 · 2 卷</w:t>'), document);
  // 卷标题顺序：上卷 → 第2章 → 第3章 → 下卷 → 第4章
  const order = ['上卷', '第2章：上卷一', '第3章：上卷二', '下卷', '第4章：下卷三'];
  let cursor = -1;
  for (const needle of order) {
    const next = document.indexOf(`>${needle}</w:t>`, cursor + 1);
    assert.ok(next > cursor, `顺序不对：${needle}`);
    cursor = next;
  }
});

test('DOCX 范围导出：没有章节的范围明确报错，不产出坏文件（空书仍是 EMPTY_BOOK）', () => {
  assert.throws(() => buildRange({ mode: 'range', from: 4, to: 2 }), /EMPTY_EXPORT_RANGE/);
  assert.throws(() => buildRange({ mode: 'volume', volumeId: 'nope' }), /EMPTY_EXPORT_RANGE/);
  assert.throws(
    () => docx.buildDocx({ meta: { title: '空书', chapters: [] }, texts: [], range: { mode: 'all' } }),
    /EMPTY_BOOK/
  );
});

test('DOCX 只读：不改 meta / texts；同样内容 + 同样时间字节完全一样', () => {
  const meta = rangeMeta();
  const texts = rangeTexts();
  const metaBefore = JSON.stringify(meta);
  const textsBefore = JSON.stringify(texts);
  const first = docx.buildDocx({ meta, texts, modified: FIXED, zipDate: ZIP_DATE });
  const second = docx.buildDocx({ meta, texts, modified: FIXED, zipDate: ZIP_DATE });
  const volume = docx.buildDocx({
    meta,
    texts,
    modified: FIXED,
    zipDate: ZIP_DATE,
    range: { mode: 'volume', volumeId: 'v1' }
  });
  assert.equal(JSON.stringify(meta), metaBefore, '导出不能改 meta');
  assert.equal(JSON.stringify(texts), textsBefore, '导出不能改 texts');
  assert.ok(first.buffer.equals(second.buffer), '同样输入应该导出完全一样的字节');
  assert.ok(!first.buffer.equals(volume.buffer), '按卷导出的文件不该和整本一样');
  assert.equal(first.rangeMode, 'all');
  assert.equal(volume.rangeMode, 'volume');
});

test('DOCX 默认文件名：按卷 / 按范围复用 TXT 的范围命名规则，只换后缀', () => {
  const meta = rangeMeta();
  assert.equal(docx.docxFileName(meta), '范围书.docx');
  assert.equal(docx.docxFileName(meta, { mode: 'all' }), '范围书.docx');
  assert.equal(docx.docxFileName(meta, { mode: 'volume', volumeId: 'v1' }), '范围书-上卷.docx');
  assert.equal(docx.docxFileName(meta, { mode: 'volume', volumeId: null }), '范围书-未分卷.docx');
  assert.equal(docx.docxFileName(meta, { mode: 'range', from: 2, to: 4 }), '范围书-第2-4章.docx');
  assert.equal(docx.docxFileName(meta, { mode: 'range', from: 3, to: 3 }), '范围书-第3章.docx');
  assert.equal(docx.docxFileName({ title: 'a/b:c*?', chapters: [] }), 'abc.docx');
});

test('DOCX 未分卷 / 空正文 / 原文标题章名：只写该章标题，缺正文也不报错', () => {
  const { res, byName } = build({
    meta: {
      title: '原文书',
      chapters: [
        { id: 'c1', file: '001.txt', name: '第1章 关于本作品' },
        { id: 'c2', file: '002.txt', name: '空章' }
      ]
    },
    texts: ['正文。'],
    range: { mode: 'volume', volumeId: null }
  });
  assert.equal(res.chapterCount, 2);
  assert.equal(res.volumeCount, 0);
  const document = textOf(byName, 'word/document.xml');
  assert.ok(document.includes('>第1章 关于本作品</w:t>'));
  assert.ok(document.includes('>第2章：空章</w:t>'));
  assert.ok(document.includes('>未分卷 · 共 2 章</w:t>'));
  assert.ok(!document.includes('>未分卷</w:t>'), '未分卷不生成卷标题');
  assert.equal((document.match(/<w:pStyle w:val="BodyText"\/>/g) || []).length, 1);
});
