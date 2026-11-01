'use strict';
// 章节写作器 · 前端基准脚本（v0.9 A-1，只读）
//
// 干什么：在**系统临时目录**里现造一套临时书库（一棵「整库书架」+ 一本千章大书）+ 临时
// userData，启动真实 Electron 用测试钩子跑一组固定场景，把「打开书 / 切章 / 书架搜索 /
// 章节栏渲染」的耗时打出来（并落一份 JSON）。A-2（大书与大数据量体验）/ A-3（编辑器手感）
// 改前改后都用同一份脚本取数，才有可比性。
//
// 为什么单独一个文件：这些数字必须能反复量，而不是「感觉快了」。脚本本身**只读产品代码**、
// 零运行时依赖（只 require node: 内建 + 仓库里的 core/*），书库与配置全在临时目录，
// 跑完只留下临时目录（与 pnpm run e2e 一样，不自动删——删除动作一律不进这个项目）。
//
// 用法：
//   node scripts/bench.js                              # 默认：书架 280 本 × 3 章 + 千章大书，每项 5 次样本
//   node scripts/bench.js --books=100 --chapters=300 --runs=3
//   node scripts/bench.js --out=shots/bench-x.json     # 指定 JSON 落点（默认 shots/bench-<时间>.json）
//   node scripts/bench.js --help
//
// 口径（重要，改脚本前先读）：
//   * 单次耗时 = 从调用开始到「强制同步布局」（读一次 body.offsetHeight）为止的墙钟毫秒，
//     含 IPC / 建 DOM / 样式 / 布局。**不用 requestAnimationFrame、也不用固定 sleep**：
//     工作站锁屏或窗口被遮挡时 Chromium 会节流定时器与 rAF（v0.9 B-2 实测把 80ms 防抖
//     拖到 1s+），靠它们计时量出来是假数；同步布局在任何可见性状态下都照常算。
//   * 每项先预热 1 次（JIT / 字体 / 首帧），再取 N 次样本；报告给 中位 / 最小 / 最大 / p95。
//   * 书目里**预填字数缓存**（= 真实书库「首次扫描之后」的常态），这样打开书 / 书架刷新
//     量到的是日常速度，而不是「第一次扫全库」。
//   * 数字跟机器、杀软、盘、窗口大小都有关，只用于**同一台机器上改前改后对比**。

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { atomicWriteFile } = require('../core/atomic');
const { clampInt } = require('../core/common');
const storage = require('../core/storage');
const chaptersLib = require('../core/chapters');
const schemaLib = require('../core/schema');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  books: 280, // 书架书数（作者真实书架 280 本左右）
  chapters: 1000, // 大书章数
  volumes: 10, // 大书分卷数
  runs: 5, // 每项样本数
  chapterChars: 500, // 普通章字数
  longChars: 100000, // 最长那一章的字数（A-3 的 10 万字大章）
  timeout: 300000 // 整个基准进程的超时（毫秒）
};

// ---------- 参数 ----------

// 取整数启动参数：没给值（`--runs` 后面没写数字 / 写了空串）走默认，别被 Number('') = 0
// 带成最小值；夹紧本身用 core/common.js 的那一份（不在这里抄第二份 clampInt）。
function intOption(raw, min, max, fallback) {
  if (raw == null || raw === '') return fallback;
  return clampInt(raw, fallback, [min, max]);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, out: null, help: false };
  for (const raw of argv || []) {
    if (raw === '--help' || raw === '-h') {
      opts.help = true;
      continue;
    }
    const hit = /^--([a-z-]+)(?:=(.*))?$/.exec(String(raw));
    if (!hit) continue; // 位置参数 / 其它启动器的参数一律忽略
    const key = hit[1];
    const value = hit[2];
    if (key === 'books') opts.books = intOption(value, 1, 2000, DEFAULTS.books);
    else if (key === 'chapters') opts.chapters = intOption(value, 1, 20000, DEFAULTS.chapters);
    else if (key === 'volumes') opts.volumes = intOption(value, 0, 100, DEFAULTS.volumes);
    else if (key === 'runs') opts.runs = intOption(value, 1, 30, DEFAULTS.runs);
    else if (key === 'chapter-chars') {
      opts.chapterChars = intOption(value, 10, 5000000, DEFAULTS.chapterChars);
    } else if (key === 'long-chars') {
      opts.longChars = intOption(value, 10, 5000000, DEFAULTS.longChars);
    } else if (key === 'timeout') {
      opts.timeout = intOption(value, 10000, 3600000, DEFAULTS.timeout);
    } else if (key === 'out') {
      opts.out = value ? String(value) : null;
    }
  }
  if (opts.volumes > opts.chapters) opts.volumes = opts.chapters;
  if (opts.longChars < opts.chapterChars) opts.longChars = opts.chapterChars;
  return opts;
}

