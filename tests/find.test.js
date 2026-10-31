const test = require('node:test');
const assert = require('node:assert/strict');
const { findMatches, countMatches, replaceAllLiteral, makeSnippet, findNextMatch } = require('../core/find');

test('查找：字面量匹配、多个结果、中文与英文', () => {
  assert.deepEqual(findMatches('阿明说：阿明走了', '阿明').map((m) => m.index), [0, 4]);
  assert.equal(countMatches('aaa', 'aa'), 1, '不重叠匹配');
  assert.deepEqual(findMatches('Hello World', 'world'), [{ index: 6, length: 5 }], '默认不区分大小写');
  assert.deepEqual(findMatches('Hello World', 'world', { caseSensitive: true }), []);
  assert.deepEqual(findMatches('Hello World', 'World', { caseSensitive: true }), [{ index: 6, length: 5 }]);
  assert.deepEqual(findMatches('任意文本', ''), [], '空查询返回空');
  assert.deepEqual(findMatches('', '阿明'), []);
});

test('查找：不搞正则，特殊字符按字面量处理', () => {
  const text = '价格 3.14 元 (含税) [备注] a*b';
  assert.equal(countMatches(text, '3.14'), 1);
  assert.equal(countMatches(text, '(含税)'), 1);
  assert.equal(countMatches(text, '[备注]'), 1);
  assert.equal(countMatches(text, 'a*b'), 1);
  assert.equal(countMatches(text, '.*'), 0, '正则元字符不能当通配符');
});

test('替换：全部替换、保留原文其余内容、次数正确', () => {
  const res = replaceAllLiteral('阿明说：阿明走了。', '阿明', '小明');
  assert.equal(res.text, '小明说：小明走了。');
  assert.equal(res.count, 2);

  const none = replaceAllLiteral('没有命中', '阿明', '小明');
  assert.equal(none.text, '没有命中');
  assert.equal(none.count, 0);
});

test('替换：区分大小写开关、删除（替换成空串）', () => {
  assert.equal(replaceAllLiteral('Foo foo FOO', 'foo', 'x').text, 'x x x');
  assert.equal(
    replaceAllLiteral('Foo foo FOO', 'foo', 'x', { caseSensitive: true }).text,
    'Foo x FOO'
  );
  assert.equal(replaceAllLiteral('阿明阿明', '阿明', '').text, '');
});

test('替换：特殊字符不会破坏文本', () => {
  const res = replaceAllLiteral('3.14 元，价格 3.14', '3.14', '3.15');
  assert.equal(res.text, '3.15 元，价格 3.15');
});

test('上下文片段：去掉换行、头尾省略标记', () => {
  const text = '第一段\n阿明走进屋里，看见桌上有一封信。';
  const index = text.indexOf('阿明');
  const snippet = makeSnippet(text, index, 2, 6);
  assert.equal(snippet.match, '阿明');
  assert.ok(snippet.before.includes('第一段'), '跨行的前后文会被压成空格');
  assert.ok(!snippet.before.includes('\n'));
  const tail = makeSnippet('短句', 0, 1, 50);
  assert.equal(tail.ellipsisStart, false);
  assert.equal(tail.ellipsisEnd, false);
});

test('替换这一处：从光标位置往后找下一处（光标落在命中内部时算这一处）', () => {
  const text = '阿明走了，阿明回头，阿明笑了。';
  const first = findNextMatch(text, '阿明', 0);
  assert.equal(first.index, 0, '第 1 处');
  assert.equal(first.total, 3);
  assert.deepEqual(first.match, { index: 0, length: 2 });

  const second = findNextMatch(text, '阿明', 5); // 第 1 处之后
  assert.equal(second.index, 1, '第 2 处');
  assert.equal(second.match.index, 5);

  const inside = findNextMatch(text, '阿明', 6); // 光标正好在第 2 处里面
  assert.equal(inside.index, 1);
  assert.equal(inside.match.index, 5);

  assert.equal(findNextMatch(text, '阿明', text.length), null, '文末之后没有下一处');
  assert.equal(findNextMatch(text, '不存在', 0), null);
  assert.equal(findNextMatch('', '阿明', 0), null);
});

test('替换这一处：沿用字面量与大小写策略', () => {
  assert.equal(findNextMatch('Foo foo', 'foo', 0).index, 0);
  const sensitive = findNextMatch('Foo foo', 'foo', 0, { caseSensitive: true });
  assert.equal(sensitive.index, 0, '区分大小写时只有一处命中');
  assert.equal(sensitive.match.index, 4);
  assert.equal(findNextMatch('价格 3.14 元', '3.14', 0).match.index, 3);
  // 越界/非法 fromIndex：负数按 0；超过文末按「后面没有了」处理
  assert.equal(findNextMatch('阿明阿明', '阿明', -10).index, 0);
  assert.equal(findNextMatch('阿明阿明', '阿明', 999), null);
});
