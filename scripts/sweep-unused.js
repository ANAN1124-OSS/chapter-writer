'use strict';
// 死代码 / 未引用样式扫描器（v0.9 B-4）
//
// 为什么单独一个文件：`renderer/styles.css` 2553 行、`renderer/index.html` 977 行、
// 渲染层 9500 行，靠眼睛找「没人用的类 / id / 函数」必然漏。这个脚本**只读**仓库、
// 零依赖、不写任何文件（报告打到 stdout），跑一遍把「可疑清单」列出来，人工确认后再删。
//
// 它检查四件事：
//   1. CSS 里定义了、但产品代码（HTML + JS 字符串）里从没出现过的类名 / id 选择器；
//   2. HTML 里写了 id、但没有任何代码引用它（`$('x')` / `getElementById` / `for=` / aria 关系）；
//   3. JS 里定义了顶层函数 / 常量、但全仓库（除定义处）一次都没被引用过；
//   4. 同一个选择器在 CSS 里被重复定义（B-4 顺手清理重复样式用）。
//
// 判定口径（**故意偏保守**，宁可漏报也不误报——误删比留着危害大得多）：
//   - 类名的「使用」= 出现在 HTML 的 `class="…"` 里，或任何 JS **字符串字面量**（含模板串）里
//     按空白 / 标点切出来的词。也就是说 `el.className = 'a ' + (x ? 'b' : '')` 这种拼出来的
//     也会被认出来。
//   - **动态拼出来的名字单独一档**：`` `theme-${theme}` `` / `` `lv${level}` `` / `'rule-' + x`
//     这类会在 CSS 里造出一批「代码里搜不到整词」的类名，脚本按字面前缀 / 后缀把它们认成
//     「动态拼出」，与「真没人用」分开报——混在一起必然误删（v0.9 B-4 实测：11 个全是这一类）。
//   - id 的「引用」只认明确的几种写法（`$('id')` / `getElementById` / `querySelector('#id')` /
//     `for=` / `aria-controls` 等关系属性 / `href="#id"`），因为 id 不能靠「字符串里出现过」
//     判定——那样几乎每个词都能撞上。动态拼 id（`$('btn-' + x)`）识别不到，同样需要人工确认。
//   - 产品代码 = `main.js` / `preload.js` / `core/**` / `renderer/**`；
//     测试侧 = `tests/**` / `scripts/e2e-scenario.js`（**只作参考**：仅测试用到 = 产品侧死代码）。
//
// 用法：
//   node scripts/sweep-unused.js            # 摘要（未引用清单）
//   node scripts/sweep-unused.js --verbose  # 连「只被测试引用」的也列出来
//   node scripts/sweep-unused.js --json     # 给测试 / 脚本用的结构化结果

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 不参与扫描的目录（构建产物 / 依赖 / 截图 / 临时书库）
const SKIP_DIRS = new Set(['node_modules', 'dist', 'shots', '.git', 'build', 'tests-fixture']);

// 产品侧 JS / HTML（相对路径，正斜杠）
const PRODUCT_DIRS = ['core', 'renderer'];
const PRODUCT_FILES = ['main.js', 'preload.js'];
// 测试侧（只用来区分「仅测试引用」）
const TEST_FILES = ['scripts/e2e-scenario.js'];
const TEST_DIRS = ['tests'];

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------- CSS 解析

// 去掉 /* … */ 注释，但**保留长度**（换行原样留下），这样后续算行号不会错位。
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// 把 CSS 拆成样式规则（跳过 @media / @supports 这类容器本身，但进入它们的内部）。
// 返回 [{ selector, line, media, props }]，按出现顺序；media = 所在条件块的选择器（顶层是 ''），
// props = 这条规则里声明的属性名（小写，用来判「同选择器同属性」的真重复）。
// 记 media 是为了区分「同一个选择器真写了两遍」和「@media 里的响应式覆盖」——
// 后者看着重复，其实是窄窗口的另一套值，删了就破版（v0.9 B-4 踩过）。
function parseCssRules(css) {
  const text = stripCssComments(css);
  const rules = [];
  const frames = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      depth++;
      // @ 开头的是容器（@media 等），后续子规则仍然要解析
      if (prelude.startsWith('@') || !prelude) {
        frames.push({ kind: 'at', depth, prelude });
      } else {
        const rule = {
          selector: prelude,
          line: lineOf(text, i - prelude.length),
          media: '',
          props: [],
          bodyStart: i + 1,
          bodyEnd: text.length,
        };
        for (let f = frames.length - 1; f >= 0; f--) {
          if (frames[f].kind === 'at') {
            rule.media = frames[f].prelude || '';
            break;
          }
        }
        rules.push(rule);
        frames.push({ kind: 'rule', depth, rule });
      }
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      while (frames.length && frames[frames.length - 1].depth > depth) {
        const frame = frames.pop();
        if (frame.kind === 'rule') frame.rule.bodyEnd = i;
      }
      buf = '';
    } else if (ch === ';') {
      buf = ''; // @charset / @import 语句，或声明分隔
    } else {
      buf += ch;
    }
  }
  for (const rule of rules) {
    rule.props = declaredProps(text.slice(rule.bodyStart, rule.bodyEnd));
    delete rule.bodyStart;
    delete rule.bodyEnd;
  }
  return rules;
}

