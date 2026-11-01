'use strict';
// 章节写作器 · 对比度审计（v0.9 A-4 视觉细节，只读）
//
// 干什么：在**系统临时目录**里现造一套临时书库（一本带作者 / 简介 / 标签 / 分卷 / 章节备注 / 完稿
// 状态的演练书 + 一个同步冲突副本 + 一本书目坏掉的书），启动真实 Electron，把 6 套纸色主题
// （paper / cream / green / kraft / grid / night）挨个切一遍，采「真实算出来的颜色」：
// 文字色 + 从元素自身往上走的背景色栈 → 由 scripts/contrast-color.js 合成实际底色、算 WCAG 对比度
// → 打一张「规格 × 主题」的表，并把原始数据落到 shots/contrast-<时间>.json。
//
// 为什么值得单独一个脚本：主题 / 状态色的对比度是**肉眼看不准**的东西（夜间主题的
// warning 色到底差多少、焦点环在浅色纸上够不够醒目），而且改了 `renderer/styles.css`
// 之后必须能一句话复核「改前 4.18 → 改后 5.05」。A-5（无障碍）/ A-6（动效）与以后换主题色都用它。
//
// 用法：
//   node scripts/contrast.js                          # 6 套主题全量，结果落 shots/contrast-<时间>.json
//   node scripts/contrast.js --themes=night,paper      # 只看两套主题
//   node scripts/contrast.js --no-fail                 # 有低于阈值的也不返回非 0（默认会返回 1）
//   node scripts/contrast.js --help
//
// 口径（改脚本前先读）：
//   * 采样的是**浏览器算出来的颜色**（getComputedStyle / 临时探针解析 var() 与 color-mix()），
//     不读 CSS 文本、不硬编码期望值——改了主题色，这张表就跟着变。
//   * 判定阈值：普通文字 4.5:1、大字号文字（>=24px 或 >=18.66px 粗体）3:1、非文字界面图形
//     （焦点环 / 滚动条这类，规格里标 ui）3:1。规则见 scripts/contrast-color.js。
//   * 跟机器 / 窗口 / DPR 无关（颜色不随分辨率变），但**跟主题有关**：换主题色就跑一遍。
//   * 书库与配置全在临时目录（绝不碰真实书架），跑完只留临时目录（删除动作一律不进这个项目）。
//
// 退出码：0 = 全部达标；1 = 有低于阈值的（或没拿到结果）；`--no-fail` 时永远 0。

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { clampInt } = require('../core/common');
const storage = require('../core/storage');
const chaptersLib = require('../core/chapters');
const { tableLines } = require('./table');
const color = require('./contrast-color');
const { SPECS } = require('./contrast-driver');

const ROOT = path.resolve(__dirname, '..');
const THEMES = ['paper', 'cream', 'green', 'kraft', 'grid', 'night'];
// 采样分三段：书架（打开书之前）、写作页（普通章）、写作页（当前章变脏后，主按钮启用态）。
const VIEWS = ['shelf', 'editor', 'dirty'];
const VIEW_LABELS = { shelf: '书架', editor: '写作页', dirty: '写作页（有未保存修改）' };

const DEFAULTS = { themes: THEMES.slice(), out: null, timeout: 120000, failOnLow: true, help: false };

// ---------- 参数 ----------

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (const raw of argv || []) {
    if (raw === '--help' || raw === '-h') {
      opts.help = true;
      continue;
    }
    if (raw === '--no-fail') {
      opts.failOnLow = false;
      continue;
    }
    const hit = /^--([a-z-]+)(?:=(.*))?$/.exec(String(raw));
    if (!hit) continue;
    const key = hit[1];
    const value = hit[2];
    if (key === 'themes') {
      const wanted = String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => THEMES.includes(item));
      if (wanted.length) opts.themes = THEMES.filter((theme) => wanted.includes(theme)); // 固定顺序，方便对比
    } else if (key === 'out') {
      opts.out = value ? String(value) : null;
    } else if (key === 'timeout') {
      opts.timeout = clampInt(value, DEFAULTS.timeout, [10000, 600000]);
    }
  }
  if (!opts.themes.length) opts.themes = THEMES.slice();
  return opts;
}

