const test = require('node:test');
const assert = require('node:assert/strict');
const focus = require('../renderer/focus-logic');

test('专注模式：打字机目标比例默认 1/3，坏值回默认、越界夹紧', () => {
  assert.equal(focus.TYPEWRITER_RATIO_DEFAULT, 1 / 3);
  assert.equal(focus.sanitizeRatio(undefined), 1 / 3);
  assert.equal(focus.sanitizeRatio(null), 1 / 3);
  assert.equal(focus.sanitizeRatio('abc'), 1 / 3);
  assert.equal(focus.sanitizeRatio(NaN), 1 / 3);
  assert.equal(focus.sanitizeRatio(0.4), 0.4);
  assert.equal(focus.sanitizeRatio('0.25'), 0.25);
  // 太靠上 / 太靠下都夹到允许范围里
  assert.equal(focus.sanitizeRatio(0), 0.2);
  assert.equal(focus.sanitizeRatio(-1), 0.2);
  assert.equal(focus.sanitizeRatio(5), 0.5);
  // Infinity / 非数字当作「没传」，回默认
  assert.equal(focus.sanitizeRatio(Infinity), 1 / 3);
});

test('专注模式：滚动位置钳到 [0, 可滚动高度]，取整、坏值当 0', () => {
  assert.equal(focus.clampScrollTop(120, 500), 120);
  assert.equal(focus.clampScrollTop(-30, 500), 0);
  assert.equal(focus.clampScrollTop(900, 500), 500);
  assert.equal(focus.clampScrollTop(120.7, 500), 121);
  assert.equal(focus.clampScrollTop('120', 500), 120);
  assert.equal(focus.clampScrollTop('abc', 500), 0);
  assert.equal(focus.clampScrollTop(null, 500), 0);
  assert.equal(focus.clampScrollTop(10, -5), 0);
  assert.equal(focus.clampScrollTop(10, NaN), 0);
});

test('专注模式：光标行在目标 1/3 处时不动（死区内保持原滚动位置）', () => {
  // 视口高 600 → 目标位置 = caretTop - 200；光标行正好在 1/3 处
  const plan = focus.planTypewriterScroll({
    caretTop: 800,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 600
  });
  assert.equal(plan.adjust, false);
  assert.equal(plan.scrollTop, 600);
  assert.equal(plan.target, 600);
  assert.equal(plan.delta, 0);
  assert.equal(plan.ratio, focus.TYPEWRITER_RATIO_DEFAULT);
});

test('专注模式：光标行掉到 1/3 以下 → 把正文往上滚，让这一行回到 1/3', () => {
  const plan = focus.planTypewriterScroll({
    caretTop: 1000,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 600
  });
  // 理想 = 1000 - 200 = 800，比现在多 200
  assert.equal(plan.adjust, true);
  assert.equal(plan.target, 800);
  assert.equal(plan.scrollTop, 800);
  assert.equal(plan.delta, 200);
  // 滚完再看：光标行顶端 - 滚动位置 = 视口 1/3
  assert.equal(1000 - plan.scrollTop, 200);
});

test('专注模式：光标行在 1/3 以上 → 往回滚（比如按 ↑ / 翻到上面）', () => {
  const plan = focus.planTypewriterScroll({
    caretTop: 300,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 600
  });
  assert.equal(plan.adjust, true);
  assert.equal(plan.scrollTop, 100); // 300 - 200
  assert.equal(plan.delta, -500);
});

test('专注模式：死区边界（差 4px 不动，差 5px 才动）', () => {
  const base = {
    caretTop: 805,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 600
  };
  const dead = focus.planTypewriterScroll(base); // 目标 605，差 5（> 死区 4）
  assert.equal(dead.target, 605);
  assert.equal(dead.adjust, true);

  const within = focus.planTypewriterScroll({ ...base, caretTop: 804 }); // 目标 604，差 4
  assert.equal(within.target, 604);
  assert.equal(within.adjust, false);
  assert.equal(within.scrollTop, 600);

  const custom = focus.planTypewriterScroll({ ...base, deadband: 10 });
  assert.equal(custom.adjust, false, '自定义死区 10 时差 5px 不动');
});

test('专注模式：靠近章首时目标为负 → 停在 0（不滚出界）', () => {
  const plan = focus.planTypewriterScroll({
    caretTop: 34,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 480
  });
  assert.equal(plan.target, 0);
  assert.equal(plan.adjust, true);
  assert.equal(plan.scrollTop, 0);
});

test('专注模式：靠近章尾时夹到最大滚动位置（滚不到无处可滚）', () => {
  const plan = focus.planTypewriterScroll({
    caretTop: 9900,
    viewportHeight: 600,
    maxScrollTop: 5000,
    currentScrollTop: 0
  });
  assert.equal(plan.target, 5000);
  assert.equal(plan.scrollTop, 5000);
  assert.equal(plan.adjust, true);
  assert.ok(plan.delta > 0);
});

test('专注模式：量不到光标 / 正文区高度为 0 时什么都不做', () => {
  for (const options of [
    {},
    { caretTop: 500 },
    { caretTop: 500, viewportHeight: 0 },
    { caretTop: 500, viewportHeight: -10 },
    { caretTop: NaN, viewportHeight: 600 },
    { caretTop: undefined, viewportHeight: 600 }
  ]) {
    const plan = focus.planTypewriterScroll({ ...options, maxScrollTop: 1000, currentScrollTop: 120 });
    assert.equal(plan.adjust, false, JSON.stringify(options));
    assert.equal(plan.scrollTop, 120, JSON.stringify(options));
  }
});

test('专注模式：maxScrollTop 坏值当 0（正文不够长时不硬滚）', () => {
  const plan = focus.planTypewriterScroll({
    caretTop: 400,
    viewportHeight: 600,
    maxScrollTop: NaN,
    currentScrollTop: 0
  });
  assert.equal(plan.target, 0);
  assert.equal(plan.adjust, false);
  assert.equal(plan.scrollTop, 0);
});

test('专注模式：超长正文上限 30 万字（和编辑器小件的标记层同一口径）', () => {
  assert.equal(focus.MAX_TYPEWRITER_CHARS, 300000);
});
