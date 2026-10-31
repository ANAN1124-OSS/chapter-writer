const test = require('node:test');
const assert = require('node:assert/strict');
const proofread = require('../core/proofread');
const format = require('../core/format');

const only = (result, rule) => result.issues.filter((issue) => issue.rule === rule);

test('校对：干净正文不报任何问题（单空行不算多余空行）', () => {
  const result = proofread.proofreadText('　　风从海面吹来。\n\n他收起了帆。');
  assert.equal(result.total, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.paragraphs, 2);
  assert.equal(result.chars, 13);
  assert.equal(result.truncated, false);
  for (const rule of proofread.RULE_ORDER) assert.equal(result.byRule[rule], 0);
});

test('校对：空文本 / null / 纯空白都安全', () => {
  for (const input of ['', null, undefined, '   ']) {
    const result = proofread.proofreadText(input);
    assert.equal(result.total, 0);
    assert.deepEqual(result.issues, []);
    assert.equal(result.chars, 0);
  }
});

test('校对：半角标点残留只报告、给出原字符和建议字符', () => {
  const text = '他说,你好.';
  const result = proofread.proofreadText(text);
  const issues = only(result, 'halfwidth-punct');
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.index), [2, 5]);
  assert.deepEqual(issues.map((issue) => issue.match), [',', '.']);
  assert.equal(issues[0].message, '半角标点「,」建议改成「，」');
  assert.equal(issues[1].message, '半角标点「.」建议改成「。」');
  assert.equal(issues[0].line, 1);
  assert.equal(issues[0].column, 3);
  assert.equal(issues[0].ruleLabel, '半角标点');
  // 只报告：原文一个字都没被改（函数纯，返回值里也不带改后的正文）
  assert.equal(result.issues.some((issue) => 'text' in issue), false);
});

test('校对：数字 / 时间 / 网址 / 英文缩写里的半角标点不误报', () => {
  const text = '版本 3.14，时间 12:30，网址 www.a.com，缩写 A.开头，价格 1,000 元。';
  const result = proofread.proofreadText(text);
  assert.equal(only(result, 'halfwidth-punct').length, 0);
});

test('校对：半角标点判定与 format.convertPunct / formatText 完全一致', () => {
  const lines = [
    '他说,"你好"。',
    '价格3.14元,时间12:30,他笑了.',
    '什么?!这也行...',
    'Hello, world. 这句话没有中文标点?',
    '他问:「真的吗?」然后走了.'
  ];
  for (const line of lines) {
    let count = 0;
    const positions = [];
    format.convertPunct(line, (index) => {
      count += 1;
      positions.push(index);
    });
    const direct = format.convertPunct(line);
    assert.equal(count, direct.count);
    const result = proofread.proofreadText(line);
    const issues = only(result, 'halfwidth-punct');
    assert.equal(issues.length, direct.count, line);
    assert.deepEqual(issues.map((issue) => issue.index), positions, line);
    assert.equal(format.formatText(line, { indent: 'none', blankLines: 'keep' }).stats.punctFixed, direct.count);
  }
});

test('校对：超长段落按去空白后的字数判断，阈值可调', () => {
  const long = '字'.repeat(501);
  const result = proofread.proofreadText(long);
  const issues = only(result, 'long-paragraph');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, '这一段 501 字（超过 500 字）');
  assert.equal(issues[0].index, 0);
  assert.equal(issues[0].length, 501);
  assert.equal(issues[0].match, long.slice(0, 24));

  const atLimit = proofread.proofreadText('字'.repeat(500));
  assert.equal(only(atLimit, 'long-paragraph').length, 0);

  const custom = proofread.proofreadText('字'.repeat(80), { longParagraph: 50 });
  assert.equal(only(custom, 'long-paragraph').length, 1);
  assert.equal(only(custom, 'long-paragraph')[0].message, '这一段 80 字（超过 50 字）');
});

test('校对：超长段落的字数不含缩进和行尾空白', () => {
  const text = `　　${'字'.repeat(499)}   `;
  const result = proofread.proofreadText(text, { longParagraph: 500 });
  assert.equal(only(result, 'long-paragraph').length, 0);
  const longer = proofread.proofreadText(`　　${'字'.repeat(501)}   `, { longParagraph: 500 });
  assert.equal(only(longer, 'long-paragraph').length, 1);
});

test('校对：重复用词——300 字内同一双字词出现 3 次才报', () => {
  const text = '突然，他停下。突然，他回头。突然，他笑了。';
  const result = proofread.proofreadText(text);
  const issues = only(result, 'repeat-word');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].match, '突然');
  assert.equal(issues[0].count, 3);
  assert.equal(issues[0].window, 300);
  assert.equal(issues[0].message, '「突然」在 300 字内出现 3 次');
  assert.equal(issues[0].index, text.indexOf('突然'));
});

