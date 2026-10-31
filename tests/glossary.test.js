const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const glossary = require('../core/glossary');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-glossary-'));
}

test('校对词表：每行一个词，可选「错词 → 建议」，三种箭头都认', () => {
  const parsed = glossary.parseGlossary(
    '\uFEFF做为 => 作为\r\n在再 -> 再说\r\n的地得 → 的\r\n禁词\r\n# 注释行\r\n\r\n  做为 => 当作  \r\n'
  );
  assert.deepEqual(parsed.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '在再', suggestion: '再说' },
    { term: '的地得', suggestion: '的' },
    { term: '禁词', suggestion: '' }
  ]);
  assert.equal(parsed.stats.suggestions, 3);
  assert.equal(parsed.stats.comments, 1);
  assert.equal(parsed.stats.duplicates, 1, '同样的词第二次出现只留第一次（建议也保留第一次的）');
  assert.ok(parsed.stats.emptyLines >= 2);
  // 词中间的空格保留（短语也能当一个词）；箭头两侧空格会被去掉
  assert.deepEqual(glossary.parseGlossary('坏 人\n  =>  ').entries, [{ term: '坏 人', suggestion: '' }]);
  assert.deepEqual(glossary.parseGlossary(' \n\t\n\u3000').entries, []);
  assert.deepEqual(glossary.parseGlossary(null).entries, []);
});

test('校对词表：坏行与超长行跳过，5000 条上限标 truncated', () => {
  const lines = ['   => 只有建议没有词  ', '短 => ' + '建'.repeat(101), '长'.repeat(101)];
  for (let i = 0; i < glossary.MAX_ENTRIES + 3; i += 1) lines.push(`词${i}`);
  const parsed = glossary.parseGlossary(lines.join('\n'));
  assert.equal(parsed.stats.invalid, 1);
  assert.equal(parsed.stats.tooLong, 2);
  assert.equal(parsed.entries.length, glossary.MAX_ENTRIES);
  assert.equal(parsed.entries[0].term, '词0');
  assert.equal(parsed.stats.truncated, true);
});

test('校对词表：sanitizeEntries 去空 / 去重 / 限长 / 限量，字符串与对象都收', () => {
  const cleaned = glossary.sanitizeEntries([
    ' 做为 ',
    { term: '禁词', suggestion: '  ' },
    { term: '做为', suggestion: '作为' },
    { term: '', suggestion: 'x' },
    { term: '长'.repeat(101), suggestion: '' },
    { term: '建议太长', suggestion: '建'.repeat(101) },
    { term: 123 },
    null,
    42
  ]);
  assert.deepEqual(cleaned, [
    { term: '做为', suggestion: '' },
    { term: '禁词', suggestion: '' },
    { term: '建议太长', suggestion: '' }
  ]);
  assert.deepEqual(glossary.sanitizeEntries('不是数组'), []);
});

test('校对词表：findHits 字面匹配、按位置排序，同一处只报最长的词', () => {
  const hits = glossary.findHits('他说做为见证人，做为观众。', [
    { term: '做为', suggestion: '作为' },
    { term: '做', suggestion: '' },
    { term: '观众', suggestion: '' }
  ]);
  assert.equal(hits.entryCount, 3);
  assert.equal(hits.truncated, false);
  assert.deepEqual(
    hits.hits.map((hit) => [hit.term, hit.index, hit.length, hit.suggestion]),
    [
      ['做为', 2, 2, '作为'],
      ['做为', 8, 2, '作为'],
      ['观众', 10, 2, '']
    ],
    '「做」和「做为」重叠时只留长的；结果按位置排序'
  );
});

