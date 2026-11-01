const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configGate = require('../core/config-gate');

// v0.9 C-2b：配置来源校验（C1 安全模型一致性的延伸）。
// 这里锁三件事：
//   1. filterPathPatch 的判定（原值 / 清空 / 刚选中 → 放行；其它一律忽略且只回字段名）；
//   2. 按窗口的「刚选中」登记（隔离 / 覆盖 / 清空 / 关窗清理）；
//   3. 静态闸门：main.js 的 config:set 必须真的过这道校验、三个对话框入口必须记账。
// 真实 Electron 侧的回归在 E2E 第 58 组（伪造路径不生效 + 模拟对话框选中才生效）。

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const ROOT = path.join(os.tmpdir(), 'cw-config-gate-书架');
const bookRoot = path.join(ROOT, '另一个书架');
const wordsA = path.join(ROOT, '词表A.txt');
const wordsB = path.join(ROOT, '词表B.txt');
const outside = path.join(ROOT, '..', '别的目录');

test('配置来源校验：不在名单里的字段原样透传（显示设置 / 统计 / 模板都不受影响）', () => {
  const patch = {
    editorFont: 'sans',
    editorFontSize: 20,
    dailyGoal: 1234,
    chapterTemplate: '第{n}章 {title}',
    formatOptions: { indent: 2 },
    lastExportDir: path.join(ROOT, '导出'),
    bookDisplay: { 某书: { editorPaper: 'night' } }
  };
  const result = configGate.filterPathPatch(patch, { current: {} });
  assert.deepEqual(result.patch, patch);
  assert.deepEqual(result.rejected, []);
});

test('配置来源校验：与原值相同就放行（设置界面每次保存都会原样回传整张表单）', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: wordsA, sensitiveWordsPath: '' };
  // 末尾分隔符 / 大小写 / 正反斜杠混用，都算同一个路径（Windows 口径）
  const sameForms = [
    bookRoot + path.sep,
    bookRoot.toUpperCase(),
    bookRoot.replace(/\\/g, '/'),
    `  ${bookRoot}  `
  ];
  for (const value of sameForms) {
    const result = configGate.filterPathPatch({ booksRoot: value }, { current });
    assert.deepEqual(result.rejected, [], `应当放行：${value}`);
    // 存进配置的是 trim 过的原字符串（不做 resolve，避免改变作者看到的路径写法）
    assert.equal(result.patch.booksRoot, value.trim());
  }
  const unchangedWords = configGate.filterPathPatch({ proofreadWordsPath: wordsA }, { current });
  assert.deepEqual(unchangedWords.rejected, []);
  assert.equal(unchangedWords.patch.proofreadWordsPath, wordsA);
});

test('配置来源校验：清空（空串 / 纯空白）一律放行，交给配置清洗决定最终值', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: wordsA, sensitiveWordsPath: wordsB };
  for (const value of ['', '   ', '\t']) {
    const result = configGate.filterPathPatch({ sensitiveWordsPath: value }, { current });
    assert.deepEqual(result.rejected, []);
    assert.equal(result.patch.sensitiveWordsPath, '');
  }
});

test('配置来源校验：对话框刚选中的值才放行（这就是「来源」）', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  const result = configGate.filterPathPatch(
    { booksRoot: path.join(ROOT, '新书架'), proofreadWordsPath: wordsA, sensitiveWordsPath: wordsB },
    {
      current,
      picked: {
        booksRoot: path.join(ROOT, '新书架'),
        proofreadWordsPath: wordsA,
        sensitiveWordsPath: wordsB
      }
    }
  );
  assert.deepEqual(result.rejected, []);
  assert.equal(result.patch.booksRoot, path.join(ROOT, '新书架'));
  assert.equal(result.patch.proofreadWordsPath, wordsA);
  assert.equal(result.patch.sensitiveWordsPath, wordsB);
});