function usageText() {
  return [
    '章节写作器 · 对比度审计（只读，v0.9 A-4）',
    '',
    '用法：node scripts/contrast.js [选项]',
    '',
    '  --themes=列表    只量这几套主题（paper,cream,green,kraft,grid,night；默认全部）',
    '  --out=路径       结果 JSON 落点（默认 shots/contrast-<时间>.json）',
    '  --timeout=MS     整个审计进程超时（默认 120000）',
    '  --no-fail        有低于阈值的也不返回非 0（默认返回 1）',
    '  --help           打这份说明',
    '',
    '说明：临时书库建在系统临时目录（绝不碰真实书架），采样的是浏览器算出来的真实颜色。'
  ].join('\n');
}

// ---------- 结论（纯函数，单测用） ----------

// 把驱动带回来的原始采样逐条算成结论。没采到的（元素不存在）单独标 missing：
// optional 的只是「这次没这个界面」，不算失败；非 optional 的缺了要报出来。
function evaluateSamples(rawSamples) {
  return (rawSamples || []).map((sample) => {
    const base = {
      view: sample.view,
      theme: sample.theme,
      key: sample.key,
      label: sample.label,
      ui: Boolean(sample.ui),
      found: Boolean(sample.found),
      optional: Boolean(sample.optional),
      source: sample.source || '',
      error: sample.error || null,
      bgImage: sample.bgImage && sample.bgImage !== 'none' ? sample.bgImage : null,
      rawColor: sample.color || null,
      rawBgStack: Array.isArray(sample.bgStack) ? sample.bgStack : null
    };
    if (!base.found) {
      return { ...base, ratio: null, required: null, grade: 'missing', pass: false, missing: true };
    }
    const verdict = color.evaluate({
      label: sample.label,
      color: sample.color,
      bgStack: sample.bgStack,
      fontSize: sample.fontSize,
      fontWeight: sample.fontWeight,
      ui: sample.ui
    });
    return { ...base, ...verdict, missing: false };
  });
}

// 汇总：按「缺省必须达标」的口径统计（optional 的缺失不算失败；找到了就照样要求达标）。
function summarize(rows) {
  const list = rows || [];
  const total = list.filter((row) => !row.missing).length;
  const pass = list.filter((row) => !row.missing && row.pass).length;
  const fail = list.filter((row) => !row.missing && !row.pass).length;
  const missing = list.filter((row) => row.missing && !row.optional).length;
  const skipped = list.filter((row) => row.missing && row.optional).length;
  return { total, pass, fail, missing, skipped, ok: fail === 0 && missing === 0 };
}

// 规格顺序（报告按 SPECS 的顺序排：书架在上、写作页在中、启用态在最后）。
function orderedKeys(view) {
  return (SPECS[view] || []).map((spec) => spec.key);
}

function specOf(view, key) {
  return (SPECS[view] || []).find((spec) => spec.key === key) || null;
}

// 折成「规格 × 主题」的行，供打表与 JSON 共用。
function buildRows(rows) {
  const byView = new Map();
  for (const row of rows || []) {
    if (!byView.has(row.view)) byView.set(row.view, new Map());
    const group = byView.get(row.view);
    if (!group.has(row.key)) group.set(row.key, { key: row.key, label: row.label, cells: {} });
    const item = group.get(row.key);
    item.cells[row.theme] = row;
    item.ui = Boolean(row.ui);
    item.required = row.required;
  }
  const out = [];
  for (const view of VIEWS) {
    const group = byView.get(view);
    if (!group) continue;
    const keys = orderedKeys(view).filter((key) => group.has(key));
    for (const key of keys) out.push({ view, ...group.get(key) });
  }
  return out;
}

// ---------- 打表 ----------

function fixed(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
}

function cellText(cell) {
  if (!cell) return '—';
  if (cell.missing) return cell.optional ? '—' : '缺采样';
  const mark = cell.pass ? '✓' : '✗';
  return `${fixed(cell.ratio)}${mark}`;
}

