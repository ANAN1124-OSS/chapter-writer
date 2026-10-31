// DOCX 导出：把「书目 + 各章正文」拼成一份 Word 能直接打开的书稿。
//
// 全部是纯函数：不读盘、不依赖 Electron；docx 本质就是一个 zip 包，用 core/zip.js
// 手拼 WordprocessingML（OOXML），不引入任何第三方运行时依赖。
//
// 结构（最小可用 OOXML 包）：
//   [Content_Types].xml            内容类型声明
//   _rels/.rels                    包关系：document / core / app
//   word/document.xml              正文（标题页 + 卷 + 章 + 段落）
//   word/styles.xml                样式（标题 / 卷 / 章 / 正文：段首缩进 2 字、行距 1.5）
//   word/_rels/document.xml.rels   document → styles
//   docProps/core.xml              标题 / 作者 / 修改时间
//   docProps/app.xml               应用程序信息
//
// 支持整本 / 按卷 / 按章节范围导出（v0.8 P0 N9）：范围解析复用
// core/exporter.resolveExportRange（和 TXT / EPUB 导出同一份纯逻辑），
// 只把选中的章节写进文档；章号 / 章名仍按全书顺序，卷标题只生成选中章所在的卷。
const chaptersLib = require('./chapters');
const exporter = require('./exporter');
const { buildZip } = require('./zip');

const DOCX_MIMETYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WORD_LANGUAGE = 'zh-CN';
const WORD_FONT = '宋体';
const WORD_HEADING_FONT = '黑体';
const WORD_BODY_SIZE = 24; // 半磅：24 = 12pt
const WORD_LINE_SPACING = 360; // 240 = 单倍行距，360 = 1.5 倍

// ---------- XML ----------
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

// 正文 → 段落数组：CRLF / CR 归一成 \n，空行丢掉（段间留白交给 Word 样式），
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

function paragraph(style, text, extraProperties) {
  const properties = `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/>${extraProperties || ''}</w:pPr>`;
  return `  <w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function pageBreakParagraph() {
  return '  <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

// ---------- OOXML 部件 ----------
function contentTypesDocument() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="xml" ContentType="application/xml"/>',
    `  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    '  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>',
    ''
  ].join('\n');
}

function packageRelsDocument() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>',
    ''
  ].join('\n');
}

function documentRelsDocument() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>',
    ''
  ].join('\n');
}

function stylesDocument() {
  const spacing = `<w:spacing w:after="0" w:line="${WORD_LINE_SPACING}" w:lineRule="auto"/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:styles xmlns:w="${WORD_NAMESPACE}">`,
    '  <w:docDefaults>',
    '    <w:rPrDefault>',
    '      <w:rPr>',
    '        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="' +
      WORD_FONT +
      '" w:cs="Times New Roman"/>',
    `        <w:sz w:val="${WORD_BODY_SIZE}"/><w:szCs w:val="${WORD_BODY_SIZE}"/>`,
    `        <w:lang w:val="en-US" w:eastAsia="${WORD_LANGUAGE}"/>`,
    '      </w:rPr>',
    '    </w:rPrDefault>',
    '    <w:pPrDefault>',
    `      <w:pPr>${spacing}</w:pPr>`,
    '    </w:pPrDefault>',
    '  </w:docDefaults>',
    '  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
    '    <w:name w:val="Normal"/><w:qFormat/>',
    '  </w:style>',
    '  <w:style w:type="paragraph" w:styleId="Title">',
    '    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/>',
    '    <w:pPr><w:jc w:val="center"/><w:spacing w:before="1440" w:after="240" w:line="' +
      WORD_LINE_SPACING +
      '" w:lineRule="auto"/></w:pPr>',
    `    <w:rPr><w:rFonts w:eastAsia="${WORD_HEADING_FONT}"/><w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>`,
    '  </w:style>',
    '  <w:style w:type="paragraph" w:styleId="Subtitle">',
    '    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>',
    '    <w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr>',
    `    <w:rPr><w:color w:val="595959"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>`,
    '  </w:style>',
    '  <w:style w:type="paragraph" w:styleId="Heading1">',
    '    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Heading2"/><w:qFormat/>',
    '    <w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="480" w:after="360"/></w:pPr>',
    `    <w:rPr><w:rFonts w:eastAsia="${WORD_HEADING_FONT}"/><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>`,
    '  </w:style>',
    '  <w:style w:type="paragraph" w:styleId="Heading2">',
    '    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/>',
    '    <w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="360" w:after="240"/></w:pPr>',
    `    <w:rPr><w:rFonts w:eastAsia="${WORD_HEADING_FONT}"/><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>`,
    '  </w:style>',
    '  <w:style w:type="paragraph" w:styleId="BodyText">',
    '    <w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/>',
    `    <w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:jc w:val="both"/>${spacing}</w:pPr>`,
    '  </w:style>',
    '</w:styles>',
    ''
  ].join('\n');
}