test('配置来源校验：来源不明的路径一律忽略，回包里只有字段名、没有路径', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  const forged = path.join(ROOT, '..', '伪造目录');
  const result = configGate.filterPathPatch(
    { booksRoot: forged, proofreadWordsPath: outside + '.txt', sensitiveWordsPath: 'C:\\Windows\\win.ini' },
    { current, picked: null }
  );
  assert.deepEqual(Object.keys(result.patch), []);
  assert.deepEqual(result.rejected, ['booksRoot', 'proofreadWordsPath', 'sensitiveWordsPath']);
  const reported = JSON.stringify(result.rejected);
  assert.equal(reported.includes('伪造目录'), false);
  assert.equal(reported.includes('win.ini'), false);
  assert.equal(reported.includes('\\\\'), false);
});

test('配置来源校验：同一 patch 里合法字段照旧生效，只有被拒的路径字段被摘掉', () => {
  const current = { booksRoot: bookRoot, dailyGoal: 2000 };
  const result = configGate.filterPathPatch(
    { booksRoot: outside, dailyGoal: 3000, editorPaper: 'kraft' },
    { current }
  );
  assert.equal(result.patch.dailyGoal, 3000);
  assert.equal(result.patch.editorPaper, 'kraft');
  assert.equal('booksRoot' in result.patch, false);
  assert.deepEqual(result.rejected, ['booksRoot']);
});

test('配置来源校验：一项的登记不能拿去给另一项用（字段之间不串用）', () => {
  const current = { proofreadWordsPath: '', sensitiveWordsPath: '' };
  const result = configGate.filterPathPatch(
    { sensitiveWordsPath: wordsA },
    { current, picked: { proofreadWordsPath: wordsA } }
  );
  assert.deepEqual(result.patch, {});
  assert.deepEqual(result.rejected, ['sensitiveWordsPath']);
});

test('配置来源校验：坏类型（数字 / null / 数组 / 对象 / 布尔）一律当来源不明拒绝', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  for (const value of [123, null, undefined, ['D:\\x'], { path: 'D:\\x' }, true]) {
    const result = configGate.filterPathPatch({ booksRoot: value }, { current });
    assert.deepEqual(result.rejected, ['booksRoot'], `应当拒绝：${String(value)}`);
  }
});

test('配置来源校验：坏 patch / 缺省参数不抛错（只当没有改动）', () => {
  for (const patch of [null, undefined, 42, 'booksRoot', ['booksRoot']]) {
    const result = configGate.filterPathPatch(patch, {});
    assert.deepEqual(result.patch, {});
    assert.deepEqual(result.rejected, []);
  }
  assert.deepEqual(configGate.filterPathPatch({ editorFont: 'kai' }), { patch: { editorFont: 'kai' }, rejected: [] });
});

test('路径等价：末尾分隔符 / 正反斜杠 / 大小写都算同一个；空值与坏值不算', () => {
  assert.equal(configGate.samePath(bookRoot, bookRoot + path.sep), true);
  assert.equal(configGate.samePath(bookRoot, bookRoot.replace(/\\/g, '/')), true);
  assert.equal(configGate.samePath(bookRoot, `  ${bookRoot}  `), true);
  assert.equal(configGate.samePath(bookRoot, path.join(ROOT, '另一个')), false);
  assert.equal(configGate.samePath('', ''), false);
  assert.equal(configGate.samePath(null, bookRoot), false);
  assert.equal(configGate.samePath(bookRoot, undefined), false);
  if (process.platform === 'win32') {
    assert.equal(configGate.samePath(bookRoot, bookRoot.toUpperCase()), true);
  }
});

test('路径等价：子目录 / 父目录不是同一个路径（不做前缀比较）', () => {
  assert.equal(configGate.samePath(path.join(bookRoot, '子目录'), bookRoot), false);
  assert.equal(configGate.samePath(path.dirname(bookRoot), bookRoot), false);
});