// 从声明块文本里抽属性名（`color: red; margin: 0` → ['color', 'margin']）。
// 自定义属性（--x）也算；先剔掉引号里的内容（`background: url("a;b:c")` 不能把 b 当属性名），
// 嵌套块（@media 里套 @supports 之类）不深入。
function declaredProps(body) {
  const props = [];
  const flat = body.replace(/"[^"]*"|'[^']*'/g, '""');
  for (const part of flat.split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim().toLowerCase();
    if (!/^[-a-z][-a-z0-9]*$/.test(name)) continue;
    if (!props.includes(name)) props.push(name);
  }
  return props;
}

// 从选择器文本里抽出类名 / id（含 `.a.b`、`.a .b`、`a:hover > .b` 这种复合情形）。
// 属性选择器里的 `#` 不会出现在选择器里（`[href="#x"]` 会，故先剔掉方括号内容）。
function namesInSelector(selector) {
  const cleaned = selector.replace(/\[[^\]]*\]/g, ' ');
  const classes = [];
  const ids = [];
  for (const m of cleaned.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.push(m[1]);
  for (const m of cleaned.matchAll(/#(-?[A-Za-z_][\w-]*)/g)) ids.push(m[1]);
  return { classes, ids };
}

// 汇总 CSS 里所有类 / id 及其出现行号（同一名字多处出现时全部记下）
function cssIndex(css) {
  const rules = parseCssRules(css);
  const classes = new Map();
  const ids = new Map();
  for (const rule of rules) {
    const found = namesInSelector(rule.selector);
    for (const name of found.classes) {
      if (!classes.has(name)) classes.set(name, []);
      classes.get(name).push(rule.line);
    }
    for (const name of found.ids) {
      if (!ids.has(name)) ids.set(name, []);
      ids.get(name).push(rule.line);
    }
  }
  return { rules, classes, ids };
}

// 同一选择器重复定义的组（按「所在条件块 + 规范化（空白压缩 + 逗号排序）后的选择器」统计）。
// 两档，性质完全不同：
//   - dupes（真重复）：同一条件块里写了两次以上，**且至少一个属性两边都声明** —— 后写的必然
//     盖掉前一份，前一份是死声明，删掉安全（本仓库当前为 0）。
//   - 只追加新属性（例如第二个 `:root` 补 `--reading-*` 变量、互不覆盖）不算重复，不报。
//   - mediaOverrides：同名选择器出现在不同条件块（`@media` 里的响应式覆盖）—— 正常，别删。
function duplicateSelectors(rules) {
  const seen = new Map();
  const crossMedia = new Map();
  for (const rule of rules) {
    const key = rule.selector
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join(',');
    if (!key) continue;
    const scoped = `${rule.media}\u0000${key}`;
    if (!seen.has(scoped)) seen.set(scoped, { selector: key, media: rule.media, blocks: [] });
    seen.get(scoped).blocks.push({ line: rule.line, props: rule.props || [] });
    if (!crossMedia.has(key)) crossMedia.set(key, { selector: key, medias: [] });
    const entry = crossMedia.get(key);
    const media = rule.media || '(顶层)';
    if (!entry.medias.includes(media)) entry.medias.push(media);
  }
  const dupes = [];
  for (const entry of seen.values()) {
    if (entry.blocks.length < 2) continue;
    // 统计「哪些属性在 ≥2 个声明块里出现」——那些属性在前面的块里永远不生效
    const owners = new Map();
    for (const block of entry.blocks) for (const prop of block.props) owners.set(prop, (owners.get(prop) || 0) + 1);
    const overridden = [...owners.entries()].filter(([, n]) => n > 1).map(([prop]) => prop).sort();
    if (!overridden.length) continue;
    dupes.push({
      selector: entry.selector,
      media: entry.media,
      lines: entry.blocks.map((b) => b.line),
      overridden,
    });
  }
  dupes.sort((a, b) => a.lines[0] - b.lines[0]);
  const mediaOverrides = [];
  for (const entry of crossMedia.values()) if (entry.medias.length > 1) mediaOverrides.push(entry);
  mediaOverrides.sort((a, b) => a.selector.localeCompare(b.selector));
  return { dupes, mediaOverrides };
}

// ---------------------------------------------------------------- HTML 解析

// HTML 里的 id 定义（`id="x"`），返回 [{ id, line }]
function htmlIds(html) {
  const out = [];
  for (const m of html.matchAll(/\sid\s*=\s*"([^"]*)"/g)) {
    const id = m[1].trim();
    if (id) out.push({ id, line: lineOf(html, m.index) });
  }
  for (const m of html.matchAll(/\sid\s*=\s*'([^']*)'/g)) {
    const id = m[1].trim();
    if (id) out.push({ id, line: lineOf(html, m.index) });
  }
  return out;
}