function corePropertiesDocument({ title, author, modified }) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <dc:title>${escapeXml(title)}</dc:title>`,
    `  <dc:creator>${escapeXml(author)}</dc:creator>`,
    `  <cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>`,
    `  <dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(modified)}</dcterms:created>`,
    `  <dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(modified)}</dcterms:modified>`,
    '</cp:coreProperties>',
    ''
  ].join('\n');
}

function appPropertiesDocument() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '  <Application>章节写作器</Application>',
    '  <DocSecurity>0</DocSecurity>',
    '  <ScaleCrop>false</ScaleCrop>',
    '  <AppVersion>1.0</AppVersion>',
    '</Properties>',
    ''
  ].join('\n');
}

function documentBody({ title, author, metaLine, content }) {
  const body = [
    paragraph('Title', title),
    author ? paragraph('Subtitle', author) : '',
    metaLine ? paragraph('Subtitle', metaLine) : '',
    pageBreakParagraph(),
    ...content
  ].filter(Boolean);
  return body;
}

function documentDocument({ title, author, metaLine, content }) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:document xmlns:w="${WORD_NAMESPACE}">`,
    '  <w:body>',
    ...documentBody({ title, author, metaLine, content }),
    '    <w:sectPr>',
    '      <w:pgSz w:w="11906" w:h="16838"/>',
    '      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>',
    '      <w:cols w:space="425"/>',
    '      <w:docGrid w:linePitch="312"/>',
    '    </w:sectPr>',
    '  </w:body>',
    '</w:document>',
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

