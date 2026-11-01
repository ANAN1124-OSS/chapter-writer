/* 前端基准脚本（v0.9 A-1）的自检
 *
 * 这个脚本的价值全在「数字可信」和「不碰真实书库」两件事上，所以测试分两头：
 * - 行为：参数解析 / 夹具计划 / 夹具落盘 / 统计口径 / 表格 / 结果解析 / 驱动参数；
 * - 静态闸门：只许落在临时目录、不许删东西、不许引第三方或 electron、用量口径不许靠
 *   rAF / 定时器计时、main.js 必须把 --bench 接进自动化家族且懒加载驱动、安装包不含 scripts/。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bench = require('../scripts/bench');
const driver = require('../scripts/bench-driver');
const storage = require('../core/storage');
const chaptersLib = require('../core/chapters');

const ROOT = path.join(__dirname, '..');
const BENCH_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'bench.js'), 'utf8');
const DRIVER_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'bench-driver.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function tempDir(prefix = 'cw-bench-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function smallOpts(overrides = {}) {
  return {
    books: 2,
    chapters: 3,
    volumes: 1,
    runs: 2,
    chapterChars: 120,
    longChars: 400,
    timeout: 1000,
    ...overrides
  };
}

// ---------- 参数 ----------

test('参数：默认值 / 覆盖 / 夹紧 / --out 相对路径 / --help', () => {
  const defaults = bench.parseArgs([]);
  assert.strictEqual(defaults.books, 280);
  assert.strictEqual(defaults.chapters, 1000);
  assert.strictEqual(defaults.volumes, 10);
  assert.strictEqual(defaults.runs, 5);
  assert.strictEqual(defaults.out, null);
  assert.strictEqual(defaults.help, false);

  const custom = bench.parseArgs([
    '--books=12',
    '--chapters=34',
    '--runs=3',
    '--volumes=2',
    '--out=shots/x.json',
    '--whatever=9',
    'positional'
  ]);
  assert.strictEqual(custom.books, 12);
  assert.strictEqual(custom.chapters, 34);
  assert.strictEqual(custom.runs, 3);
  assert.strictEqual(custom.volumes, 2);
  assert.strictEqual(custom.out, 'shots/x.json');

  // 夹紧：0 / 负数 / 超上限 / 坏值都回到合法区间；--volumes 不超过章数，--long-chars 不小于普通章字数
  const clamped = bench.parseArgs(['--books=0', '--chapters=-5', '--runs=999', '--volumes=50']);
  assert.strictEqual(clamped.books, 1);
  assert.strictEqual(clamped.chapters, 1);
  assert.strictEqual(clamped.runs, 30);
  assert.strictEqual(clamped.volumes, 1);
  const odd = bench.parseArgs(['--books=abc', '--long-chars=10']);
  assert.strictEqual(odd.books, 280);
  assert.strictEqual(odd.longChars, odd.chapterChars);

  assert.strictEqual(bench.parseArgs(['--help']).help, true);
  assert.strictEqual(bench.parseArgs(['-h']).help, true);
  assert.match(bench.usageText(), /--books=N/);
  assert.match(bench.usageText(), /临时目录/);
});

// ---------- 夹具计划 ----------

test('夹具计划：书数 / 每本 3 章 / 查询词命中全部书名 / 大书分卷与最长章', () => {
  const plan = bench.buildPlan({ books: 7, chapters: 100, volumes: 4, chapterChars: 300, longChars: 90000 });
  assert.strictEqual(plan.books.length, 7);
  for (const book of plan.books) {
    assert.strictEqual(book.chapters.length, 3);
    assert.ok(book.title.includes(bench.SHELF_QUERY), '查询词必须命中每本书（量最坏渲染量）');
    assert.strictEqual(book.chapters[0].chars, 300);
  }
  assert.strictEqual(plan.bigBook.chapters.length, 100);
  assert.strictEqual(plan.bigBook.volumes.length, 4);
  assert.strictEqual(plan.bigBook.volumes[0].id, 'v1');
  assert.strictEqual(plan.bigBook.longIndex, 50, '最长章放正中间');
  assert.strictEqual(plan.bigBook.chapters[49].chars, 90000);
  // 分卷连续且按卷号递增：第 i 章落在第 ceil(i / 每卷章数) 卷
  const perVolume = Math.ceil(100 / 4);
  for (let i = 1; i <= 100; i += 1) {
    const volume = plan.bigBook.volumes[Math.min(3, Math.floor((i - 1) / perVolume))];
    assert.strictEqual(plan.bigBook.chapters[i - 1].volumeId, volume.id);
  }
  // 0 卷 = 不分卷
  const flat = bench.buildPlan({ books: 1, chapters: 5, volumes: 0, chapterChars: 10, longChars: 10 });
  assert.strictEqual(flat.bigBook.volumes.length, 0);
  assert.deepStrictEqual(flat.bigBook.chapters.map((c) => c.volumeId), [null, null, null, null, null]);
});

test('夹具正文：长度确定、同样参数同样文本、坏字数兜底成一行', () => {
  const text = bench.chapterText('种子', 300);
  assert.strictEqual(text.length, 300);
  assert.strictEqual(text, bench.chapterText('种子', 300));
  assert.notStrictEqual(text, bench.chapterText('另一个种子', 300));
  assert.match(text, /种子/);
  assert.ok(bench.chapterText('种子', 0).length > 0, '字数为 0 / 坏值也要给一行正文');
  assert.ok(bench.chapterText('种子', NaN).length > 0);
});

// ---------- 统计与表格 ----------

test('统计：中位数（奇 / 偶）/ 单样本 / 空样本 / 坏值过滤 / p95 最近秩', () => {
  assert.deepStrictEqual(bench.summarize([]), {
    count: 0, min: null, median: null, mean: null, p95: null, max: null
  });
  const odd = bench.summarize([30, 10, 20]);
  assert.strictEqual(odd.count, 3);
  assert.strictEqual(odd.min, 10);
  assert.strictEqual(odd.median, 20);
  assert.strictEqual(odd.max, 30);
  assert.strictEqual(odd.mean, 20);
  const even = bench.summarize([40, 10, 30, 20]);
  assert.strictEqual(even.median, 25);
  assert.strictEqual(bench.summarize([7]).median, 7);
  // p95 = 最近秩（第 ceil(0.95n) 个），n = 20 时取第 19 个
  const many = bench.summarize(Array.from({ length: 20 }, (_, i) => i + 1));
  assert.strictEqual(many.p95, 19);
  // 非数字（null / NaN / undefined / 字符串）不算样本：'7' 不会被强制成数字
  const dirty = bench.summarize([5, null, NaN, undefined, '7', 15]);
  assert.strictEqual(dirty.count, 2);
  assert.strictEqual(dirty.max, 15);
  // 两位小数，不把浮点数原样带进报告
  assert.strictEqual(bench.summarize([1.23456]).median, 1.23);
});

test('表格：中文按两列宽对齐、右对齐补在前面', () => {
  assert.strictEqual(bench.displayWidth('abc'), 3);
  assert.strictEqual(bench.displayWidth('书架'), 4);
  assert.strictEqual(bench.displayWidth('书架abc'), 7);
  assert.strictEqual(bench.padCell('书架', 6), '书架  ');
  assert.strictEqual(bench.padCell('7.2', 6, 'right'), '   7.2');
  assert.strictEqual(bench.padCell('超长文本也放得下', 4), '超长文本也放得下');
});

test('报告：含窗口 / 夹具 / 口径说明 + 每个场景一行数字 + 场景备注', () => {
  const report = {
    runs: 3,
    env: { windowSize: '1200×760', dpr: 1, visibility: 'visible', hasFocus: true, bookCards: 280 },
    fixtures: {
      booksRoot: 'D:\\Temp\\cw-bench-x\\books',
      shelfCount: 280,
      chapters: 1000,
      volumes: 10,
      longIndex: 499,
      longChars: 100000,
      buildMs: 1800
    },
    scenarios: [
      { name: '书架刷新（全部书）', note: 'listBooks → 书卡', samples: [10, 20], summary: bench.summarize([10, 20]) },
      { name: '章节栏渲染（展开分卷）', note: '整表重建', samples: [1], summary: bench.summarize([1]) }
    ],
    detailHint: 'detail：条目数'
  };
  const lines = bench.formatLines(report).join('\n');
  assert.match(lines, /前端基准（v0\.9 A-1，只读）/);
  assert.match(lines, /窗口 1200×760/);
  assert.match(lines, /书架 280 本（每本 3 章）/);
  assert.match(lines, /第 500 章 10\.0 万字/);
  assert.match(lines, /不用 rAF \/ 固定 sleep/);
  assert.match(lines, /书架刷新（全部书）\s+15\.0\s+10\.0\s+20\.0/);
  assert.match(lines, /章节栏渲染（展开分卷）：整表重建/);
  assert.match(lines, /detail：条目数/);
});

// ---------- 安全闸门（临时目录） ----------

test('临时目录闸门：只认系统临时目录，家目录 / 盘根 / 上级目录一律拒绝', () => {
  const inside = path.join(os.tmpdir(), 'cw-bench-guard', 'books');
  assert.strictEqual(bench.isInside(os.tmpdir(), inside), true);
  assert.strictEqual(bench.isInside(os.tmpdir(), os.tmpdir()), true);
  assert.strictEqual(bench.isInside(os.tmpdir(), path.join(os.tmpdir(), '..')), false);
  assert.strictEqual(bench.isInside(path.join(os.tmpdir(), 'a'), path.join(os.tmpdir(), 'ab')), false);
  assert.strictEqual(bench.assertTempRoot(inside), path.resolve(inside));
  assert.throws(() => bench.assertTempRoot(os.homedir()), /只允许在系统临时目录/);
  assert.throws(() => bench.assertTempRoot(path.join(os.tmpdir(), '..')), /只允许在系统临时目录/);
});

// ---------- 夹具落盘 ----------

test('夹具落盘：书目格式可被 core 读回、正文逐字一致、字数缓存已预填', async () => {
  const base = tempDir();
  try {
    const opts = smallOpts();
    const plan = bench.buildPlan(opts);
    const fixtures = await bench.createFixtures(base, plan);
    assert.strictEqual(fixtures.shelfCount, 2);
    assert.strictEqual(fixtures.chapters, 3);
    assert.strictEqual(fixtures.longIndex, 1, '3 章时最长章 = 第 2 章（0 起算 1）');
    assert.strictEqual(fixtures.longChars, opts.longChars);
    // 临时目录里只有 books/，没有别的东西写到外面
    assert.deepStrictEqual(fs.readdirSync(base), ['books']);
    const folders = fs.readdirSync(fixtures.booksRoot).sort();
    assert.deepStrictEqual(folders, ['第1本练习书', '第2本练习书', '基准大书-3章'].sort());

    // 正文逐字一致（不 trim、不改换行）
    const bigMeta = JSON.parse(
      fs.readFileSync(path.join(fixtures.bigBookPath, '书目.json'), 'utf8')
    );
    assert.strictEqual(bigMeta.title, '基准大书-3章');
    assert.strictEqual(bigMeta.schemaVersion, 1);
    assert.strictEqual(bigMeta.chapters.length, 3);
    assert.deepStrictEqual(bigMeta.volumes, [{ id: 'v1', name: '第1卷' }]);
    const first = bigMeta.chapters[0];
    const firstText = fs.readFileSync(path.join(fixtures.bigBookPath, first.file), 'utf8');
    assert.strictEqual(firstText, bench.chapterText('基准大书-3章-1', opts.chapterChars));
    // 字数缓存预填（= 真实书库首次扫描之后的常态）
    for (const chapter of bigMeta.chapters) {
      assert.strictEqual(chapter.chars, chaptersLib.countChars(
        fs.readFileSync(path.join(fixtures.bigBookPath, chapter.file), 'utf8')
      ));
      assert.ok(fs.existsSync(path.join(fixtures.bigBookPath, chapter.file)));
    }
    // 用产品自己的读盘路径读回来：章数、卷、缺章、总字数都对得上
    const opened = await storage.openBook(fixtures.bigBookPath);
    assert.strictEqual(opened.meta.chapters.length, 3);
    assert.deepStrictEqual(opened.missing, []);
    const expectedChars = bigMeta.chapters.reduce((sum, c) => sum + c.chars, 0);
    assert.strictEqual(opened.totalChars, expectedChars);
    // 书架扫描：三本书都能列出来，大书章数正确
    const books = await storage.listBooks(fixtures.booksRoot);
    assert.strictEqual(books.length, 3);
    const big = books.find((book) => book.title === '基准大书-3章');
    assert.ok(big, '书架里要有大书');
    assert.strictEqual(big.chapterCount, 3);
    assert.strictEqual(big.totalChars, expectedChars);
    // 小书路径可直接打开
    const small = await storage.openBook(fixtures.smallBookPath);
    assert.strictEqual(small.meta.chapters.length, 3);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('夹具：同名书自动换文件夹名（不会把两本书叠在一起）', async () => {
  const base = tempDir();
  try {
    const booksRoot = path.join(base, 'books');
    await fsp.mkdir(booksRoot, { recursive: true });
    const book = { title: '重名书', chapters: [{ name: '第1节', chars: 20 }] };
    const first = await bench.writeFixtureBook(booksRoot, book, 1);
    const second = await bench.writeFixtureBook(booksRoot, book, 2);
    assert.notStrictEqual(first.folder, second.folder);
    assert.deepStrictEqual(fs.readdirSync(booksRoot).sort(), [first.folder, second.folder].sort());
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

// ---------- 驱动 ----------

test('驱动：注入脚本语法合法、参数回环、口径里不许出现 rAF / 固定 sleep', () => {
  const cfg = { runs: 3, books: 280, chapters: 1000, longIndex: 499, bigBookPath: 'X', smallBookPath: 'Y', searchQuery: '练习' };
  const script = driver.buildBenchScript(cfg);
  assert.doesNotThrow(() => new Function(script), '注入脚本必须是合法 JS（页面里直接执行）');
  assert.match(script, /"runs":3/);
  assert.match(script, /"longIndex":499/);
  assert.match(script, /window\.__cwTest/);
  assert.ok(
    !/requestAnimationFrame\s*\(/.test(script),
    '计时不许靠 rAF（窗口被遮挡会被节流）'
  );
  assert.ok(!/\bsleep\s*\(/.test(script), '计时不许靠固定 sleep');
  assert.match(script, /offsetHeight/, '必须用强制同步布局把样式 / 布局算进来');
});

test('驱动：从启动参数读配置并夹紧（缺的给默认、坏值回落、负下标保留 -1）', () => {
  const args = {
    'bench-runs': '7',
    'bench-books': '12',
    'bench-chapters': '34',
    'bench-long-index': '5',
    'bench-big-book': 'D:\\Temp\\big',
    'bench-small-book': 'D:\\Temp\\small',
    'bench-search-query': '练习'
  };
  const cfg = driver.benchConfig((name) => (name in args ? args[name] : null));
  assert.deepStrictEqual(cfg, {
    runs: 7,
    books: 12,
    chapters: 34,
    longIndex: 5,
    bigBookPath: 'D:\\Temp\\big',
    smallBookPath: 'D:\\Temp\\small',
    searchQuery: '练习'
  });
  const fallback = driver.benchConfig(() => null);
  assert.strictEqual(fallback.runs, 5);
  assert.strictEqual(fallback.longIndex, -1);
  assert.strictEqual(fallback.searchQuery, '练习');
  assert.strictEqual(driver.benchConfig(() => 'abc').runs, 5);
  assert.strictEqual(driver.benchConfig(() => '999').runs, 30);
});

test('结果解析：从带噪声的 stdout 里挑 BENCH_RESULT，坏 JSON 返回 null', () => {
  const ok = 'noise\nBENCH_RESULT {"ok":true,"scenarios":[]}\nmore noise';
  assert.deepStrictEqual(bench.pickResult(ok), { ok: true, scenarios: [] });
  assert.strictEqual(bench.pickResult('BENCH_RESULT {坏 JSON}'), null);
  assert.strictEqual(bench.pickResult('nothing here'), null);
  assert.strictEqual(bench.pickResult(''), null);
});

// ---------- 静态闸门 ----------

test('静态闸门：脚本零运行时依赖，只 require node 内建或仓库内相对路径', () => {
  for (const [name, src] of [['bench.js', BENCH_SRC], ['bench-driver.js', DRIVER_SRC]]) {
    const required = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(required.length > 0, `${name} 应当有 require`);
    for (const target of required) {
      const ok = target.startsWith('node:') || target.startsWith('./') || target.startsWith('../');
      assert.ok(ok, `${name} 里出现了非内建 / 非相对依赖：${target}`);
    }
    assert.ok(!/\belectron\b/.test(src) || !/require\('electron'\)/.test(src), `${name} 不许 require electron`);
  }
  // 不写死盘符路径（书库一律由 os.tmpdir() 现造）
  for (const [name, src] of [['bench.js', BENCH_SRC], ['bench-driver.js', DRIVER_SRC]]) {
    assert.ok(!/\b[A-Za-z]:\\/.test(src), `${name} 里不许出现写死的盘符路径`);
  }
});

test('静态闸门：基准脚本不删任何东西（删除动作不进这个项目）', () => {
  for (const pattern of [/\bfsp?\.rm(Sync)?\s*\(/, /\bunlink(Sync)?\s*\(/, /\brmdir(Sync)?\s*\(/]) {
    assert.ok(!pattern.test(BENCH_SRC), `bench.js 不许删除文件 / 目录：${pattern}`);
  }
});

test('静态闸门：main.js 把 --bench 接进自动化家族并在自动化里懒加载驱动', () => {
  assert.match(MAIN_SRC, /const isBench = process\.argv\.includes\('--bench'\);/);
  // 自动化家族以后可能继续加模式（v0.9 A-4 加了 --contrast），这里只要求 --bench 在里面，
  // 整句的准确形状由 tests/contrast.test.js 的整体闸门钉住。
  assert.match(MAIN_SRC, /const automation = [^;]*isBench[^;]*Boolean\(screenshotPath\);/);
  const body = /async function runAutomation\(\)[\s\S]*?\n\}/.exec(MAIN_SRC);
  assert.ok(body, '找不到 runAutomation()');
  assert.match(body[0], /if \(isBench\) \{/, 'runAutomation 必须按 --bench 分流');
  assert.match(body[0], /require\('\.\/scripts\/bench-driver\.js'\)/, '驱动必须懒加载（require 在函数里）');
  assert.match(body[0], /require\('\.\/scripts\/screenshot-driver\.js'\)/, '截图 / E2E 驱动照旧');
});

test('静态闸门：安装包不含 scripts/（基准驱动只存在于开发版）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(!files.some((item) => String(item).includes('scripts/')), 'build.files 不许含 scripts/');
  assert.ok(files.includes('main.js'));
});

test('静态闸门：测试与脚本里都只用临时书库（不许出现真实书架路径）', () => {
  // 真实书架是作者本机的私有路径：脚本 / 测试里出现它就意味着有人把测试改成读写真实数据了。
  // 这里用拼接避免把整串写进本文件（否则这条闸门自己会被搜到）。
  const forbidden = ['D:', '\\我的', '小说'].join('');
  for (const [name, src] of [
    ['scripts/bench.js', BENCH_SRC],
    ['scripts/bench-driver.js', DRIVER_SRC],
    ['tests/bench.test.js', fs.readFileSync(__filename, 'utf8')]
  ]) {
    assert.ok(!src.includes(forbidden), `${name} 里不许出现真实书架路径`);
  }
});
