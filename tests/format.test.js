const test = require('node:test');
const assert = require('node:assert/strict');
const { formatText, sanitizeOptions, DEFAULT_OPTIONS, convertPunct } = require('../core/format');

const F = (text, options) => formatText(text, options).text;

test('整理：默认规则（缩进两格 + 段间空一行）', () => {
  assert.equal(F('他走进屋。\n\n外面下着雨。'), '　　他走进屋。\n\n　　外面下着雨。');
  assert.equal(F('第一段\n第二段'), '　　第一段\n\n　　第二段');
});

test('整理：空行模式 keep 保持原有空行数、none 不空行', () => {
  assert.equal(F('第一段\n\n\n第二段', { blankLines: 'keep' }), '　　第一段\n\n\n　　第二段');
  assert.equal(F('第一段\n\n第二段', { blankLines: 'keep' }), '　　第一段\n\n　　第二段');
  assert.equal(F('第一段\n\n第二段', { blankLines: 'none' }), '　　第一段\n　　第二段');
});

test('整理：删除行尾空白，上一份/下一份空行不受影响', () => {
  assert.equal(F('　　第一段   \n\n　　第二段\t\n'), '　　第一段\n\n　　第二段\n');
});

test('整理：已有全角缩进不会重复叠加（幂等）', () => {
  const input = '　　第一段\n\n　　第二段\n';
  const once = formatText(input);
  assert.equal(once.text, input);
  assert.equal(once.changed, false);
  assert.equal(once.stats.indentFixed, 0);
  const twice = formatText(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
});

test('整理：半角标点只在中文旁边转全角', () => {
  assert.equal(F('他说,"你好."', { indent: false, blankLines: 'keep' }), '他说，"你好。"');
  assert.equal(F('什么?!', { indent: false, blankLines: 'keep' }), '什么？！');
  // 数字、时间、网址、英文缩写里的半角标点一律不动
  const numeric = '圆周率3.14，时间12:30，网址www.a.com，版本A.开端';
  assert.equal(F(numeric, { indent: false, blankLines: 'keep' }), numeric);
});

test('整理：中英之间的空格默认保留，开启规则后才删中文之间的空格', () => {
  const spaced = '他 说 话';
  assert.equal(F(spaced, { indent: false, blankLines: 'keep' }), spaced);
  assert.equal(
    F(spaced, { indent: false, blankLines: 'keep', removeCjkSpaces: true }),
    '他说话'
  );
  // 缩进用的全角空格不能被当成「中文之间的空格」删掉
  assert.equal(
    F('　　他 说 话', { blankLines: 'keep', removeCjkSpaces: true }),
    '　　他说话'
  );
});

test('整理：正文内部空格不被 trim（除非显式开启删除中文空格）', () => {
  assert.equal(
    F('张三  李四', { indent: false, blankLines: 'keep' }),
    '张三  李四'
  );
});

test('整理：开头/结尾的空行被清掉，结尾换行按原文保留', () => {
  assert.equal(F('\n\n第一段\n\n\n'), '　　第一段\n');
  assert.equal(F('第一段'), '　　第一段');
  assert.equal(F('第一段\n'), '　　第一段\n');
});

test('整理：CRLF / CR 输入统一成 LF', () => {
  assert.equal(F('第一段\r\n\r\n第二段\r\n'), '　　第一段\n\n　　第二段\n');
  assert.equal(F('第一段\r第二段\r'), '　　第一段\n\n　　第二段\n');
});

test('整理：空文本与纯空白文本', () => {
  const empty = formatText('');
  assert.equal(empty.text, '');
  assert.equal(empty.changed, false);
  assert.equal(empty.stats.paragraphs, 0);

  const blanks = formatText('   \n\n\t\n');
  assert.equal(blanks.text, '');
  assert.equal(blanks.changed, true);
});

test('整理：统计数字（缩进 / 行尾空白 / 空行 / 标点）', () => {
  const res = formatText('他说,"你好."\n\n\n第二段  \n');
  assert.equal(res.text, '　　他说，"你好。"\n\n　　第二段\n');
  assert.equal(res.changed, true);
  assert.equal(res.stats.paragraphs, 2);
  assert.equal(res.stats.indentFixed, 2);
  assert.equal(res.stats.trailingTrimmed, 1);
  assert.equal(res.stats.blankCollapsed, 1);
  assert.equal(res.stats.punctFixed, 2);
});

test('整理：全部规则关闭时原样返回', () => {
  const input = '第一段\n\n\n第二段  ';
  const off = {
    indent: false,
    blankLines: 'keep',
    trimTrailing: false,
    normalizePunct: false,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  };
  assert.equal(F(input, off), input);
});

test('整理：单段长正文、英文数字行也能加缩进', () => {
  assert.equal(F('3.14 is pi'), '　　3.14 is pi');
  assert.equal(F('Hello, world'), '　　Hello, world');
});

test('规则清洗：非法值回落到默认', () => {
  assert.deepEqual(sanitizeOptions(null), { ...DEFAULT_OPTIONS });
  assert.deepEqual(sanitizeOptions({ blankLines: 'weird', indent: 1 }), { ...DEFAULT_OPTIONS });
  assert.equal(sanitizeOptions({ blankLines: 'none' }).blankLines, 'none');
  assert.equal(sanitizeOptions({ trimTrailing: 0 }).trimTrailing, false);
  // 兼容旧配置里的布尔缩进
  assert.equal(sanitizeOptions({ indent: true }).indent, '2');
  assert.equal(sanitizeOptions({ indent: false }).indent, 'none');
  assert.equal(sanitizeOptions({ indent: '0' }).indent, '0');
  assert.equal(sanitizeOptions({ blankLines: 'singleIndent' }).blankLines, 'singleIndent');
  // 新增的引号 / 省略号开关默认关
  assert.equal(sanitizeOptions({}).curlyQuotes, false);
  assert.equal(sanitizeOptions({}).ellipsis, false);
  assert.equal(sanitizeOptions({ curlyQuotes: 1, ellipsis: 'yes' }).curlyQuotes, true);
  assert.equal(sanitizeOptions({ curlyQuotes: 1, ellipsis: 'yes' }).ellipsis, true);
});

test('智能排版：段首缩进可选「不处理 / 0 字符 / 2 字符」', () => {
  const indented = '　　第一段\n\n　　第二段';
  assert.equal(F(indented, { indent: 'none', blankLines: 'keep' }), indented);
  assert.equal(F(indented, { indent: '0', blankLines: 'keep' }), '第一段\n\n第二段');
  assert.equal(F('第一段\n\n第二段', { indent: '2' }), '　　第一段\n\n　　第二段');
  // 0 字符：连原来夹在中间的空格也要清掉
  assert.equal(F('  第一段', { indent: '0', blankLines: 'keep' }), '第一段');
  // 不处理：原有缩进原样保留
  assert.equal(F('  第一段', { indent: 'none', blankLines: 'keep' }), '  第一段');
});

test('智能排版：空行「含缩进」（粘贴到吃空行的平台也不塌）', () => {
  assert.equal(
    F('第一段\n\n第二段', { blankLines: 'singleIndent' }),
    '　　第一段\n　　\n　　第二段'
  );
  // 幂等：再整理一次不变
  const once = formatText('第一段\n\n第二段', { blankLines: 'singleIndent' });
  const twice = formatText(once.text, { blankLines: 'singleIndent' });
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
  // 缩进 0 字符时没有缩进可带，退化成普通空行
  assert.equal(F('第一段\n\n第二段', { blankLines: 'singleIndent', indent: '0' }), '第一段\n\n第二段');
  assert.equal(F('第一段\n\n第二段', { blankLines: 'singleIndent', indent: 'none' }), '第一段\n\n第二段');
});

test('标点扩展：直引号默认不动，开启后只在中文语境转弯引号', () => {
  const input = '他说,"你好."';
  // 默认关：引号原样
  assert.equal(F(input, { indent: false, blankLines: 'keep' }), '他说，"你好。"');
  const on = { indent: false, blankLines: 'keep', curlyQuotes: true };
  assert.equal(F(input, on), '他说，“你好。”');
  // 已经转好的不再变（幂等）
  const once = formatText(input, on);
  const twice = formatText(once.text, on);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
  // 统计
  assert.equal(formatText(input, on).stats.quotesFixed, 2);
});

test('标点扩展：英文撇号、英文引语、数字里的直引号不动', () => {
  const on = { indent: false, blankLines: 'keep', curlyQuotes: true };
  assert.equal(F("don't stop", on), "don't stop");
  assert.equal(F('He said "hi"', on), 'He said "hi"');
  assert.equal(F("他说 3'5 寸", on), "他说 3'5 寸");
  // 中文句子里的英文名引号也保持原样（避免把 Jack 的引号改坏）
  assert.equal(F('他叫"Jack"。', on), '他叫"Jack"。');
  // 单引号在中文语境里也能转
  assert.equal(F("她说,'别走.'", on), "她说，‘别走。’");
});

test('标点扩展：省略号默认不动，开启后三个点以上转中文省略号（幂等）', () => {
  const input = '他说..."等等..."';
  // 默认关：省略号仍是三个点（标点规则也不会动它）
  assert.equal(F(input, { indent: false, blankLines: 'keep' }), input);
  const on = { indent: false, blankLines: 'keep', ellipsis: true };
  assert.equal(F(input, on), '他说……"等等……"');
  // 六个点也合成一个中文省略号
  assert.equal(F('他走了......', on), '他走了……');
  // 数字/网址里的点不动
  assert.equal(F('圆周率3.14，网址www.a.com', on), '圆周率3.14，网址www.a.com');
  // 幂等
  const once = formatText(input, on);
  const twice = formatText(once.text, on);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
  // 统计
  assert.equal(formatText(input, on).stats.ellipsisFixed, 2);
});

test('标点扩展：引号 + 省略号 + 全角标点同时开启', () => {
  const res = formatText('他说,"你好..."\n\n第二段', {
    indent: false,
    blankLines: 'keep',
    normalizePunct: true,
    curlyQuotes: true,
    ellipsis: true
  });
  assert.equal(res.text, '他说，“你好……”\n\n第二段');
  assert.equal(res.stats.punctFixed, 1);
  assert.equal(res.stats.quotesFixed, 2);
  assert.equal(res.stats.ellipsisFixed, 1);
});

test('校对用：convertPunct 可选回调只报告位置，不改变转换结果', () => {
  const line = '价格3.14元,时间12:30,他说"好"。';
  const reported = [];
  const withCallback = convertPunct(line, (index, from, to) => reported.push({ index, from, to }));
  const without = convertPunct(line);
  assert.deepEqual(withCallback, without);
  assert.equal(reported.length, without.count);
  assert.deepEqual(reported, [
    { index: 7, from: ',', to: '，' },
    { index: 15, from: ',', to: '，' }
  ]);
  // 回调拿到的是「原串里的位置」，可以直接用来在编辑区选中
  for (const item of reported) assert.equal(line[item.index], item.from);
});

test('校对用：回调不会改变清理规则（数字 / 网址 / 英文里的标点仍不报）', () => {
  const line = '版本 3.14，时间 12:30，网址 www.a.com，缩写 A.开头。';
  let count = 0;
  const res = convertPunct(line, () => {
    count += 1;
  });
  assert.equal(count, 0);
  assert.equal(res.count, 0);
  assert.equal(res.text, line);
});