test('校对：重复用词——只出现 2 次不报，窗口内凑不满 3 次也不报', () => {
  const twice = proofread.proofreadText('他突然笑了，然后又突然停下。');
  assert.equal(only(twice, 'repeat-word').filter((issue) => issue.match === '突然').length, 0);

  const filler = (n) => Array.from({ length: n }, (_v, i) => String.fromCharCode(0x4e00 + ((i * 97) % 900))).join('');
  const spread = `突然${filler(150)}突然${filler(150)}突然`;
  const narrow = proofread.proofreadText(spread, { repeatWindow: 300 });
  assert.equal(narrow.issues.filter((issue) => issue.match === '突然').length, 0);
  const wide = proofread.proofreadText(spread, { repeatWindow: 500 });
  assert.equal(wide.issues.filter((issue) => issue.match === '突然').length, 1);
});

test('校对：重复用词——重叠命中不重复计数（「哈哈哈哈」不算 3 次）', () => {
  const four = proofread.proofreadText('哈哈哈哈');
  assert.equal(four.issues.filter((issue) => issue.match === '哈哈').length, 0);
  const eight = proofread.proofreadText('哈哈哈哈哈哈哈哈');
  const hits = eight.issues.filter((issue) => issue.match === '哈哈');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 4);
});

test('校对：重复用词——count 是窗口内的实际次数，repeatCount 可调', () => {
  const text = '突然突然突然突然，他站住了。';
  const result = proofread.proofreadText(text, { repeatCount: 4 });
  const hits = result.issues.filter((issue) => issue.match === '突然');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 4);
  assert.equal(proofread.proofreadText(text, { repeatCount: 5 }).issues.filter((i) => i.match === '突然').length, 0);
});

test('校对：重复用词只在段落内部找，跨段落拼起来的相同双字词不算', () => {
  const text = '突然\n突然\n突然';
  const result = proofread.proofreadText(text);
  assert.equal(result.issues.filter((issue) => issue.match === '突然').length, 0);
});

test('校对：重复用词——重叠二字词只报一次（「突然想起」×3 不刷三条）', () => {
  const text = '突然想起母亲，突然想起父亲，突然想起那年夏天。';
  const result = proofread.proofreadText(text);
  const hits = result.issues.filter((issue) => issue.rule === 'repeat-word');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, '突然');
  assert.equal(hits[0].count, 3);
});

test('校对：连续标点——3 个及以上才报，「！？」「……」「——」不误报', () => {
  const three = proofread.proofreadText('他喊：「？！？」');
  const issues = only(three, 'punct-run');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].match, '？！？');
  assert.equal(issues[0].message, '连续 3 个标点「？！？」');

  assert.equal(only(proofread.proofreadText('他喊：「！？」'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('他……没说完。'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('他——没说完。'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('「？？？」'), 'punct-run').length, 1);
  assert.equal(only(proofread.proofreadText('「！！！」'), 'punct-run').length, 1);
  // 连排省略号算一个单位：两个单位不报，三个单位（……？！）报
  assert.equal(only(proofread.proofreadText('「……？！」'), 'punct-run').length, 1);
  // 不跨行
  assert.equal(only(proofread.proofreadText('？\n？\n？'), 'punct-run').length, 0);
});

test('校对：多余空行——2 个及以上连续空行才报，单个空行不报', () => {
  const single = proofread.proofreadText('第一段。\n\n第二段。');
  assert.equal(only(single, 'blank-lines').length, 0);

  const double = proofread.proofreadText('第一段。\n\n\n第二段。');
  const issues = only(double, 'blank-lines');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].count, 2);
  assert.equal(issues[0].message, '这里有 2 个连续空行');
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].snippet.match, '2 个空行');
  assert.equal(issues[0].snippet.before, '第一段。');
  assert.equal(issues[0].snippet.after, '第二段。');

  // 只有全角空格「空行（含缩进）」，本身是 1 个空行，不报
  assert.equal(only(proofread.proofreadText('甲。\n　　\n乙。'), 'blank-lines').length, 0);
  assert.equal(only(proofread.proofreadText('甲。\n　　\n　　\n乙。'), 'blank-lines').length, 1);
});

test('校对：开头 / 结尾的连续空行也会报出来', () => {
  const leading = proofread.proofreadText('\n\n正文。');
  const leadIssues = only(leading, 'blank-lines');
  assert.equal(leadIssues.length, 1);
  assert.equal(leadIssues[0].index, 0);
  assert.equal(leadIssues[0].snippet.before, '');

  const trailing = proofread.proofreadText('正文。\n\n\n');
  assert.equal(only(trailing, 'blank-lines').length, 1);
});

