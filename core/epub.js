// EPUB 导出：把「书目 + 各章正文」拼成一本能直接丢进阅读器 / 发给编辑的 EPUB。
//
// 这里全部是纯函数：不读盘、不依赖 Electron，zip 用 Node 内置 zlib 手拼，
// 不引入任何第三方运行时依赖（项目只有 devDependencies）。
//
// EPUB 结构（EPUB 3，另外带一份 EPUB 2 的 toc.ncx 兜底，老阅读器也能认出目录）：
//   mimetype                        必须第一个、不压缩
//   META-INF/container.xml          指向 OEBPS/content.opf
//   OEBPS/content.opf               元数据 + manifest + spine（+ guide 兼容 EPUB2）
//   OEBPS/nav.xhtml                 EPUB3 目录：分卷 = 二级目录
//   OEBPS/toc.ncx                   EPUB2 目录兜底（分卷同样嵌套）
//   OEBPS/style.css                 段首缩进 2 字 + 段间空一行（和 TXT 导出的排版规则一致）
//   OEBPS/cover.xhtml               纯文字封面页（本书没有封面图，按提案生成文字封面）
//   OEBPS/text/volume-0001.xhtml    有名字的卷各一张卷名页（分卷 → 目录级）
//   OEBPS/text/chapter-0001.xhtml   一章一个 XHTML，文件编号 = 全书章号
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const chaptersLib = require('./chapters');

const EPUB_MIMETYPE = 'application/epub+zip';
const EPUB_DIR = 'OEBPS';
const EPUB_LANGUAGE = 'zh-CN';
const EPUB_VERSION = '3.0';

// 段首缩进 2 字 + 段间留出一整行（line-height 1.75 ⇒ 空行也是 1.75em）。
// 正文里的空行在拼 HTML 时已经被丢掉，段间留白统一由这里负责，避免「双倍行距」。
const STYLE_CSS = `/* 章节写作器导出的 EPUB：段首缩进 2 字、段间空一行 */
html {
  font-size: 100%;
}
body {
  margin: 0 1.2em;
  font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  line-height: 1.75;
  text-align: justify;
}
h1.chapter-title,
h1.part-title {
  font-size: 1.4em;
  font-weight: bold;
  text-align: center;
  text-indent: 0;
  margin: 1.2em 0 1.6em;
}
p {
  text-indent: 2em;
  margin: 0 0 1.75em 0;
}
.cover {
  margin-top: 25%;
  text-align: center;
}
.cover-title {
  font-size: 2em;
  text-indent: 0;
  margin: 0 0 1em 0;
}
.cover-meta {
  font-size: 0.9em;
  color: #666666;
  text-indent: 0;
}
.part {
  margin-top: 30%;
  text-align: center;
}
.part-title {
  text-indent: 0;
}
`;

// ---------- ZIP（store / deflate，手拼，不依赖第三方库） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer == null ? '' : buffer), 'utf8');
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// zip 的时间戳是 DOS 格式（1980 起、2 秒精度）；同一份内容 + 同一个时间 ⇒ 字节完全一样。
function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  };
}

// entries = [{ name, data(Buffer|string), store?: boolean }]
// store=true 的条目原样存（mimetype 必须这样，阅读器靠它判断是不是 EPUB）。
function buildZip(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const stamp = dosDateTime(options && options.date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of list) {
    const name = Buffer.from(String(entry && entry.name ? entry.name : ''), 'utf8');
    if (!name.length) throw new Error('ZIP 条目缺少文件名');
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data == null ? '' : entry.data), 'utf8');
    let method = 0;
    let payload = raw;
    if (!(entry.store === true) && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      // 小文件压完反而更大时仍然原样存，省得白白变胖
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0, 6); // 标志位（文件名全是 ASCII，不用 UTF-8 标志）
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度（mimetype 也必须是 0）
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建者版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 目录结尾记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

// ---------- XML / HTML ----------
// XML 1.0 不允许的控制字符：正文里混进去会让整本书在阅读器里打不开，导出前必须剔掉。
const XML_INVALID_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function stripInvalidXmlChars(text) {
  return String(text == null ? '' : text).replace(XML_INVALID_CHARS, '');
}

