// 导出简繁转换（v0.8 P0 N7）：内置字表 + 常见词纠正 + 只转换传入的字符串。
// 不读盘、不写盘、不依赖 Electron；只测 core/s2t.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const s2t = require('../core/s2t');

test('简繁字表：没有写错的词条、没有同一字两种写法、没有反推冲突', () => {
  assert.deepEqual(s2t.INVALID_PAIRS, [], '每个词条必须是两个不同的字符');
  assert.deepEqual(s2t.PAIR_CONFLICTS, [], '同一个字不能既转 A 又转 B');
  assert.deepEqual(s2t.T2S_CONFLICTS, [], '繁→简反推与补充字表不能冲突');
  // 字表够不够用：只做常用字，但也不能少得离谱（少于 800 个就没法用）
  assert.ok(s2t.S2T_SIZE >= 800, `简→繁字表太小：${s2t.S2T_SIZE}`);
  assert.ok(s2t.T2S_SIZE >= s2t.S2T_SIZE, `繁→简字表应覆盖反推：${s2t.T2S_SIZE}`);
  // 每条短语等长（转换前后字数不变），且没有从空串开始的词条
  for (const [from, to] of [...s2t.S2T_PHRASES, ...s2t.T2S_PHRASES]) {
    assert.ok(from.length > 0, '短语不能为空');
    assert.equal(from.length, to.length, `短语长度不一致：${from}=${to}`);
  }
  // 抽查几个最常用的字 / 词，防止字表被误删
  for (const pair of ['说說', '门門', '国國', '时時', '发發', '后後', '里裡', '台臺']) {
    assert.ok(s2t.S2T_PAIRS.includes(pair), `字表缺少 ${pair}`);
  }
});

test('简繁档位：只认空串 / s2t / t2s，其它值都当「不转换」', () => {
  assert.equal(s2t.normalizeMode(''), '');
  assert.equal(s2t.normalizeMode('s2t'), 's2t');
  assert.equal(s2t.normalizeMode('t2s'), 't2s');
  assert.equal(s2t.normalizeMode('S2T'), '', '大小写不认');
  assert.equal(s2t.normalizeMode('t2s '), '', '不做 trim 猜测');
  assert.equal(s2t.normalizeMode(null), '');
  assert.equal(s2t.normalizeMode(undefined), '');
  assert.equal(s2t.normalizeMode(123), '');
  assert.equal(s2t.normalizeMode('zh-tw'), '');

  assert.equal(s2t.isEnabled('s2t'), true);
  assert.equal(s2t.isEnabled('t2s'), true);
  assert.equal(s2t.isEnabled(''), false);
  assert.equal(s2t.isEnabled('bad'), false);

  assert.equal(s2t.modeLabel(''), '不转换');
  assert.equal(s2t.modeLabel('s2t'), '简体 → 繁体');
  assert.equal(s2t.modeLabel('t2s'), '繁体 → 简体');
  assert.equal(s2t.modeLabel('bad'), '不转换');
});

test('不转换 / 坏输入：原样返回，非字符串按空串处理', () => {
  const text = '后来他发现门后说话的人。\r\n\r\n第二段\uFEFF';
  assert.equal(s2t.convertText(text, ''), text, '不转换时逐字符不变');
  assert.equal(s2t.convertText(text, 'bad'), text, '坏档位不猜，按不转换');
  assert.equal(s2t.convertText(text, undefined), text);
  assert.equal(s2t.convertText('', 's2t'), '', '空串还是空串');
  assert.equal(s2t.convertText(undefined, 's2t'), '');
  assert.equal(s2t.convertText(null, 't2s'), '');
  assert.equal(s2t.convertText(123, 's2t'), '');
});