function usageText() {
  return [
    '章节写作器 · 前端基准（只读，v0.9 A-1）',
    '',
    '用法：node scripts/bench.js [选项]',
    '',
    '  --books=N         书架书数（默认 280，1–2000）',
    '  --chapters=N      大书章数（默认 1000，1–20000）',
    '  --volumes=N       大书分卷数（默认 10，0–100；超过章数按章数算）',
    '  --runs=N          每项样本数（默认 5，1–30）',
    '  --chapter-chars=N 普通章字数（默认 500）',
    '  --long-chars=N    最长那一章的字数（默认 100000）',
    '  --timeout=MS      整个基准进程超时（默认 300000）',
    '  --out=路径        结果 JSON 落点（默认 shots/bench-<时间>.json）',
    '  --help            打这份说明',
    '',
    '说明：书库与配置全部建在系统临时目录（绝不碰真实书库），跑完只留临时目录。'
  ].join('\n');
}

// ---------- 夹具计划（纯函数，单测用） ----------

// 「练习」在每本书名里 → 书架搜索的查询词能命中全部书（量最坏情况的渲染量）。
const SHELF_QUERY = '练习';

function buildPlan(opts) {
  const books = [];
  for (let i = 1; i <= opts.books; i += 1) {
    books.push({
      title: `第${i}本练习书`,
      // 作者 / 分组 / 标签 / 简介按固定间隔给几本，让书卡渲染更像真实书架（不追求均衡分布）
      author: i % 3 === 0 ? `作者${i}` : '',
      group: i % 5 === 0 ? `长篇组${(i % 3) + 1}` : '',
      tags: i % 7 === 0 ? [`标签${i % 4}`, '练笔'] : [],
      brief: i % 11 === 0 ? '基准脚本生成的临时简介，用来让书卡多渲染一两行。' : '',
      chapters: [1, 2, 3].map((n) => ({ name: `第${n}节`, chars: opts.chapterChars }))
    });
  }
  const volumes = [];
  for (let v = 1; v <= opts.volumes; v += 1) volumes.push({ id: `v${v}`, name: `第${v}卷` });
  const perVolume = volumes.length ? Math.ceil(opts.chapters / volumes.length) : opts.chapters;
  // 最长的那一章放在正中间（1 起算）：切章既能量「普通章」，也能量「换到 10 万字大章」
  const longIndex = Math.max(1, Math.ceil(opts.chapters / 2));
  const chapters = [];
  for (let i = 1; i <= opts.chapters; i += 1) {
    const volume = volumes.length
      ? volumes[Math.min(volumes.length - 1, Math.floor((i - 1) / perVolume))]
      : null;
    chapters.push({
      name: `练习第${i}节`,
      volumeId: volume ? volume.id : null,
      chars: i === longIndex ? opts.longChars : opts.chapterChars
    });
  }
  return {
    shelfQuery: SHELF_QUERY,
    books,
    bigBook: {
      title: `基准大书-${opts.chapters}章`,
      volumes,
      longIndex,
      chapters
    }
  };
}

