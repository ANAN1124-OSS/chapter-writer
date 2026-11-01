// zip 条目名闸门（v0.9 C-3，安全审计 C6）：
// EPUB / DOCX 的条目名全部由本应用生成，书名 / 卷名 / 章名只进正文。
// 这里锁住「以后有人把作者输入拼进条目名」时立刻失败：路径穿越 / 反斜杠 / 盘符 /
// 控制字符 / 非 ASCII / 超长名字一律拒绝，绝不产出能把文件解压到包外面的 zip。
const test = require('node:test');
const assert = require('node:assert/strict');
const zipLib = require('../core/zip');
const epub = require('../core/epub');
const docx = require('../core/docx');
const { readZip } = require('../scripts/export-check');

const { assertEntryName, entryNameProblem, buildZip, MAX_ENTRY_NAME_BYTES } = zipLib;

// 当前导出允许写进 zip 的条目名形状（白名单：固定部位 + 补零编号，不含任何作者输入）
const EPUB_NAME_RE = /^(mimetype|META-INF\/container\.xml|OEBPS\/(content\.opf|nav\.xhtml|toc\.ncx|style\.css|cover\.xhtml|text\/(volume|chapter)-\d{4}\.xhtml))$/;
const DOCX_NAME_RE = /^(\[Content_Types\]\.xml|_rels\/\.rels|word\/(document|styles)\.xml|word\/_rels\/document\.xml\.rels|docProps\/(core|app)\.xml)$/;

// DOCX 的七个部位是固定的（最小 OOXML 包）：清单快照，少一个 / 多一个都要在评审里看到
const DOCX_NAMES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/_rels/document.xml.rels',
  'docProps/core.xml',
  'docProps/app.xml'
];

function metaOf() {
  return {
    title: '测试书',
    id: 'b_test',
    volumes: [{ id: 'v1', name: '上卷' }],
    chapters: [
      { id: 'c1', file: '001.txt', name: '楔子' },
      { id: 'c2', file: '002.txt', name: '上卷一', volumeId: 'v1' }
    ]
  };
}

test('条目名闸门：EPUB / DOCX 实际产出的名字全部合法，且都在白名单里', () => {
  const epubNames = epub.epubFiles({ meta: metaOf(), texts: ['正文', '正文二'] }).map((file) => file.name);
  const docxNames = docx.docxFiles({ meta: metaOf(), texts: ['正文', '正文二'] }).map((file) => file.name);
  assert.ok(epubNames.length >= 9, `EPUB 条目太少：${epubNames.join(', ')}`);
  for (const name of epubNames) {
    assert.equal(entryNameProblem(name), '', `条目名不合法：${name}`);
    assert.match(name, EPUB_NAME_RE, `条目名不在白名单里：${name}`);
  }
  assert.deepEqual([...new Set(docxNames)].sort(), [...DOCX_NAMES].sort());
  for (const name of docxNames) {
    assert.equal(entryNameProblem(name), '', `条目名不合法：${name}`);
    assert.match(name, DOCX_NAME_RE, `条目名不在白名单里：${name}`);
  }
});

test('条目名闸门：合法名字照常放过（大小写 / 空格 / 方括号 / 正好 255 字节）', () => {
  const longest = 'a'.repeat(MAX_ENTRY_NAME_BYTES);
  for (const name of [
    'mimetype',
    'OEBPS/text/chapter-0001.xhtml',
    '[Content_Types].xml',
    'word/_rels/document.xml.rels',
    'a b.txt',
    longest
  ]) {
    assert.equal(entryNameProblem(name), '', name);
    assert.equal(assertEntryName(name), name);
  }
});