function escapeXml(text) {
  return stripInvalidXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 正文 → 段落数组：CRLF / CR 一律归一成 \n，空行丢掉（段间留白交给 CSS），
// 每段去掉首尾空白和 XML 非法控制字符。只动空白，不改字词标点。
function paragraphsFromText(text) {
  const normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of normalized.split('\n')) {
    const clean = stripInvalidXmlChars(line).trim();
    if (clean) out.push(clean);
  }
  return out;
}

function xhtmlDocument({ title, lang, cssHref, body }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">`,
    '<head>',
    '<meta charset="utf-8"/>',
    `<title>${escapeXml(title)}</title>`,
    `<link rel="stylesheet" type="text/css" href="${escapeXml(cssHref)}"/>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function chapterDocument({ title, text, lang, cssHref }) {
  const paragraphs = paragraphsFromText(text);
  const lines = [
    '<section epub:type="chapter" class="chapter">',
    `  <h1 class="chapter-title">${escapeXml(title)}</h1>`
  ];
  for (const paragraph of paragraphs) lines.push(`  <p>${escapeXml(paragraph)}</p>`);
  lines.push('</section>');
  return xhtmlDocument({ title, lang, cssHref, body: lines.join('\n') });
}

function volumeDocument({ title, lang, cssHref }) {
  const body = [
    '<section epub:type="part" class="part">',
    `  <h1 class="part-title">${escapeXml(title)}</h1>`,
    '</section>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

function coverDocument({ title, chapterCount, volumeCount, lang, cssHref }) {
  const meta = [`共 ${chapterCount} 章`];
  if (volumeCount > 0) meta.push(`${volumeCount} 卷`);
  const body = [
    '<section epub:type="cover" class="cover">',
    `  <h1 class="cover-title">${escapeXml(title)}</h1>`,
    `  <p class="cover-meta">${escapeXml(meta.join(' · '))}</p>`,
    '</section>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

// 目录条目：{ label, href, children? }。分卷 = 一个带 children 的条目（二级目录）。
function renderNavList(items, depth) {
  const pad = '  '.repeat(depth);
  const lines = [`${pad}<ol>`];
  for (const item of items) {
    if (item.children && item.children.length) {
      lines.push(`${pad}  <li>`);
      lines.push(`${pad}    <a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a>`);
      lines.push(...renderNavList(item.children, depth + 2));
      lines.push(`${pad}  </li>`);
    } else {
      lines.push(`${pad}  <li><a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a></li>`);
    }
  }
  lines.push(`${pad}</ol>`);
  return lines;
}

function navDocument({ title, lang, items, cssHref }) {
  const body = [
    '<nav epub:type="toc" id="toc">',
    '  <h1>目录</h1>',
    ...renderNavList(items, 1),
    '</nav>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

function navDepth(items) {
  let depth = 1;
  for (const item of items) {
    if (item.children && item.children.length) depth = Math.max(depth, 1 + navDepth(item.children));
  }
  return depth;
}

function renderNavPoints(items, depth, counter) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const item of items) {
    counter.value += 1;
    const order = counter.value;
    lines.push(`${pad}<navPoint id="np${order}" playOrder="${order}">`);
    lines.push(`${pad}  <navLabel><text>${escapeXml(item.label)}</text></navLabel>`);
    lines.push(`${pad}  <content src="${escapeXml(item.href)}"/>`);
    if (item.children && item.children.length) {
      lines.push(...renderNavPoints(item.children, depth + 1, counter));
    }
    lines.push(`${pad}</navPoint>`);
  }
  return lines;
}

function ncxDocument({ title, identifier, lang, items }) {
  const depth = navDepth(items);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="' + escapeXml(lang) + '">',
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>`,
    `    <meta name="dtb:depth" content="${depth}"/>`,
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    `  <docTitle><text>${escapeXml(title)}</text></docTitle>`,
    '  <navMap>',
    ...renderNavPoints(items, 2, { value: 0 }),
    '  </navMap>',
    '</ncx>',
    ''
  ].join('\n');
}

function containerDocument() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    `    <rootfile full-path="${EPUB_DIR}/content.opf" media-type="application/oebps-package+xml"/>`,
    '  </rootfiles>',
    '</container>',
    ''
  ].join('\n');
}