function chapterText(seed, chars) {
  const line =
    `【${seed}】这是基准脚本生成的临时正文，只用来测量读盘、建 DOM 与布局的耗时；` +
    '真实书稿不长这样，但段落数与字符量的量级和日常章节接近。';
  const want = Number(chars);
  if (!Number.isFinite(want) || want <= 0) return line;
  let text = '';
  while (text.length < want) text += `${line}\n`;
  return text.slice(0, want);
}

// ---------- 夹具落盘（临时书库） ----------

function isInside(parent, child) {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const rel = path.relative(from, to);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 安全闸门：书库只许建在系统临时目录里。这条是「绝不读写真实书库」红线的机器检查。
function assertTempRoot(root) {
  const tmp = os.tmpdir();
  if (!isInside(tmp, root)) {
    throw new Error(`基准脚本只允许在系统临时目录下建书库（拒绝：${root}）`);
  }
  return path.resolve(root);
}

async function folderFor(booksRoot, title) {
  const base = chaptersLib.safeName(title);
  let folder = base;
  let i = 2;
  for (;;) {
    try {
      await fsp.access(path.join(booksRoot, folder));
      folder = `${base}-${i}`;
      i += 1;
    } catch {
      return folder;
    }
  }
}

// 造一本「产品格式」的书：章节文件名 / 书目字段 / 字数缓存都按 core 的口径来，
// 这样主进程读它跟读真实书完全同一条路径（不另造一套格式）。
async function writeFixtureBook(booksRoot, book, index) {
  const folder = await folderFor(booksRoot, book.title);
  const bookPath = path.join(booksRoot, folder);
  await fsp.mkdir(bookPath, { recursive: true });
  const chapters = [];
  for (let i = 0; i < book.chapters.length; i += 1) {
    const spec = book.chapters[i];
    const seq = i + 1;
    const file = chaptersLib.buildFileName(seq, spec.name);
    const text = chapterText(`${book.title}-${seq}`, spec.chars);
    // 夹具正文是临时数据，用普通写盘即可（书目仍走 atomic 的 writeBookMeta）
    await fsp.writeFile(path.join(bookPath, file), text, 'utf8');
    chapters.push({
      id: `ch_${chaptersLib.pad3(seq)}`,
      file,
      name: spec.name,
      volumeId: spec.volumeId || null,
      chars: chaptersLib.countChars(text)
    });
  }
  const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString();
  const meta = {
    version: 1,
    schemaVersion: schemaLib.CURRENT_SCHEMA_VERSION,
    id: `b_bench_${chaptersLib.pad3(index)}`,
    title: book.title,
    titleTemplate: chaptersLib.TITLE_TEMPLATE,
    fileSeq: chapters.length,
    volumes: book.volumes || [],
    chapters,
    lastOpenChapterId: chapters[0].id,
    createdAt,
    updatedAt: createdAt
  };
  if (book.author) meta.author = book.author;
  if (book.group) meta.group = book.group;
  if (book.tags && book.tags.length) meta.tags = book.tags.slice();
  if (book.brief) meta.brief = book.brief;
  const saved = await storage.writeBookMeta(bookPath, meta);
  return { path: bookPath, folder, title: saved.title, chapters: chapters.length };
}

async function createFixtures(base, plan) {
  const booksRoot = path.join(base, 'books');
  await fsp.mkdir(booksRoot, { recursive: true });
  const shelf = [];
  for (let i = 0; i < plan.books.length; i += 1) {
    shelf.push(await writeFixtureBook(booksRoot, plan.books[i], i + 1));
  }
  const big = await writeFixtureBook(booksRoot, plan.bigBook, plan.books.length + 1);
  return {
    booksRoot,
    bigBookPath: big.path,
    smallBookPath: shelf[0].path,
    shelfCount: shelf.length,
    chapters: plan.bigBook.chapters.length,
    volumes: plan.bigBook.volumes.length,
    longIndex: plan.bigBook.longIndex - 1, // 0 起算，交给渲染层的 switchTo
    longChars: plan.bigBook.chapters[plan.bigBook.longIndex - 1].chars
  };
}

// ---------- 报告 ----------

function summarize(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((n) => Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  if (!list.length) {
    return { count: 0, min: null, median: null, mean: null, p95: null, max: null };
  }
  const round = (n) => Math.round(n * 100) / 100;
  const at = (i) => list[Math.min(list.length - 1, Math.max(0, i))];
  const mid =
    list.length % 2 === 1
      ? at((list.length - 1) / 2)
      : (at(list.length / 2 - 1) + at(list.length / 2)) / 2;
  const p95Index = Math.max(0, Math.ceil(list.length * 0.95) - 1);
  return {
    count: list.length,
    min: round(list[0]),
    median: round(mid),
    mean: round(list.reduce((sum, n) => sum + n, 0) / list.length),
    p95: round(at(p95Index)),
    max: round(at(list.length - 1))
  };
}

// 终端表格对齐：中文按 2 列宽算，否则中文场景名会把列挤歪
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text == null ? '' : text)) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text, width, align = 'left') {
  const value = String(text == null ? '' : text);
  const gap = Math.max(0, width - displayWidth(value));
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatLines(report) {
  const lines = [];
  const env = report.env || {};
  const f = report.fixtures || {};
  lines.push('== 章节写作器 · 前端基准（v0.9 A-1，只读）==');
  lines.push(
    `窗口 ${env.windowSize || '?'} · DPR ${env.dpr == null ? '?' : env.dpr} · ` +
      `页面可见性 ${env.visibility || '?'} · 窗口焦点 ${env.hasFocus} · 书卡 ${env.bookCards} 张`
  );
  lines.push(`临时书库 ${f.booksRoot || '?'}`);
  lines.push(
    `书架 ${f.shelfCount} 本（每本 3 章）· 大书 ${f.chapters} 章 / ${f.volumes} 卷` +
      `（第 ${Number(f.longIndex) + 1} 章 ${(Number(f.longChars) / 10000).toFixed(1)} 万字）` +
      `· 建夹具 ${f.buildMs} ms`
  );
  lines.push(
    `口径：单次耗时 = JS + 强制同步布局（ms），不用 rAF / 固定 sleep；每项预热 1 次后取 ${report.runs} 次样本`
  );
  lines.push('');

  const rows = [['场景', '中位', '最小', '最大', 'p95', '样本']];
  for (const item of report.scenarios || []) {
    const s = item.summary || summarize(item.samples);
    rows.push([
      item.name,
      fixed(s.median),
      fixed(s.min),
      fixed(s.max),
      fixed(s.p95),
      String(s.count)
    ]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => displayWidth(row[col]))));
  rows.forEach((row, index) => {
    const cells = row.map((cell, col) =>
      padCell(cell, widths[col], col === 0 ? 'left' : 'right')
    );
    lines.push(cells.join('  ').replace(/\s+$/, ''));
    if (index === 0) lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  });

  const notes = (report.scenarios || []).filter((item) => item.note);
  if (notes.length) {
    lines.push('');
    for (const item of notes) lines.push(`  ${item.name}：${item.note}`);
  }
  if (report.detailHint) {
    lines.push('');
    lines.push(report.detailHint);
  }
  return lines;
}