function isoTimestamp(value) {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return { date: safe, iso: safe.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function normalizeInput(input) {
  const meta = (input && input.meta) || {};
  const chapters = chapterList(meta);
  if (!chapters.length) throw new Error('EMPTY_BOOK：这本书里还没有章节');
  const texts = Array.isArray(input && input.texts) ? input.texts : [];
  const title = String(meta.title == null ? '' : meta.title).trim() || '未命名书籍';
  const author = String(meta.author == null ? '' : meta.author).trim();
  const lang =
    typeof (input && input.language) === 'string' && input.language.trim()
      ? input.language.trim()
      : WORD_LANGUAGE;
  // 范围解析和 TXT / EPUB 导出共用同一份纯逻辑：只读，不改 meta。
  const plan = exporter.resolveExportRange(meta, input && input.range);
  if (!plan.count) throw new Error('EMPTY_EXPORT_RANGE：所选范围里没有章节');
  const stamp = isoTimestamp(input && input.modified);
  return { meta, chapters, texts, title, author, lang, stamp, plan };
}

function buildBundle(input) {
  const { meta, chapters, texts, title, author, lang, stamp, plan } = normalizeInput(input);
  const volumes = new Map();
  for (const volume of volumeList(meta)) {
    if (volume && typeof volume.id === 'string') {
      volumes.set(volume.id, String(volume.name == null ? '' : volume.name).trim());
    }
  }

  const content = [];
  let volumeCount = 0;
  let currentVolumeId = null;
  for (const index of plan.indexes) {
    const chapter = chapters[index];
    const volumeId = chapter && chapter.volumeId ? String(chapter.volumeId) : null;
    if (volumeId !== currentVolumeId) {
      currentVolumeId = volumeId;
      const volumeName = volumeId && volumes.has(volumeId) ? volumes.get(volumeId) : '';
      if (volumeName) {
        content.push(paragraph('Heading1', volumeName));
        volumeCount += 1;
      }
    }
    const chapterTitle = chaptersLib.formatTitle(meta, index, chapter && chapter.name);
    content.push(paragraph('Heading2', chapterTitle));
    for (const text of paragraphsFromText(texts[index])) {
      content.push(paragraph('BodyText', text));
    }
  }

  const metaBits = [];
  if (plan.mode !== 'all') metaBits.push(plan.label);
  metaBits.push(`共 ${plan.count} 章`);
  if (volumeCount > 0) metaBits.push(`${volumeCount} 卷`);
  const metaLine = metaBits.join(' · ');
  const displayAuthor = author ? `作者：${author}` : '';

  const files = [
    { name: '[Content_Types].xml', data: contentTypesDocument() },
    { name: '_rels/.rels', data: packageRelsDocument() },
    { name: 'word/document.xml', data: documentDocument({ title, author: displayAuthor, metaLine, content }) },
    { name: 'word/styles.xml', data: stylesDocument() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsDocument() },
    {
      name: 'docProps/core.xml',
      data: corePropertiesDocument({ title, author: author || '章节写作器', modified: stamp.iso })
    },
    { name: 'docProps/app.xml', data: appPropertiesDocument() }
  ];

  return {
    files,
    title,
    author,
    lang,
    chapterCount: plan.count,
    volumeCount,
    modified: stamp.iso,
    date: stamp.date,
    rangeMode: plan.mode,
    rangeLabel: plan.label,
    metaLine
  };
}

// 只产出文件清单（单测用）；写盘请用 buildDocx()
function docxFiles(input) {
  return buildBundle(input).files;
}

// 产出可写盘的 DOCX 字节。
// input = { meta, texts, range?, language?, modified?, zipDate? }
//   meta / texts 和 TXT / EPUB 导出一致（texts 与 meta.chapters 顺序对齐）；
//   range 可选（见 core/exporter.resolveExportRange）：只导出选中的卷 / 章节范围；
//   modified 默认现在；传固定值（再配 zipDate）可让同样的内容导出成完全一样的字节（单测用）。
function buildDocx(input) {
  const bundle = buildBundle(input);
  const zipDate = (input && input.zipDate) || bundle.date;
  const buffer = buildZip(bundle.files, { date: zipDate });
  return {
    buffer,
    chapterCount: bundle.chapterCount,
    volumeCount: bundle.volumeCount,
    bytes: buffer.length,
    title: bundle.title,
    modified: bundle.modified,
    rangeMode: bundle.rangeMode,
    rangeLabel: bundle.rangeLabel
  };
}

// 导出对话框默认文件名：全书 = 书名.docx；按卷 / 按范围 = 书名-范围.docx
// （范围规则和 TXT / EPUB 导出完全一致，由 core/exporter.exportFileName 统一实现）
function docxFileName(meta, range) {
  return exporter.exportFileName(meta, range, 'docx');
}

module.exports = {
  DOCX_MIMETYPE,
  WORD_NAMESPACE,
  WORD_LANGUAGE,
  WORD_FONT,
  WORD_BODY_SIZE,
  WORD_LINE_SPACING,
  stripInvalidXmlChars,
  escapeXml,
  paragraphsFromText,
  contentTypesDocument,
  packageRelsDocument,
  documentRelsDocument,
  stylesDocument,
  corePropertiesDocument,
  appPropertiesDocument,
  docxFiles,
  buildDocx,
  docxFileName
};