test('选择登记：按窗口隔离、重选覆盖、空值只清这一项、关窗清理', () => {
  const store = configGate.createPickedPathStore();
  assert.deepEqual(store.snapshot(1), {});
  assert.equal(store.remember(1, 'booksRoot', bookRoot), true);
  assert.equal(store.remember(1, 'sensitiveWordsPath', wordsA), true);
  // 另一个窗口各自选各自的：互不可见
  assert.equal(store.remember(2, 'sensitiveWordsPath', wordsB), true);
  assert.deepEqual(store.snapshot(1), { booksRoot: bookRoot, sensitiveWordsPath: wordsA });
  assert.deepEqual(store.snapshot(2), { sensitiveWordsPath: wordsB });
  // 同一项重选：只留最后一次
  store.remember(1, 'sensitiveWordsPath', wordsB);
  assert.equal(store.recall(1, 'sensitiveWordsPath'), wordsB);
  // 清空某一次选择
  store.remember(1, 'booksRoot', '');
  assert.equal(store.recall(1, 'booksRoot'), '');
  // 关窗清理 + size 只算还有登记的窗口
  assert.equal(store.size(), 2);
  assert.equal(store.forget(2), true);
  assert.equal(store.forget(2), false);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.snapshot(2), {});
});

test('选择登记：未知字段 / 空窗口 id 不记账（不留下无主登记）', () => {
  const store = configGate.createPickedPathStore();
  assert.equal(store.remember(1, 'editorCustomFontPath', wordsA), false);
  assert.equal(store.remember('', 'booksRoot', bookRoot), false);
  assert.equal(store.remember(null, 'booksRoot', bookRoot), false);
  // 空值 = 「清掉这一项的登记」：算操作成功，但不会留下任何登记
  assert.equal(store.remember(1, 'booksRoot', '   '), true);
  assert.equal(store.size(), 0);
  assert.equal(store.recall(1, 'booksRoot'), '');
  assert.deepEqual(store.snapshot(''), {});
});

test('静态闸门：config:set 必须过 filterPathPatch，三个对话框入口必须记账', () => {
  // 校验清单本身就是审计结论：改名 / 加字段都要同步改这里
  assert.deepEqual(
    configGate.GUARDED_PATH_FIELDS.slice().sort(),
    ['booksRoot', 'proofreadWordsPath', 'sensitiveWordsPath'].sort()
  );
  // config:set 里少了这道校验就红（防止以后为了「方便」把它摘掉）
  assert.equal(
    (MAIN_SOURCE.match(/configGate\.filterPathPatch\(/g) || []).length,
    1,
    'config:set 必须调用 configGate.filterPathPatch 做来源校验'
  );
  // 三个正当来源：书架目录对话框 / 校对词表对话框 / 敏感词表对话框，各自记账
  assert.ok(
    MAIN_SOURCE.includes("rememberPickedConfigPath('booksRoot', filePaths[0])"),
    'shell:pick-folder 选中目录后必须记下 booksRoot 的来源'
  );
  assert.ok(
    MAIN_SOURCE.includes('rememberPickedConfigPath(field, filePaths[0])'),
    '选词表对话框必须按字段记下来源'
  );
  assert.ok(MAIN_SOURCE.includes("field: 'proofreadWordsPath'"), '校对词表必须记到 proofreadWordsPath');
  assert.ok(MAIN_SOURCE.includes("field: 'sensitiveWordsPath'"), '敏感词表必须记到 sensitiveWordsPath');
  // 只在 automation 下注册的「模拟选中」频道必须仍然只在 automation 块里
  const testPickAt = MAIN_SOURCE.indexOf("handle('config:test-pick'");
  assert.ok(testPickAt > 0, 'config:test-pick 应该存在（供 E2E 模拟对话框选中）');
  const automationAt = MAIN_SOURCE.lastIndexOf('if (automation) {', testPickAt);
  assert.ok(automationAt > 0, 'config:test-pick 必须在 automation 分支里注册');
});