// ---------- 跑起来 ----------

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function machineInfo() {
  const cpus = os.cpus() || [];
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus.length ? String(cpus[0].model || '').trim() : '',
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    node: process.version
  };
}

function spawnBench({ base, fixtures, plan, opts }) {
  const userData = path.join(base, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const args = [
    path.join(ROOT, 'scripts', 'start.js'),
    '--bench',
    `--user-data=${userData}`,
    `--books-root=${fixtures.booksRoot}`,
    `--bench-runs=${opts.runs}`,
    `--bench-big-book=${fixtures.bigBookPath}`,
    `--bench-small-book=${fixtures.smallBookPath}`,
    `--bench-books=${fixtures.shelfCount}`,
    `--bench-chapters=${fixtures.chapters}`,
    `--bench-long-index=${fixtures.longIndex}`,
    `--bench-long-chars=${fixtures.longChars}`,
    `--bench-search-query=${plan.shelfQuery}`
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }, opts.timeout);
    timer.unref();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err && err.message}`, timedOut });
    });
  });
}

function pickResult(stdout) {
  const hit = /BENCH_RESULT (.+)/.exec(String(stdout || ''));
  if (!hit) return null;
  try {
    return JSON.parse(hit[1]);
  } catch {
    return null;
  }
}

function tail(text, maxLines = 12) {
  const lines = String(text || '').trim().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function reportPath(opts, when) {
  if (opts.out) return path.resolve(ROOT, opts.out);
  return path.join(ROOT, 'shots', `bench-${stamp(when)}.json`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usageText());
    return 0;
  }
  const startedAt = new Date();
  const base = path.join(os.tmpdir(), `cw-bench-${stamp(startedAt)}-${process.pid}`);
  assertTempRoot(base);
  const plan = buildPlan(opts);

  console.log(`[bench] 临时目录：${base}`);
  console.log(
    `[bench] 建夹具：书架 ${plan.books.length} 本 × 3 章 + 大书 ${plan.bigBook.chapters.length} 章` +
      ` / ${plan.bigBook.volumes.length} 卷（最长一章 ${(opts.longChars / 10000).toFixed(1)} 万字）…`
  );
  const buildStart = Date.now();
  const fixtures = await createFixtures(base, plan);
  const buildMs = Date.now() - buildStart;
  console.log(`[bench] 夹具建好（${buildMs} ms），启动 Electron 跑场景…`);

  const run = await spawnBench({ base, fixtures, plan, opts });
  const result = pickResult(run.stdout);
  if (!result) {
    console.error('[bench] 没有拿到结果，应用可能启动失败。');
    console.error(tail(run.stdout));
    console.error(tail(run.stderr));
    if (run.timedOut) console.error(`[bench] 超时（${opts.timeout} ms）`);
    return 1;
  }
  if (!result.ok) {
    console.error(`[bench] 场景失败：${result.error || '未知错误'}`);
    console.error(tail(run.stdout));
    console.error(tail(run.stderr));
    return 1;
  }

  const finishedAt = new Date();
  const report = {
    ok: true,
    tool: 'chapter-writer bench (v0.9 A-1)',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    machine: machineInfo(),
    options: opts,
    fixtures: {
      ...fixtures,
      booksRoot: fixtures.booksRoot,
      buildMs,
      shelfChaptersPerBook: 3
    },
    runs: opts.runs,
    env: result.env,
    scenarios: (result.scenarios || []).map((item) => ({
      name: item.name,
      note: item.note,
      detail: item.detail == null ? null : item.detail,
      samples: item.samples,
      summary: summarize(item.samples)
    })),
    detailHint:
      'detail：章节栏场景是「展开后列表里的条目数」，书架 / 搜索场景是「渲染出的书卡数」。'
  };
  const outPath = reportPath(opts, finishedAt);
  await atomicWriteFile(outPath, JSON.stringify(report, null, 2), 'utf8', { ensureDir: true });
  console.log('');
  console.log(formatLines(report).join('\n'));
  console.log('');
  console.log(`结果 JSON：${outPath}`);
  console.log(`临时书库（可保留 / 可手动删）：${base}`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

module.exports = {
  DEFAULTS,
  SHELF_QUERY,
  parseArgs,
  usageText,
  intOption,
  buildPlan,
  chapterText,
  isInside,
  assertTempRoot,
  createFixtures,
  writeFixtureBook,
  summarize,
  displayWidth,
  padCell,
  formatLines,
  machineInfo,
  reportPath,
  pickResult,
  main
};