function formatLines(report) {
  const lines = [];
  const env = report.env || {};
  const fixtures = report.fixtures || {};
  const summary = report.summary || {};
  const themes = report.themes || [];
  const spec = specOf('editor', 'token.focusRing');
  lines.push('== 章节写作器 · 对比度审计（v0.9 A-4，只读）==');
  lines.push(
    `窗口 ${env.windowSize || '?'} · DPR ${env.dpr == null ? '?' : env.dpr} · ` +
      `页面可见性 ${env.visibility || '?'} · 颜色过渡 ${env.transitionsOff ? '已关（读最终色）' : '未关（可能读到中间帧）'}`
  );
  lines.push(`主题 ${themes.length} 套：${themes.join(' / ')}`);
  lines.push(`临时书库 ${fixtures.booksRoot || '?'}`);
  lines.push(
    `口径：浏览器算出来的实际颜色（含 rgba 叠加与 var / color-mix 解析）；` +
      `普通文字 4.5:1、大字号文字与界面图形 3:1；✓ 达标 / ✗ 不达标 / — 这套主题下没有这个界面`
  );
  lines.push(
    `结果：${summary.pass}/${summary.total} 条达标` +
      (summary.fail ? `，**${summary.fail} 条不达标**` : '') +
      (summary.missing ? `，${summary.missing} 条缺采样` : '')
  );
  lines.push('');

  let currentView = null;
  for (const row of report.rows || []) {
    if (row.view !== currentView) {
      currentView = row.view;
      lines.push(`【${VIEW_LABELS[row.view] || row.view}】`);
    }
    const required = row.required == null ? (row.ui ? 3 : 4.5) : row.required;
    const table = [
      ['项目', '要求', ...themes],
      [row.label, `${required}:1`, ...themes.map((theme) => cellText(row.cells[theme]))]
    ];
    for (const line of tableLines(table)) lines.push(`  ${line}`);
  }

  const notes = [];
  if (spec) notes.push('焦点环的采样位置见 scripts/contrast-driver.js 的 SPECS（令牌解析成实际 rgb）。');
  const textured = (report.rows || []).some((row) =>
    themes.some((theme) => row.cells[theme] && row.cells[theme].bgImage)
  );
  if (textured) notes.push('牛皮纸 / 网格纸带 CSS 纹理（alpha ≤ .10），底色按纯纸色算，未把纹理计入。');
  if (notes.length) {
    lines.push('');
    for (const note of notes) lines.push(`  · ${note}`);
  }
  return lines;
}

// ---------- 夹具 ----------

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 只许在系统临时目录里造书库：传进来的临时根必须落在 os.tmpdir() 下，
// 并且绝不能是作者的真实书架（这条闸门是防止「路径写错一次就动真书」）。
function assertTempRoot(base) {
  const target = path.resolve(String(base || ''));
  if (!isInside(path.resolve(os.tmpdir()), target)) {
    throw new Error(`临时书库必须在系统临时目录下：${target}`);
  }
  return target;
}

async function createFixtures(base) {
  const booksRoot = path.join(base, 'books');
  await fsp.mkdir(booksRoot, { recursive: true });

  // 一本「什么都有」的演练书：分卷 / 章节备注 / 完稿状态 / 作者 / 简介 / 分组 / 标签。
  // 第 1 章故意留空正文 —— 这样写作页的「正文占位提示」也在采样范围里。
  const created = await storage.createBook(booksRoot, '对比度演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章 起风');
  await storage.createChapter(bookPath, 2, '第三章 夜雨');
  const baseMeta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, baseMeta.chapters[0].file, '');
  await storage.saveChapterText(bookPath, baseMeta.chapters[1].file, '风从窗缝里挤进来，灯芯跳了一下。\n\n雨还在下。');
  await storage.saveChapterText(bookPath, baseMeta.chapters[2].file, '旧车站的钟停在四点十七分。');
  const meta = await storage.readBookMeta(bookPath);
  meta.volumes = [{ id: 'v1', name: '第一卷 秋' }];
  meta.chapters = meta.chapters.map((chapter, index) => ({
    ...chapter,
    volumeId: index === 0 ? null : 'v1',
    note: index === 1 ? '回头补一段' : '',
    status: index === 1 ? 'done' : 'draft'
  }));
  meta.author = '演练作者';
  meta.brief = '只用来量对比度的临时书，不进真实书架。';
  meta.group = '演练';
  meta.tags = ['对比度', '临时'];
  await storage.writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder(meta));

  // 同步盘冲突副本（只在书文件夹里多一个文件名，不改书目）：书架书卡上会出现冲突提示。
  await fsp.writeFile(path.join(bookPath, '001-起风-冲突副本.txt'), '冲突副本', 'utf8');

  // 书目坏掉的书：书架上会画成「损坏」书卡（`.book-card.corrupt`），用于采那个红色标题。
  const corruptPath = path.join(booksRoot, '损坏的书');
  await fsp.mkdir(corruptPath, { recursive: true });
  await fsp.writeFile(path.join(corruptPath, '书目.json'), '{ 这不是 json', 'utf8');
  await fsp.writeFile(path.join(corruptPath, '001-断章.txt'), '断章', 'utf8');

  return { booksRoot, bookPath, corruptPath };
}