// HTML 的静态 class 属性值 → 词表
function htmlClassTokens(html) {
  const tokens = new Set();
  for (const m of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = (m[1] ?? m[2] ?? '').trim();
    for (const t of value.split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

// ---------------------------------------------------------------- JS 字符串字面量

// 抽出 JS 里所有字符串字面量（单引号 / 双引号 / 模板串），返回 [{ value, index }]。
// 正则字面量 / 注释里的引号会被误当字符串开始——对本用途（只会让词表变大 = 更保守）无害；
// 但为了别把整份文件吞进一个字符串，遇到换行就放弃这一处。
function jsStringLiterals(code) {
  const out = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let buf = '';
      let closed = false;
      while (j < n) {
        const c = code[j];
        if (c === '\\') {
          // 转义按真实字符还原：`\n` 是换行而不是字母 n（否则模板串末尾的 `\n` 会被当成
          // 「以字母 n 结尾的动态类名形状」，把一堆正常类名误判成动态拼出）
          const esc = code[j + 1];
          buf += esc === 'n' ? '\n' : esc === 'r' ? '\r' : esc === 't' ? '\t' : (esc ?? '');
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        if (c === '\n' && quote !== '`') break; // 单行字符串没闭合，当作不是字符串
        buf += c;
        j++;
      }
      if (closed) {
        out.push({ value: buf, index: i, end: j });
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

// 把字符串值切成「词」（按空白与常见分隔符），用于类名比对
function splitTokens(value) {
  const out = [];
  for (const part of value.split(/[\s"'`,;{}()[\]<>=+/\\|&!?:*~^$#@%]+/)) {
    if (part) out.push(part);
  }
  return out;
}

// 找出「动态拼出来的类名」的形状：模板串 / 字符串拼接。
// 返回 [{ prefix, suffix, kind }]，kind = 'template' | 'concat'。
//   `theme-${theme}`      → { prefix: 'theme-', suffix: '' }
//   `lv${item.level}`     → { prefix: 'lv', suffix: '' }
//   'rule-' + x           → { prefix: 'rule-', suffix: '' }（字面量紧邻 + 号）
//   'x-' + y + '-on'      → 两条：prefix 'x-'、suffix '-on'
// 取一段字面文本里「结尾那个可能拼上类名的词」：
//   `proofread-rule rule-${x}` 的前段 → `rule-`
//   `<span class="x-` 的前段      → `x-`（innerHTML 拼 class 的常见写法，得从 `class="` 之后算）
function trailingClassToken(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const quoted = /class\s*=\s*"([^"]*)$/.exec(trimmed) || /class\s*=\s*'([^']*)$/.exec(trimmed);
  const scope = quoted ? quoted[1] : trimmed;
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function dynamicClassPatterns(code) {
  const patterns = [];
  for (const lit of jsStringLiterals(code)) {
    const value = lit.value;
    if (value.includes('${')) {
      // 模板串：按插值切成片段，取第一段末尾的词当「前缀」、最后一段开头的词当「后缀」
      // （`theme-${t}` → 前缀 theme-；`x-${a}-on` → 前缀 x- + 后缀 -on）
      const parts = value.split(/\$\{[^}]*\}/);
      const before = parts[0] || '';
      const after = parts.length > 1 ? parts[parts.length - 1] : '';
      const prefix = trailingClassToken(before);
      const suffix = after.trim() ? after.trim().split(/\s+/)[0] : '';
      if (prefix || suffix) patterns.push({ prefix, suffix, kind: 'template' });
      continue;
    }
    // 拼接：字面量紧邻 + 号，且以分隔符收尾 / 开头（end 是闭合引号的位置，别用 value.length 推）
    const tail = code.slice(lit.end + 1, lit.end + 10);
    const head = code.slice(Math.max(0, lit.index - 10), lit.index);
    const token = value.trim();
    if (!token) continue;
    if (/^\s*\+/.test(tail) && /[-_]$/.test(token)) {
      const prefix = trailingClassToken(value);
      if (prefix) patterns.push({ prefix, suffix: '', kind: 'concat' });
    } else if (/\+\s*$/.test(head) && /^[-_]/.test(token)) {
      patterns.push({ prefix: '', suffix: token, kind: 'concat' });
    }
  }
  return patterns;
}

// 类名是否可能由某个动态形状拼出
function matchesDynamicPattern(name, patterns) {
  for (const p of patterns) {
    if (p.prefix && p.suffix) {
      if (name.startsWith(p.prefix) && name.endsWith(p.suffix) && name.length > p.prefix.length + p.suffix.length) return p;
      continue;
    }
    if (p.prefix && name.startsWith(p.prefix) && name.length > p.prefix.length) return p;
    if (p.suffix && name.endsWith(p.suffix) && name.length > p.suffix.length) return p;
  }
  return null;
}

// JS 里的 id 引用（明确写法，见文件头「判定口径」）
function jsIdReferences(code) {
  const set = new Set();
  // $('x') / getElementById('x')
  for (const m of code.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) set.add(m[1]);
  for (const m of code.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) set.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) set.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) set.add(m[1]);
  // querySelector('#a') / querySelectorAll('#a .b') / closest('#a .b')：只取选择器里第一个 id
  for (const m of code.matchAll(/(?:querySelector(?:All)?|closest)\(\s*'([^']*#[^']+)'\s*\)/g)) {
    const id = firstIdInSelector(m[1]);
    if (id) set.add(id);
  }
  for (const m of code.matchAll(/(?:querySelector(?:All)?|closest)\(\s*"([^"]*#[^"]+)"\s*\)/g)) {
    const id = firstIdInSelector(m[1]);
    if (id) set.add(id);
  }
  return set;
}

// 选择器里第一个 `#id`（`#a .b` → a；`div > #c` → c）
function firstIdInSelector(selector) {
  const m = /#(-?[A-Za-z_][\w-]*)/.exec(selector);
  return m ? m[1] : '';
}

// HTML 内部的 id 关系引用（label for / aria-* / href="#x" / list= 等）
function htmlIdReferences(html) {
  const set = new Set();
  const attrNames = [
    'for',
    'aria-controls',
    'aria-labelledby',
    'aria-describedby',
    'aria-activedescendant',
    'aria-owns',
    'list',
    'form',
    'headers',
    'popovertarget',
  ];
  for (const name of attrNames) {
    const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
    for (const m of html.matchAll(re)) {
      const value = (m[1] ?? m[2] ?? '').trim();
      for (const part of value.split(/\s+/)) if (part) set.add(part);
    }
  }
  for (const m of html.matchAll(/href\s*=\s*"(#[^"]*)"/g)) set.add(m[1].slice(1));
  for (const m of html.matchAll(/href\s*=\s*'(#[^']*)'/g)) set.add(m[1].slice(1));
  return set;
}

// ---------------------------------------------------------------- JS 顶层定义

// 抽出「看起来是模块顶层」的函数 / 常量定义。
// 只认缩进不超过 2 个空格的 `function name(` 与 `const name = (` / `= function` /
// 简单箭头函数——漏掉一些没关系（这个清单只是候选），关键别把方法当顶层。
function jsTopLevelDefs(file, code) {
  const defs = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (indent > 2) continue;
    const trimmed = line.trim();
    let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
    if (m) {
      defs.push({ file, name: m[1], line: i + 1, kind: 'function' });
      continue;
    }
    m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(trimmed);
    if (m) {
      defs.push({ file, name: m[1], line: i + 1, kind: 'arrow' });
      continue;
    }
    m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/.exec(trimmed);
    if (m) {
      defs.push({ file, name: m[1], line: i + 1, kind: 'function' });
      continue;
    }
    m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/.exec(trimmed);
    if (m) defs.push({ file, name: m[1], line: i + 1, kind: 'class' });
  }
  return defs;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWord(text, word) {
  // `$` 与 `-` 都当词内字符：`$pad2` / `pad2-x` 不算命中 `pad2`。
  // 口径取「宁可少算」——少算会让扫描器多报一条候选（人工确认即可），多算会把死代码藏起来。
  const re = new RegExp(`(^|[^\\w$-])${escapeRegExp(word)}(?![\\w$-])`, 'g');
  let count = 0;
  while (re.exec(text)) count++;
  return count;
}

// 模块导出的名字（`module.exports = { a, b, c }` / `module.exports = { a: foo }` / `module.exports.x =`）。
// 只用来列「外部一次都没引用过」的候选，不判断内部是否用到。
function moduleExports(code) {
  const names = [];
  const blockRe = /module\.exports\s*=\s*\{([\s\S]*?)\n?\};?/g;
  for (const block of code.matchAll(blockRe)) {
    const body = block[1];
    // 顶层键：整行形如 `  name,` 或 `  name: value,`（避开嵌套对象里的键：只认缩进 ≤ 2 的行）
    for (const line of body.split('\n')) {
      const indent = line.length - line.trimStart().length;
      if (indent > 2) continue;
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed) continue;
      let m = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (m) {
        names.push({ exported: m[1], internal: m[2] });
        continue;
      }
      m = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (m) names.push({ exported: m[1], internal: m[1] });
    }
  }
  for (const m of code.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.push({ exported: m[1], internal: m[1] });
  }
  // 去重（同一名字可能在两种写法里都出现）
  const seen = new Set();
  return names.filter((n) => {
    if (seen.has(n.exported)) return false;
    seen.add(n.exported);
    return true;
  });
}

// ---------------------------------------------------------------- 主流程

function gather() {
  const files = listFiles(ROOT);
  const productJs = [];
  const productHtml = [];
  const testJs = [];
  const cssFiles = [];

  for (const abs of files) {
    const rel = relOf(abs);
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.css') {
      cssFiles.push(rel);
      continue;
    }
    if (ext !== '.js' && ext !== '.html') continue;
    if (TEST_DIRS.some((d) => rel.startsWith(`${d}/`)) || TEST_FILES.includes(rel)) {
      testJs.push(rel);
      continue;
    }
    if (PRODUCT_DIRS.some((d) => rel.startsWith(`${d}/`)) || PRODUCT_FILES.includes(rel)) {
      if (ext === '.html') productHtml.push(rel);
      else productJs.push(rel);
      continue;
    }
    // 其它（scripts/ 下除 e2e-scenario 之外的辅助脚本）算「产品侧之外的仓库代码」，
    // 既不参与类名判定也不参与死代码判定——它们被 node 直接跑，入口函数不会「被引用」。
  }

  const cssTexts = cssFiles.map((rel) => ({ rel, text: readText(path.join(ROOT, rel)) }));
  const htmlTexts = productHtml.map((rel) => ({ rel, text: readText(path.join(ROOT, rel)) }));
  const productTexts = productJs.map((rel) => ({ rel, text: readText(path.join(ROOT, rel)) }));
  const testTexts = testJs.map((rel) => ({ rel, text: readText(path.join(ROOT, rel)) }));

  // 类名使用词表
  const productClassTokens = new Set();
  for (const { text } of htmlTexts) for (const t of htmlClassTokens(text)) productClassTokens.add(t);
  for (const { text } of productTexts) {
    for (const lit of jsStringLiterals(text)) for (const t of splitTokens(lit.value)) productClassTokens.add(t);
  }
  const testClassTokens = new Set();
  for (const { text } of testTexts) {
    for (const lit of jsStringLiterals(text)) for (const t of splitTokens(lit.value)) testClassTokens.add(t);
  }

  // HTML 定义集合（id + 行号）
  const htmlIdDefs = [];
  for (const { rel, text } of htmlTexts) for (const { id, line } of htmlIds(text)) htmlIdDefs.push({ id, rel, line });
  const htmlIdDefSet = new Set(htmlIdDefs.map((d) => d.id));

  // 「代码里明确读过这个 id」：JS 的 $('x') / getElementById / querySelector('#x')，
  // 以及 HTML 内部的关系属性（label for / aria-controls / href="#x" …）。
  const relationRefs = new Set();
  for (const { text } of htmlTexts) {
    for (const id of htmlIdReferences(text)) relationRefs.add(id);
  }
  const usedIds = new Set();
  for (const { text } of productTexts) for (const id of jsIdReferences(text)) usedIds.add(id);
  for (const id of relationRefs) usedIds.add(id);

  // 间接引用：只在字符串字面量里出现过（`for (const id of ['a-group']) $(id)` 这种）。
  // 单列一档——id 不像类名，光「字符串里出现过」不能算使用（几乎每个词都能撞上），
  // 但完全不算又会把这类间接引用误判成死代码，所以只作「需人工确认」的候选。
  const literalTokens = new Set();
  for (const { text } of productTexts) {
    for (const lit of jsStringLiterals(text)) for (const t of splitTokens(lit.value)) literalTokens.add(t);
  }
  const testIdRefs = new Set();
  for (const { text } of testTexts) for (const id of jsIdReferences(text)) testIdRefs.add(id);

  // CSS 里按 id 写样式的那些 id：即使没有代码读它，它也是「布局 / 样式锚点」，不算死
  const cssIdNames = new Set();
  for (const { text } of cssTexts) {
    for (const name of cssIndex(text).ids.keys()) cssIdNames.add(name);
  }

  // 动态拼出来的类名形状（模板串 / 字符串拼接）
  const dynPatterns = [];
  for (const { text } of productTexts) for (const p of dynamicClassPatterns(text)) dynPatterns.push(p);

  // JS 顶层定义 → 引用计数
  const allProductText = productTexts.map((t) => t.text).join('\n');
  const allTestText = testTexts.map((t) => t.text).join('\n');
  const allCssText = cssTexts.map((t) => t.text).join('\n');
  const defs = [];
  for (const { rel, text } of productTexts) {
    for (const def of jsTopLevelDefs(rel, text)) defs.push(def);
  }
  const deadDefs = [];
  for (const def of defs) {
    // 扣除定义行本身：在同一文件里，`function name` 那次算 1 次
    const prodCount = countWord(allProductText, def.name) - 1;
    const testCount = countWord(allTestText, def.name);
    const cssCount = countWord(allCssText, def.name);
    // 名字可能出现在对象键 / 导出表里（那也是引用），countWord 已覆盖
    if (prodCount <= 0) {
      deadDefs.push({ ...def, testCount, cssCount, prodCount });
    }
  }

  // 模块导出：名字在「定义它的文件之外」一次都没出现过 = 死导出候选。
  // 注意**绝大多数命中是「为了 unittest 才导出」的内部小工具**（文件内自用 N 次、测试侧用几次），
  // 那不是死代码。所以只有「文件内也 0 次自用」才算真死；测试侧也 0 次的再单独标出来。
  const deadExports = [];
  const testOnlyExports = [];
  for (const { rel, text } of productTexts) {
    const others = productTexts
      .filter((t) => t.rel !== rel)
      .map((t) => t.text)
      .join('\n');
    for (const exp of moduleExports(text)) {
      const prodCount = countWord(others, exp.exported);
      if (prodCount > 0) continue;
      const ownCount = countWord(text, exp.internal) - 1; // 自身内部用到几次（0 = 连自己都没用）
      const testCount = countWord(allTestText, exp.exported);
      if (ownCount > 0) continue; // 内部自用 = 活的（导出只是给测试 / 将来用）
      if (testCount > 0) testOnlyExports.push({ file: rel, name: exp.exported, testCount });
      else deadExports.push({ file: rel, name: exp.exported, ownCount, testCount });
    }
  }

  const cssEntries = [];
  for (const { rel, text } of cssTexts) {
    const idx = cssIndex(text);
    for (const [name, lines] of idx.classes) {
      cssEntries.push({ kind: 'class', name, cssFile: rel, lines });
    }
    for (const [name, lines] of idx.ids) {
      cssEntries.push({ kind: 'id', name, cssFile: rel, lines });
    }
  }

  // ① CSS 类名分三档：真没人用 / 动态拼出 / 只被测试用
  const unusedClasses = [];
  const dynamicClasses = [];
  const testOnlyClasses = [];
  for (const entry of cssEntries) {
    if (entry.kind !== 'class') continue;
    if (productClassTokens.has(entry.name)) continue;
    const pattern = matchesDynamicPattern(entry.name, dynPatterns);
    if (pattern) {
      dynamicClasses.push({ ...entry, pattern });
      continue;
    }
    if (testClassTokens.has(entry.name)) {
      testOnlyClasses.push(entry);
      continue;
    }
    unusedClasses.push(entry);
  }

  // ③ CSS 里的 id 选择器：HTML 里没有这个 id
  const unusedCssIds = [];
  for (const entry of cssEntries) {
    if (entry.kind !== 'id') continue;
    if (htmlIdDefSet.has(entry.name)) continue; // HTML 里有这个 id（是否被引用另算）
    unusedCssIds.push(entry);
  }

  // ② HTML id：真没人用 / 只有字符串间接引用 / 只被测试用 / CSS 样式锚点
  const unusedHtmlIds = [];
  const indirectHtmlIds = [];
  const testOnlyHtmlIds = [];
  const styledHtmlIds = [];
  const seenHtmlIds = new Set();
  for (const def of htmlIdDefs) {
    if (seenHtmlIds.has(def.id)) continue;
    seenHtmlIds.add(def.id);
    if (usedIds.has(def.id)) continue;
    if (cssIdNames.has(def.id)) {
      styledHtmlIds.push(def);
      continue;
    }
    if (literalTokens.has(def.id)) {
      indirectHtmlIds.push(def);
      continue;
    }
    if (testIdRefs.has(def.id)) {
      testOnlyHtmlIds.push(def);
      continue;
    }
    unusedHtmlIds.push(def);
  }

  const dupes = [];
  const mediaOverrides = [];
  for (const { rel, text } of cssTexts) {
    const found = duplicateSelectors(parseCssRules(text));
    for (const d of found.dupes) dupes.push({ ...d, cssFile: rel });
    for (const d of found.mediaOverrides) mediaOverrides.push({ ...d, cssFile: rel });
  }

  return {
    counts: {
      cssFiles: cssFiles.length,
      productJs: productJs.length,
      productHtml: productHtml.length,
      testJs: testJs.length,
      cssClasses: cssEntries.filter((e) => e.kind === 'class').length,
      cssIds: cssEntries.filter((e) => e.kind === 'id').length,
      htmlIds: htmlIdDefs.length,
      topLevelDefs: defs.length,
      dynamicPatterns: dynPatterns.length,
      productClassTokens: productClassTokens.size,
      usedIds: usedIds.size,
      exports: productTexts.reduce((n, t) => n + moduleExports(t.text).length, 0),
    },
    unusedClasses,
    dynamicClasses,
    testOnlyClasses,
    unusedCssIds,
    unusedHtmlIds,
    indirectHtmlIds,
    styledHtmlIds,
    testOnlyHtmlIds,
    deadDefs,
    deadExports,
    testOnlyExports,
    dupes,
    mediaOverrides,
  };
}

function formatList(items, render) {
  return items
    .map((item) => `  ${render(item)}`)
    .join('\n');
}

function renderLines(lines) {
  if (!lines || !lines.length) return '';
  if (lines.length === 1) return `:${lines[0]}`;
  return `:${lines[0]} 等 ${lines.length} 处`;
}

function formatReport(result, { verbose = false } = {}) {
  const out = [];
  const c = result.counts;
  out.push('== 扫描范围 ==');
  out.push(
    `  CSS ${c.cssFiles} 个（类 ${c.cssClasses} / id ${c.cssIds}）、产品 JS ${c.productJs} 个、HTML ${c.productHtml} 个、测试 JS ${c.testJs} 个；` +
      `HTML id ${c.htmlIds} 个、JS 顶层定义 ${c.topLevelDefs} 个、模块导出 ${c.exports} 个、动态拼名形状 ${c.dynamicPatterns} 条`,
  );
  out.push('');
  out.push(`== ① CSS 类：定义了但产品代码从没出现（${result.unusedClasses.length}）—— 真死，可删 ==`);
  if (result.unusedClasses.length) {
    out.push(formatList(result.unusedClasses, (e) => `.${e.name}  ${e.cssFile}${renderLines(e.lines)}`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== ② HTML id：没有任何代码引用（${result.unusedHtmlIds.length}）—— 真死，可删 ==`);
  if (result.unusedHtmlIds.length) {
    out.push(formatList(result.unusedHtmlIds, (e) => `#${e.id}  ${e.rel}:${e.line}`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== ③ CSS 里的 id 选择器：HTML 里没这个 id（${result.unusedCssIds.length}）—— 真死，可删 ==`);
  if (result.unusedCssIds.length) {
    out.push(formatList(result.unusedCssIds, (e) => `#${e.name}  ${e.cssFile}${renderLines(e.lines)}`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== ④ JS 顶层定义：全仓库除定义处 0 次引用（${result.deadDefs.length}）—— 真死，可删 ==`);
  if (result.deadDefs.length) {
    out.push(formatList(result.deadDefs, (d) => `${d.name}()  ${d.file}:${d.line}（测试侧引用 ${d.testCount} 次）`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== ⑤ 模块导出：定义文件之外 0 次引用、自己也不用（${result.deadExports.length}）—— 真死，可删 ==`);
  if (result.deadExports.length) {
    out.push(
      formatList(
        result.deadExports,
        (d) => `${d.name}  ${d.file}（文件内自用 ${d.ownCount} 次、测试侧 ${d.testCount} 次）`,
      ),
    );
  } else out.push('  （无）');
  out.push('');
  out.push(`== ⑥ CSS 真重复（同一条件块里同选择器出现多次，${result.dupes.length}）—— 看情况合并 ==`);
  if (result.dupes.length) {
    out.push(formatList(result.dupes, (d) => `${d.selector}  ${d.cssFile}:${d.lines.join(', ')}`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== ⑦ 跨条件块同名规则（@media 里的响应式覆盖，${result.mediaOverrides.length} 组）—— 正常，别删 ==`);
  if (result.mediaOverrides.length) {
    out.push(formatList(result.mediaOverrides, (d) => `${d.selector}  ${d.medias.join(' / ')}`));
  } else out.push('  （无）');
  out.push('');
  out.push(`== 附：只被动态拼出 / 只被测试用的（不是死代码，供核对） ==`);
  out.push(`  动态拼出的类 ${result.dynamicClasses.length} 个：`);
  if (result.dynamicClasses.length) {
    out.push(
      formatList(
        result.dynamicClasses,
        (e) => `.${e.name}  ← ${e.pattern.kind} ${JSON.stringify(e.pattern.prefix)}+*${JSON.stringify(e.pattern.suffix)}`,
      ),
    );
  } else out.push('    （无）');
  out.push(`  只被测试引用的类 ${result.testOnlyClasses.length} 个：`);
  if (result.testOnlyClasses.length) {
    out.push(formatList(result.testOnlyClasses, (e) => `.${e.name}  ${e.cssFile}${renderLines(e.lines)}`));
  } else out.push('    （无）');
  out.push(`  只靠字符串间接引用的 id ${result.indirectHtmlIds.length} 个：`);
  if (result.indirectHtmlIds.length) {
    out.push(formatList(result.indirectHtmlIds, (e) => `#${e.id}  ${e.rel}:${e.line}`));
  } else out.push('    （无）');
  out.push(`  只被 CSS 样式用的 id ${result.styledHtmlIds.length} 个：`);
  if (result.styledHtmlIds.length) {
    out.push(formatList(result.styledHtmlIds, (e) => `#${e.id}  ${e.rel}:${e.line}`));
  } else out.push('    （无）');
  out.push(`  只被测试引用的 id ${result.testOnlyHtmlIds.length} 个：`);
  if (result.testOnlyHtmlIds.length) {
    out.push(formatList(result.testOnlyHtmlIds, (e) => `#${e.id}  ${e.rel}:${e.line}`));
  } else out.push('    （无）');
  out.push(`  只被测试引用的导出 ${result.testOnlyExports.length} 个：`);
  if (result.testOnlyExports.length) {
    out.push(formatList(result.testOnlyExports, (e) => `${e.name}  ${e.file}（测试侧 ${e.testCount} 次）`));
  } else out.push('    （无）');
  if (verbose) {
    out.push('');
    out.push('== 附：全部动态拼名形状 ==');
    for (const p of result.dynamicPatterns || []) {
      out.push(`  ${p.kind}  ${JSON.stringify(p.prefix)}+*+${JSON.stringify(p.suffix)}`);
    }
  }
  return out.join('\n');
}

module.exports = {
  ROOT,
  stripCssComments,
  parseCssRules,
  declaredProps,
  namesInSelector,
  cssIndex,
  duplicateSelectors,
  htmlIds,
  htmlClassTokens,
  htmlIdReferences,
  jsStringLiterals,
  splitTokens,
  dynamicClassPatterns,
  matchesDynamicPattern,
  jsIdReferences,
  jsTopLevelDefs,
  moduleExports,
  countWord,
  gather,
  formatReport,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const result = gather();
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result, { verbose: argv.includes('--verbose') })}\n`);
  }
}
