const test = require('node:test');
const assert = require('node:assert/strict');
const caretColor = require('../core/caret-color');

test('段落高亮色板：第一项是「跟随主题」，其余都是可存的 #rrggbb 且不重复', () => {
  assert.ok(Array.isArray(caretColor.PRESETS));
  assert.ok(caretColor.PRESETS.length >= 6);
  assert.deepEqual(
    { value: caretColor.PRESETS[0].value, label: caretColor.PRESETS[0].label },
    { value: '', label: '跟随主题' }
  );
  assert.equal(caretColor.PRESET_VALUES.length, caretColor.PRESETS.length - 1);
  assert.equal(new Set(caretColor.PRESET_VALUES).size, caretColor.PRESET_VALUES.length);
  for (const item of caretColor.PRESETS) {
    if (!item.value) continue;
    assert.equal(caretColor.normalizeColor(item.value), item.value);
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
  }
});

test('颜色清洗：空值 / 非字符串 / 坏写法回落「跟随主题」，#rgb 补成 #rrggbb 并小写', () => {
  assert.equal(caretColor.normalizeColor(''), '');
  assert.equal(caretColor.normalizeColor('   '), '');
  assert.equal(caretColor.normalizeColor(null), '');
  assert.equal(caretColor.normalizeColor(undefined), '');
  assert.equal(caretColor.normalizeColor(123), '');
  assert.equal(caretColor.normalizeColor({}), '');
  assert.equal(caretColor.normalizeColor('#abc'), '#aabbcc');
  assert.equal(caretColor.normalizeColor(' #ABC '), '#aabbcc');
  assert.equal(caretColor.normalizeColor('#A1b2C3'), '#a1b2c3');
  assert.equal(caretColor.normalizeColor('#12345'), '');
  assert.equal(caretColor.normalizeColor('#1234567'), '');
  assert.equal(caretColor.normalizeColor('red'), '');
  assert.equal(caretColor.normalizeColor('rgb(1, 2, 3)'), '');
  assert.equal(caretColor.normalizeColor('#gggggg'), '');
});

test('颜色转 rgba：底色淡、左侧细线稍实，数值按颜色分量换算', () => {
  assert.deepEqual(caretColor.hexToRgb('#3f7fbf'), { r: 63, g: 127, b: 191 });
  assert.equal(caretColor.hexToRgb(''), null);
  assert.equal(caretColor.hexToRgb('bad'), null);

  const style = caretColor.caretStyle('#3F7FBF');
  assert.deepEqual(style, {
    color: '#3f7fbf',
    tint: 'rgba(63, 127, 191, 0.16)',
    edge: 'rgba(63, 127, 191, 0.82)'
  });
  assert.equal(caretColor.caretStyle(''), null);
  assert.equal(caretColor.caretStyle(null), null);

  // 3 位写法与 6 位写法换出来必须一样
  assert.deepEqual(caretColor.caretStyle('#abc'), caretColor.caretStyle('#aabbcc'));
});

test('色板定位：能认出预设色，自定义色返回 -1', () => {
  assert.equal(caretColor.presetIndex('#c8873c'), 0);
  assert.equal(caretColor.presetIndex('#3f7fbf'), 1);
  assert.equal(caretColor.presetIndex('#3F7FBF'), 1);
  assert.equal(caretColor.presetIndex('#123456'), -1);
  assert.equal(caretColor.presetIndex(''), -1);
  assert.equal(caretColor.presetIndex(null), -1);
  assert.equal(caretColor.isCustomColor('#3f7fbf'), true);
  assert.equal(caretColor.isCustomColor(''), false);
  assert.equal(caretColor.isCustomColor('nope'), false);
  // 预设色必须都在色板里，接口返回的 tint / edge 都是合法 CSS 颜色
  for (const value of caretColor.PRESET_VALUES) {
    assert.ok(caretColor.presetIndex(value) >= 0);
    const style = caretColor.caretStyle(value);
    assert.match(style.tint, /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.16\)$/);
    assert.match(style.edge, /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.82\)$/);
  }
});