test('简 → 繁：常用字、词组纠正、标点换行都不动', () => {
  const input = '后来他发现，门后说话的人头发干净，计划着怎么收获，什么也没有。';
  const expected = '後來他發現，門後說話的人頭髮乾淨，計劃著怎麼收穫，什麼也沒有。';
  assert.equal(s2t.convertText(input, 's2t'), expected);

  // 一简对多繁的常见词：短语表纠正（头发 / 髮，干净 / 乾，皇后 / 后）
  assert.equal(s2t.convertText('头发', 's2t'), '頭髮');
  assert.equal(s2t.convertText('理发师给白发老人剪头发', 's2t'), '理髮師給白髮老人剪頭髮');
  assert.equal(s2t.convertText('皇后和太后在后宫', 's2t'), '皇后和太后在後宮');
  assert.equal(s2t.convertText('地面上面有条面条', 's2t'), '地面上面有條麵條');
  assert.equal(s2t.convertText('一只猫和一只狗', 's2t'), '一隻貓和一隻狗');
  assert.equal(s2t.convertText('关系很好，联系不上', 's2t'), '關係很好，聯繫不上');
  assert.equal(s2t.convertText('乾隆年间很干净', 's2t'), '乾隆年間很乾淨');
  assert.equal(s2t.convertText('稻田里种稻谷', 's2t'), '稻田裡種稻穀');
  assert.equal(s2t.convertText('他舍不得走，施舍了一点钱', 's2t'), '他捨不得走，施捨了一點錢');

  // 空白 / 数字 / 英文 / 标点 / 换行原样保留
  const mixed = '第1章　Hello, world!\r\n\t（测试）……「引号」';
  const converted = s2t.convertText(mixed, 's2t');
  assert.equal(converted, '第1章　Hello, world!\r\n\t（測試）……「引號」');
  assert.equal(converted.length, mixed.length, '转换前后长度不变');
});

test('简 → 繁：歧义字不硬转，短语没覆盖就保持原样（宁可不转，也不转错）', () => {
  // 这些字在繁体里另有写法，字表故意不收；单独出现时保持原样
  const ambiguous = '只 系 面 余 谷 舍 志 制 表 松 向 周 采 游 折 征 致 占 注 卷 刮 胡 回 家 克 困 累 蒙 佣 秋 姜 郁 丑';
  assert.equal(s2t.convertText(ambiguous, 's2t'), ambiguous);
  // 但常用词由短语表覆盖
  assert.equal(s2t.convertText('只有一只船', 's2t'), '只有一隻船');
  assert.equal(s2t.convertText('计划周末旅游', 's2t'), '計劃週末旅遊');
  assert.equal(s2t.convertText('制作复杂的表格', 's2t'), '製作複雜的表格');
  assert.equal(s2t.convertText('松树很轻松', 's2t'), '松樹很輕鬆');
  assert.equal(s2t.convertText('着急的著作', 's2t'), '著急的著作');
  // 字表里没有的字（生僻字 / 繁体本字 / 表情）原样保留
  assert.equal(s2t.convertText('龘𠮷😀', 's2t'), '龘𠮷😀');
});

test('繁 → 简：多对一映射、语境例外、常见词', () => {
  const input = '後來他發現，門後說話的人頭髮乾淨，計劃著怎麼收穫，什麼也沒有。';
  const expected = '后来他发现，门后说话的人头发干净，计划着怎么收获，什么也没有。';
  assert.equal(s2t.convertText(input, 't2s'), expected);

  // 多对一：發 / 髮 都变回 发
  assert.equal(s2t.convertText('白髮 and 發現', 't2s'), '白发 and 发现');
  // 语境例外：著作 / 著名 / 乾隆 保持原样，动词「著」按短语改「着」
  assert.equal(s2t.convertText('他的著作很著名，乾隆年间', 't2s'), '他的著作很著名，乾隆年间');
  assert.equal(s2t.convertText('他看著我，坐著不動', 't2s'), '他看着我，坐着不动');
  assert.equal(s2t.convertText('瞭解、明瞭、瞭望', 't2s'), '了解、明了、瞭望');
  assert.equal(s2t.convertText('藉口和憑藉', 't2s'), '借口和凭借');
  assert.equal(s2t.convertText('穿著、計畫、傢俱、規畫', 't2s'), '穿着、计划、家具、规划');
  assert.equal(s2t.convertText('週末、一隻、麵條、穀物、輕鬆、剩餘', 't2s'), '周末、一只、面条、谷物、轻松、剩余');
  // 空白 / 数字 / 英文 / 标点 / 换行原样保留
  const mixed = '第1章　Hello, world!\r\n\t（測試）……「引號」';
  assert.equal(s2t.convertText(mixed, 't2s'), '第1章　Hello, world!\r\n\t（测试）……「引号」');
});