test('校对：CRLF / CR / BOM 归一成 LF 后再定位，位置能直接在编辑区选中', () => {
  const text = '\uFEFF他说,好。\r\n\r\n\r\n下一段。';
  const result = proofread.proofreadText(text);
  const normalized = '他说,好。\n\n\n下一段。';
  const comma = result.issues.find((issue) => issue.rule === 'halfwidth-punct');
  assert.equal(comma.index, 2);
  assert.equal(normalized.slice(comma.index, comma.index + comma.match.length), comma.match);
  const blanks = result.issues.find((issue) => issue.rule === 'blank-lines');
  assert.equal(blanks.line, 2);
  assert.equal(normalized.slice(blanks.index, blanks.index + blanks.match.length), blanks.match);
});

test('校对：每条结果的 match 都能在原文对应位置原样取到', () => {
  const text = '第一段,这里有问题。突然，突然，突然。\n\n\n他问：「？！？」\n结尾。';
  const normalized = text.replace(/\r\n?/g, '\n');
  const result = proofread.proofreadText(text);
  assert.ok(result.issues.length >= 4);
  for (const issue of result.issues) {
    if (!issue.match) continue;
    assert.equal(
      normalized.slice(issue.index, issue.index + issue.match.length),
      issue.match,
      `${issue.rule} @${issue.index}`
    );
  }
});