// ---------- 跑起来 ----------

function machineInfo() {
  const cpus = os.cpus() || [];
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus.length ? String(cpus[0].model || '').trim() : '',
    node: process.version
  };
}

function spawnContrast({ base, fixtures, opts }) {
  const userData = path.join(base, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const args = [
    path.join(ROOT, 'scripts', 'start.js'),
    '--contrast',
    `--user-data=${userData}`,
    `--books-root=${fixtures.booksRoot}`,
    `--contrast-book=${fixtures.bookPath}`,
    `--contrast-chapter=0`,
    `--contrast-themes=${opts.themes.join(',')}`
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
  const hit = /CONTRAST_RESULT (.+)/.exec(String(stdout || ''));
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
  return path.join(ROOT, 'shots', `contrast-${stamp(when)}.json`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usageText());
    return 0;
  }
  const startedAt = new Date();
  const base = path.join(os.tmpdir(), `cw-contrast-${stamp(startedAt)}-${process.pid}`);
  assertTempRoot(base);
  console.log(`[contrast] 临时目录：${base}`);
  const buildStart = Date.now();
  const fixtures = await createFixtures(base);
  const buildMs = Date.now() - buildStart;
  console.log(`[contrast] 夹具建好（${buildMs} ms），启动 Electron 采样 ${opts.themes.length} 套主题…`);

  const run = await spawnContrast({ base, fixtures, opts });
  const result = pickResult(run.stdout);
  if (!result) {
    console.error('[contrast] 没有拿到结果，应用可能启动失败。');
    console.error(tail(run.stdout));
    console.error(tail(run.stderr));
    if (run.timedOut) console.error(`[contrast] 超时（${opts.timeout} ms）`);
    return 1;
  }
  if (!result.ok) {
    console.error(`[contrast] 采样失败：${result.error || '未知错误'}`);
    console.error(tail(run.stdout));
    console.error(tail(run.stderr));
    return 1;
  }

  const rows = evaluateSamples(result.samples);
  const report = {
    ok: true,
    tool: 'chapter-writer contrast audit (v0.9 A-4)',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    machine: machineInfo(),
    themes: result.themes || opts.themes,
    env: result.env || {},
    fixtures: { ...fixtures, buildMs },
    options: { themes: opts.themes, out: opts.out },
    rows: buildRows(rows),
    samples: rows,
    summary: summarize(rows)
  };
  const outPath = reportPath(opts, new Date());
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(formatLines(report).join('\n'));
  console.log('');
  console.log(`结果 JSON：${outPath}`);
  console.log(`临时书库（可保留 / 可手动删）：${base}`);
  if (report.summary.ok) return 0;
  return opts.failOnLow ? 1 : 0;
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
  THEMES,
  VIEWS,
  parseArgs,
  usageText,
  evaluateSamples,
  summarize,
  buildRows,
  formatLines,
  orderedKeys,
  specOf,
  isInside,
  assertTempRoot,
  createFixtures,
  machineInfo,
  reportPath,
  pickResult,
  main
};