test('简繁互转：无歧义句子来回一致，长度始终不变', () => {
  const simplified = '后来他发现门后说话的人头发干净，什么也没有。';
  const traditional = s2t.convertText(simplified, 's2t');
  assert.equal(traditional, '後來他發現門後說話的人頭髮乾淨，什麼也沒有。');
  assert.equal(s2t.convertText(traditional, 't2s'), simplified, '来回转换回到原文');
  assert.equal(traditional.length, simplified.length, '长度不变（字数统计不受影响）');
  // 长文本也保持长度不变（含换行 / 标点 / 数字）
  const long = `${simplified}\r\n`.repeat(200);
  const convertedLong = s2t.convertText(long, 's2t');
  assert.equal(convertedLong.length, long.length);
  assert.equal((convertedLong.match(/\r\n/g) || []).length, 200, '换行没有被吞掉');
});

test('书目显示字段：书名 / 章名 / 卷名跟着转，id / 文件名 / 结构字段不动', () => {
  const meta = {
    id: 'book-1',
    title: '门后的人',
    schemaVersion: 1,
    chapters: [
      { id: 'c1', file: '001.txt', name: '开端', chars: 12 },
      { id: 'c2', file: '002.txt', name: '', chars: 0 },
      { id: 'c3', file: '003.txt', name: '说话', chars: 0 }
    ],
    volumes: [
      { id: 'v1', name: '上卷' },
      { id: 'v2', name: '' }
    ]
  };
  const before = JSON.stringify(meta);
  const converted = s2t.convertMeta(meta, 's2t');
  assert.equal(JSON.stringify(meta), before, '不修改调用方对象');
  assert.equal(converted.title, '門後的人');
  assert.equal(converted.chapters[0].name, '開端');
  assert.equal(converted.chapters[1].name, '', '空章名还是空');
  assert.equal(converted.chapters[2].name, '說話');
  assert.equal(converted.volumes[0].name, '上卷');
  assert.equal(converted.volumes[1].name, '');
  // 结构字段一律不动
  assert.equal(converted.id, 'book-1');
  assert.equal(converted.schemaVersion, 1);
  assert.deepEqual(
    converted.chapters.map((c) => [c.id, c.file, c.chars]),
    [['c1', '001.txt', 12], ['c2', '002.txt', 0], ['c3', '003.txt', 0]]
  );
  assert.deepEqual(converted.volumes.map((v) => v.id), ['v1', 'v2']);

  // 不转换 / 坏输入：原对象直接返回，不复制也不改
  assert.equal(s2t.convertMeta(meta, ''), meta);
  assert.equal(s2t.convertMeta(meta, 'bad'), meta);
  assert.equal(s2t.convertMeta(null, 's2t'), null);
  assert.equal(s2t.convertMeta(undefined, 's2t'), undefined);
  assert.equal(s2t.convertMeta('not-meta', 's2t'), 'not-meta');
  // 缺 chapters / volumes 的旧书目也不崩
  const oldMeta = { id: 'x', title: '旧书' };
  assert.deepEqual(s2t.convertMeta(oldMeta, 't2s'), { id: 'x', title: '旧书' });
});