test('校对：结果按位置排序，同位置按规则顺序', () => {
  const result = proofread.proofreadText('他说,好。\n\n\n？？？');
  const indexes = result.issues.map((issue) => issue.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test('校对：1 基行号 / 列号正确（缩进也算列）', () => {
  const text = '第一行。\n　　第二行,这里有逗号。';
  const result = proofread.proofreadText(text);
  const issue = result.issues.find((item) => item.rule === 'halfwidth-punct');
  assert.equal(issue.line, 2);
  assert.equal(issue.column, 6);
});

test('校对：超量时只保留前 maxIssues 条，但总数与各规则条数照实统计', () => {
  const text = '他,'.repeat(300);
  const result = proofread.proofreadText(text, { maxIssues: 20, longParagraph: 2000 });
  assert.equal(result.issues.length, 20);
  assert.equal(result.total, 300);
  assert.equal(result.byRule['halfwidth-punct'], 300);
  assert.equal(result.truncated, true);
  // 保留下来的仍是排好序的前 20 条
  assert.deepEqual(
    result.issues.map((issue) => issue.index),
    Array.from({ length: 20 }, (_v, i) => i * 2 + 1)
  );
});

test('校对：选项清洗——脏值回落默认、越界夹紧、字符串数字可用', () => {
  assert.deepEqual(proofread.sanitizeOptions(undefined), { ...proofread.DEFAULT_OPTIONS });
  assert.deepEqual(proofread.sanitizeOptions(null), { ...proofread.DEFAULT_OPTIONS });
  assert.deepEqual(proofread.sanitizeOptions('不是对象'), { ...proofread.DEFAULT_OPTIONS });
  const clamped = proofread.sanitizeOptions({
    longParagraph: 1,
    repeatWindow: 999999,
    repeatCount: 1,
    maxIssues: 0
  });
  assert.equal(clamped.longParagraph, 50);
  assert.equal(clamped.repeatWindow, 5000);
  assert.equal(clamped.repeatCount, 2);
  assert.equal(clamped.maxIssues, 20);
  const strings = proofread.sanitizeOptions({
    longParagraph: '600',
    repeatWindow: '120',
    repeatCount: '4',
    maxIssues: '30'
  });
  assert.deepEqual(strings, { longParagraph: 600, repeatWindow: 120, repeatCount: 4, maxIssues: 30 });
  assert.deepEqual(proofread.sanitizeOptions({ longParagraph: NaN }), { ...proofread.DEFAULT_OPTIONS });
});

test('校对：同样的输入结果完全一致（纯函数、可回归）', () => {
  const text = '他说,好。突然，突然，突然。\n\n\n「？！？」';
  const a = proofread.proofreadText(text);
  const b = proofread.proofreadText(text);
  assert.deepEqual(a, b);
  const options = { longParagraph: 100 };
  proofread.proofreadText(text, options);
  assert.deepEqual(options, { longParagraph: 100 }, '不修改调用方传进来的选项对象');
});

test('校对：上下文片段带前后文，mark 部分是命中的原文', () => {
  const text = '前面还有一点文字,这里出了问题，后面也还有一点文字。';
  const result = proofread.proofreadText(text);
  const issue = result.issues.find((item) => item.rule === 'halfwidth-punct');
  assert.equal(issue.snippet.match, ',');
  assert.ok(issue.snippet.before.endsWith('文字'));
  assert.ok(issue.snippet.after.startsWith('这里出了问题'));
});

test('校对：自定义词表——命中位置 / 建议 / 行号列号 / 按规则统计', () => {
  const text = '他做为旁观者。\n他决定做为见证人。\n这里有两个禁词和禁词。';
  const entries = [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' },
    { term: '做为', suggestion: '当作' }
  ];
  const result = proofread.proofreadText(text, {}, entries);
  assert.equal(result.customWordCount, 2, '重复的词只算一个（保留第一次的建议）');
  assert.equal(result.byRule['custom-word'], 4);
  const custom = only(result, 'custom-word');
  assert.deepEqual(
    custom.map((issue) => [issue.match, issue.suggestion, issue.index, issue.line, issue.column]),
    [
      ['做为', '作为', 1, 1, 2],
      ['做为', '作为', 11, 2, 4],
      ['禁词', '', 23, 3, 6],
      ['禁词', '', 26, 3, 9]
    ]
  );
  assert.equal(custom[0].ruleLabel, '自定义词表');
  assert.equal(custom[0].message, '词表里的「做为」建议改成「作为」');
  assert.equal(custom[2].message, '命中校对词表里的「禁词」');
  assert.equal(custom[0].length, 2);
  assert.ok(custom[0].snippet.match === '做为');
  // 只报告：原文没有被改
  assert.equal(text, '他做为旁观者。\n他决定做为见证人。\n这里有两个禁词和禁词。');
});

test('校对：没有校对词表时只有内置五条规则，行为与以前一致', () => {
  const text = '他说,好。突然，突然，突然。';
  const withNothing = proofread.proofreadText(text);
  const withEmpty = proofread.proofreadText(text, {}, []);
  assert.deepEqual(withNothing, withEmpty);
  assert.equal(withNothing.customWordCount, 0);
  assert.equal(withNothing.byRule['custom-word'], 0);
  assert.equal(proofread.RULE_ORDER[proofread.RULE_ORDER.length - 1], 'custom-word');
  assert.equal(proofread.RULE_LABELS['custom-word'], '自定义词表');
  // 脏词条被忽略，不会把函数弄崩
  const dirty = proofread.proofreadText(text, {}, [null, 42, { term: '' }, '好']);
  assert.equal(dirty.customWordCount, 1);
  assert.equal(dirty.byRule['custom-word'], 1);
});

test('校对：同一处既有内置规则又有词表命中时按位置排序（同位置内置规则在前）', () => {
  const text = '他说,好。';
  const result = proofread.proofreadText(text, {}, [{ term: ',', suggestion: '，' }]);
  const atComma = result.issues.filter((issue) => issue.index === 2);
  assert.deepEqual(
    atComma.map((issue) => issue.rule),
    ['halfwidth-punct', 'custom-word']
  );
  assert.equal(result.total, 2);
});

test('校对：词表命中重叠时只报最长的那个，不受词表顺序影响', () => {
  const text = '这里有色情小说和色情图片。';
  const entries = [
    { term: '色情', suggestion: '' },
    { term: '色情小说', suggestion: '成人小说' }
  ];
  const result = proofread.proofreadText(text, {}, entries);
  assert.deepEqual(
    only(result, 'custom-word').map((issue) => [issue.match, issue.index, issue.suggestion]),
    [
      ['色情小说', 3, '成人小说'],
      ['色情', 8, '']
    ]
  );
});

test('校对：词表命中同样受 maxIssues 限制，总数照实统计', () => {
  // 用英文字母构造：只命中词表，不会顺手触发「重复用词」等中文规则
  const text = 'a'.repeat(50);
  const result = proofread.proofreadText(text, { maxIssues: 20 }, [{ term: 'a', suggestion: '' }]);
  assert.equal(result.total, 50);
  assert.equal(result.byRule['custom-word'], 50);
  assert.equal(result.issues.length, 20);
  assert.equal(result.truncated, true);
});

test('校对：带词表时结果仍可回归，且不修改调用方数组', () => {
  const entries = [{ term: '做为', suggestion: '作为' }];
  const copy = JSON.parse(JSON.stringify(entries));
  const text = '他做为见证人。';
  const a = proofread.proofreadText(text, {}, entries);
  const b = proofread.proofreadText(text, {}, entries);
  assert.deepEqual(a, b);
  assert.deepEqual(entries, copy);
});