test('条目名闸门：路径穿越 / 反斜杠 / 盘符 / 绝对路径 / 控制字符 / 非 ASCII / 超长都拒绝', () => {
  const cases = [
    ['', 'EMPTY'],
    [null, 'EMPTY'],
    [undefined, 'EMPTY'],
    [42, 'EMPTY'],
    [{}, 'EMPTY'],
    ['..', 'DOT_SEGMENT'],
    ['.', 'DOT_SEGMENT'],
    ['../逃逸.txt', 'NON_PRINTABLE'], // 中文先撞上非 ASCII，同样是拒绝
    ['../evil.txt', 'DOT_SEGMENT'],
    ['a/../../evil.txt', 'DOT_SEGMENT'],
    ['a/./b.txt', 'DOT_SEGMENT'],
    ['a//b.txt', 'DOT_SEGMENT'],
    ['/abs.txt', 'ABSOLUTE'],
    ['a\\b.txt', 'BACKSLASH'],
    ['..\\..\\evil.txt', 'BACKSLASH'],
    ['C:/evil.txt', 'COLON'],
    ['a:b.txt', 'COLON'],
    ['a\u0000b.txt', 'NON_PRINTABLE'],
    ['a\nb.txt', 'NON_PRINTABLE'],
    ['书.txt', 'NON_PRINTABLE'],
    ['a'.repeat(MAX_ENTRY_NAME_BYTES + 1), 'TOO_LONG'],
    ['a/'.repeat(200) + 'x.txt', 'TOO_LONG']
  ];
  for (const [name, problem] of cases) {
    assert.equal(entryNameProblem(name), problem, JSON.stringify(name));
    assert.throws(() => assertEntryName(name), new RegExp(`ZIP 条目名不合法（${problem}）`));
  }
});

test('条目名闸门：报错信息只带原因码，不回显敌意名字（不把控制字符写进日志）', () => {
  const hostile = '../../秘密\u0007名.txt';
  let error = null;
  try {
    assertEntryName(hostile);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes('ZIP 条目名不合法（NON_PRINTABLE）'), error.message);
  assert.ok(!error.message.includes('秘密'), error.message);
  assert.ok(!error.message.includes('\u0007'), JSON.stringify(error.message));
});

test('buildZip：敌意条目名直接抛错，不返回半个包', () => {
  assert.throws(
    () => buildZip([{ name: '../逃逸.txt', data: 'x' }]),
    /ZIP 条目名不合法/
  );
  assert.throws(
    () => buildZip([{ name: 'ok.txt', data: 'x' }, { name: 'a/../../evil.txt', data: 'y' }]),
    /ZIP 条目名不合法/
  );
  assert.throws(() => buildZip([{ data: 'x' }]), /ZIP 条目名不合法（EMPTY）/);
  // 参数不是数组 = 空包（和以前一样，不抛错）
  assert.ok(Buffer.isBuffer(buildZip(null)));
});

test('buildZip：条目数超过 65535 直接报错（不写 zip64，也不产出坏包）', () => {
  const tooMany = Array.from({ length: 0x10000 }, (_, index) => ({ name: `a/${index}.txt`, data: '' }));
  assert.throws(() => buildZip(tooMany), /ZIP 条目太多（上限 65535 项）/);
});

test('buildZip：正常条目能原样读回（store / deflate / 空内容 / CRC）', () => {
  const buffer = buildZip(
    [
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'OEBPS/text/chapter-0001.xhtml', data: '<p>正文'.repeat(30) },
      { name: 'empty.bin', data: Buffer.alloc(0) },
      { name: 'bin.dat', data: Buffer.from([0, 1, 2, 3, 255]) }
    ],
    { date: new Date('2026-11-01T00:00:00Z') }
  );
  const read = readZip(buffer);
  assert.deepEqual(read.names, ['mimetype', 'OEBPS/text/chapter-0001.xhtml', 'empty.bin', 'bin.dat']);
  const byName = new Map(read.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('mimetype').method, 0);
  assert.equal(byName.get('mimetype').data.toString('utf8'), 'application/epub+zip');
  assert.equal(byName.get('OEBPS/text/chapter-0001.xhtml').data.toString('utf8'), '<p>正文'.repeat(30));
  assert.equal(byName.get('empty.bin').size, 0);
  assert.deepEqual([...byName.get('bin.dat').data], [0, 1, 2, 3, 255]);
  // 所有条目名同样过闸门（读回来的包也不会带出可疑名字）
  for (const name of read.names) assert.equal(entryNameProblem(name), '');
});

test('buildZip：同样的内容 + 同样的时间，字节完全一样（固定时间戳没被闸门破坏）', () => {
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'OEBPS/a.xhtml', data: '正文' }
  ];
  const date = new Date('2026-11-01T00:00:00Z');
  assert.deepEqual(buildZip(entries, { date }), buildZip(entries, { date }));
  assert.notDeepEqual(buildZip(entries, { date }), buildZip(entries, { date: new Date('2026-11-02T00:00:00Z') }));
});