function opfDocument({ title, identifier, modified, lang, manifest, spine }) {
  const manifestLines = manifest.map((item) => {
    const properties = item.properties ? ` properties="${escapeXml(item.properties)}"` : '';
    return `    <item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"${properties}/>`;
  });
  const spineLines = spine.map((idref) => `    <itemref idref="${escapeXml(idref)}"/>`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="${EPUB_VERSION}" unique-identifier="pub-id" xml:lang="${escapeXml(lang)}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(lang)}</dc:language>`,
    `    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`,
    '    <meta name="cover" content="cover"/>',
    '  </metadata>',
    '  <manifest>',
    ...manifestLines,
    '  </manifest>',
    '  <spine toc="ncx">',
    ...spineLines,
    '  </spine>',
    '  <guide>',
    '    <reference type="cover" title="封面" href="cover.xhtml"/>',
    '    <reference type="toc" title="目录" href="nav.xhtml"/>',
    '  </guide>',
    '</package>',
    ''
  ].join('\n');
}

// ---------- 书籍结构 ----------
function chapterList(meta) {
  return meta && Array.isArray(meta.chapters) ? meta.chapters : [];
}

function volumeList(meta) {
  return meta && Array.isArray(meta.volumes) ? meta.volumes : [];
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

// 按书目顺序把章节分组成「卷」。顺序在 storage 读取时已经归一成
// 「未分卷 → 第1卷 → 第2卷 …」，这里只按连续段切分；没有名字的卷当作未分卷平铺。
function groupChapters(meta) {
  const chapters = chapterList(meta);
  const volumes = new Map();
  for (const volume of volumeList(meta)) {
    if (volume && typeof volume.id === 'string') {
      volumes.set(volume.id, String(volume.name == null ? '' : volume.name).trim());
    }
  }
  const groups = [];
  chapters.forEach((chapter, index) => {
    const volumeId = chapter && chapter.volumeId ? String(chapter.volumeId) : null;
    const name = volumeId && volumes.has(volumeId) ? volumes.get(volumeId) : '';
    const last = groups[groups.length - 1];
    if (!last || last.volumeId !== volumeId) {
      groups.push({ volumeId, name, indexes: [index] });
    } else {
      last.indexes.push(index);
    }
  });
  return groups;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return { date: safe, iso: safe.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// 书目 id 稳定 ⇒ 同一本书每次导出 identifier 不变（阅读器不会当成新书重复导入）。
// 按 UUID v5 的形状补上版本位 / 变体位，避免阅读器校验 identifier 时报「不是合法 UUID」。
function bookIdentifier(seed) {
  const hex = crypto
    .createHash('sha1')
    .update(String(seed == null ? '' : seed))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeInput(input) {
  const meta = (input && input.meta) || {};
  const chapters = chapterList(meta);
  if (!chapters.length) throw new Error('EMPTY_BOOK：这本书里还没有章节');
  const texts = Array.isArray(input && input.texts) ? input.texts : [];
  const title = String(meta.title == null ? '' : meta.title).trim() || '未命名书籍';
  const lang =
    typeof (input && input.language) === 'string' && input.language.trim()
      ? input.language.trim()
      : EPUB_LANGUAGE;
  const identifier =
    typeof (input && input.identifier) === 'string' && input.identifier.trim()
      ? input.identifier.trim()
      : bookIdentifier(meta.id || title);
  const stamp = isoTimestamp(input && input.modified);
  return { meta, chapters, texts, title, lang, identifier, stamp };
}

function buildBundle(input) {
  const { meta, chapters, texts, title, lang, identifier, stamp } = normalizeInput(input);
  const groups = groupChapters(meta);
  const files = [];
  const manifest = [];
  const spine = [];
  const navItems = [];
  let volumeCount = 0;

  files.push({ name: 'mimetype', data: EPUB_MIMETYPE, store: true });
  files.push({ name: 'META-INF/container.xml', data: containerDocument() });

  manifest.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' });
  manifest.push({ id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' });
  manifest.push({ id: 'css', href: 'style.css', mediaType: 'text/css' });
  manifest.push({ id: 'cover', href: 'cover.xhtml', mediaType: 'application/xhtml+xml' });
  spine.push('cover');

  for (const group of groups) {
    const hasVolumePage = Boolean(group.volumeId && group.name);
    let volumeHref = null;
    if (hasVolumePage) {
      volumeCount += 1;
      volumeHref = `text/volume-${pad4(volumeCount)}.xhtml`;
      const id = `vol${volumeCount}`;
      files.push({
        name: `${EPUB_DIR}/${volumeHref}`,
        data: volumeDocument({ title: group.name, lang, cssHref: '../style.css' })
      });
      manifest.push({ id, href: volumeHref, mediaType: 'application/xhtml+xml' });
      spine.push(id);
    }
    const children = [];
    for (const index of group.indexes) {
      const chapter = chapters[index];
      const number = index + 1;
      const href = `text/chapter-${pad4(number)}.xhtml`;
      const id = `ch${number}`;
      // 章名 / 章号规则和 TXT 导出完全一致（core/chapters.formatTitle）
      const chapterTitle = chaptersLib.formatTitle(meta, index, chapter && chapter.name);
      const text = texts[index] == null ? '' : texts[index];
      files.push({
        name: `${EPUB_DIR}/${href}`,
        data: chapterDocument({ title: chapterTitle, text, lang, cssHref: '../style.css' })
      });
      manifest.push({ id, href, mediaType: 'application/xhtml+xml' });
      spine.push(id);
      const item = { label: chapterTitle, href };
      if (hasVolumePage) children.push(item);
      else navItems.push(item);
    }
    if (hasVolumePage) navItems.push({ label: group.name, href: volumeHref, children });
  }

  files.push({
    name: `${EPUB_DIR}/nav.xhtml`,
    data: navDocument({ title, lang, items: navItems, cssHref: 'style.css' })
  });
  files.push({
    name: `${EPUB_DIR}/toc.ncx`,
    data: ncxDocument({ title, identifier, lang, items: navItems })
  });
  files.push({ name: `${EPUB_DIR}/style.css`, data: STYLE_CSS });
  files.push({
    name: `${EPUB_DIR}/cover.xhtml`,
    data: coverDocument({
      title,
      chapterCount: chapters.length,
      volumeCount,
      lang,
      cssHref: 'style.css'
    })
  });
  files.push({
    name: `${EPUB_DIR}/content.opf`,
    data: opfDocument({
      title,
      identifier,
      modified: stamp.iso,
      lang,
      manifest,
      spine
    })
  });

  return {
    files,
    chapterCount: chapters.length,
    volumeCount,
    title,
    identifier,
    modified: stamp.iso,
    date: stamp.date
  };
}

// 只产出文件清单（单测用）；写盘请用 buildEpub()
function epubFiles(input) {
  return buildBundle(input).files;
}

// 产出可写盘的 EPUB 字节。
// input = { meta, texts, language?, identifier?, modified?, zipDate? }
//   meta / texts 就绪与 TXT 导出相同的「书目 + 各章正文（顺序对齐）」；
//   modified 默认现在，传固定值可让同样的内容导出成完全一样的字节（单测用）。
function buildEpub(input) {
  const bundle = buildBundle(input);
  const zipDate = (input && input.zipDate) || bundle.date;
  const buffer = buildZip(bundle.files, { date: zipDate });
  return {
    buffer,
    chapterCount: bundle.chapterCount,
    volumeCount: bundle.volumeCount,
    bytes: buffer.length,
    title: bundle.title,
    identifier: bundle.identifier,
    modified: bundle.modified
  };
}

// 导出对话框默认文件名：书名.epub（书名照样清洗非法字符，规则同 TXT）
function epubFileName(meta) {
  return `${chaptersLib.safeName(meta && meta.title)}.epub`;
}

module.exports = {
  EPUB_MIMETYPE,
  EPUB_DIR,
  EPUB_LANGUAGE,
  EPUB_VERSION,
  STYLE_CSS,
  buildZip,
  crc32,
  escapeXml,
  stripInvalidXmlChars,
  paragraphsFromText,
  chapterDocument,
  volumeDocument,
  coverDocument,
  navDocument,
  ncxDocument,
  opfDocument,
  containerDocument,
  groupChapters,
  bookIdentifier,
  epubFiles,
  buildEpub,
  epubFileName
};