test('校对词表：字面匹配区分大小写、不做正则；CRLF / BOM 归一后位置可直接选中', () => {
  const hits = glossary.findHits('\uFEFF第一行 teh 和 Teh。\r\n第二行 teh。\r\n', [
    { term: 'teh', suggestion: 'the' },
    { term: 'a.c', suggestion: '' }
  ]);
  assert.deepEqual(
    hits.hits.map((hit) => hit.index),
    [4, 19]
  );
  const text = '\uFEFF第一行 teh 和 Teh。\r\n第二行 teh。\r\n';
  assert.equal(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').slice(4, 7), 'teh');
  assert.deepEqual(glossary.findHits('abc', [{ term: 'a.c' }]).hits, []);
});

test('校对词表：没有任何可用词条时安全返回空结果', () => {
  assert.deepEqual(glossary.findHits('正文', []), { hits: [], truncated: false, entryCount: 0 });
  assert.deepEqual(glossary.findHits('正文', null), { hits: [], truncated: false, entryCount: 0 });
  assert.deepEqual(glossary.findHits(null, [{ term: '正' }]), {
    hits: [],
    truncated: false,
    entryCount: 1
  });
});

test('校对词表：解码 UTF-8（含 BOM）/ UTF-16LE / GBK，空 / 二进制 / 坏编码明确拒绝', () => {
  const utf8 = glossary.decodeGlossaryBuffer(Buffer.from('\uFEFF做为 => 作为\n禁词', 'utf8'));
  assert.equal(utf8.ok, true);
  assert.deepEqual(utf8.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ]);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('做为 => 作为\r\n禁词', 'utf16le')]);
  assert.deepEqual(glossary.decodeGlossaryBuffer(utf16).entries, utf8.entries);

  // 「做为 => 作为」的 GBK 字节
  const gbk = glossary.decodeGlossaryBuffer(
    Buffer.from([0xd7, 0xf6, 0xce, 0xaa, 0x20, 0x3d, 0x3e, 0x20, 0xd7, 0xf7, 0xce, 0xaa])
  );
  assert.equal(gbk.ok, true);
  assert.deepEqual(gbk.entries, [{ term: '做为', suggestion: '作为' }]);

  assert.equal(glossary.decodeGlossaryBuffer(Buffer.alloc(0)).code, 'GLOSSARY_EMPTY');
  assert.equal(glossary.decodeGlossaryBuffer(Buffer.from(' \r\n# 只有注释\n', 'utf8')).code, 'GLOSSARY_EMPTY');
  const binary = glossary.decodeGlossaryBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  assert.equal(binary.code, 'GLOSSARY_BAD_ENCODING');
  const broken = glossary.decodeGlossaryBuffer(Buffer.from([0xff, 0xff, 0x0a, 0x41]));
  assert.equal(broken.code, 'GLOSSARY_BAD_ENCODING');
});

test('校对词表：readGlossaryFile 未设置 / 不存在 / 是目录 / 正常文件 都给结构化结果', async () => {
  const notConfigured = await glossary.readGlossaryFile('');
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.code, 'GLOSSARY_NOT_CONFIGURED');
  assert.equal(notConfigured.configured, false);
  assert.equal(notConfigured.count, 0);

  const dir = await mkTmp();
  const missing = await glossary.readGlossaryFile(path.join(dir, '没有这个.txt'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'GLOSSARY_MISSING');
  assert.equal(missing.configured, true);
  assert.ok(missing.message.includes('不存在'));

  const asDir = await glossary.readGlossaryFile(dir);
  assert.equal(asDir.ok, false);
  assert.equal(asDir.code, 'GLOSSARY_NOT_FILE');

  const file = path.join(dir, '校对词表.txt');
  await fs.writeFile(file, '做为 => 作为\r\n禁词\r\n', 'utf8');
  const ok = await glossary.readGlossaryFile(file);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, undefined, '原始结果用 entries 携带内容');
  assert.equal(ok.entries.length, 2);
  assert.equal(ok.name, '校对词表.txt');
  assert.equal(ok.stats.suggestions, 1);
});

test('校对词表：readGlossaryFile 拒绝超过 4MB 与坏编码，提示能看懂', async () => {
  const dir = await mkTmp();
  const big = path.join(dir, '大词表.txt');
  await fs.writeFile(big, Buffer.alloc(glossary.MAX_FILE_BYTES + 1, 0x41));
  const tooBig = await glossary.readGlossaryFile(big);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'GLOSSARY_TOO_BIG');
  assert.ok(tooBig.message.includes('4MB'));

  const bad = path.join(dir, '坏词表.txt');
  await fs.writeFile(bad, Buffer.from([0xff, 0xff, 0x0a, 0x41]));
  const broken = await glossary.readGlossaryFile(bad);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'GLOSSARY_BAD_ENCODING');
  assert.ok(broken.message.includes('UTF-8'));
});

test('校对词表：publicGlossaryInfo 只给数量与状态，不把词表正文带到渲染层', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '词表.txt');
  await fs.writeFile(file, '做为 => 作为\n禁词\n', 'utf8');
  const list = await glossary.readGlossaryFile(file);
  const info = glossary.publicGlossaryInfo(list);
  assert.equal(info.ok, true);
  assert.equal(info.count, 2);
  assert.equal(info.entries, undefined);
  assert.equal(info.stats.suggestions, 1);

  const notConfigured = glossary.publicGlossaryInfo(await glossary.readGlossaryFile(''));
  assert.equal(notConfigured.count, 0);
  const fallback = glossary.publicGlossaryInfo(null);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.count, 0);
});
