// 自检工具（单测 + E2E 共用）：把导出的 zip / epub 读回来，检查条目结构和 XML 合法性。
// 只用于验证，不参与导出；故意用最朴素的实现，只依赖 Node 内置 zlib。
const zlib = require('node:zlib');

// ---------- ZIP 读回 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 返回 { entries: [{ name, method, size, data(Buffer) }], names: [...] }；
// 任何结构问题都直接抛错（E2E/单测据此判断导出的文件是不是真的能打开）。
function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip：找不到目录结尾记录（EOCD）');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('不是合法的 zip：中央目录越界');

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`不是合法的 zip：中央目录第 ${i + 1} 项签名不对`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLength).toString('utf8');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`不是合法的 zip：条目 ${name} 的本地头签名不对`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buf.slice(dataStart, dataStart + compressedSize);
    if (payload.length !== compressedSize) throw new Error(`不是合法的 zip：条目 ${name} 数据越界`);

    let data;
    if (method === 0) data = payload;
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else throw new Error(`条目 ${name} 用了不支持的压缩方式 ${method}`);
    if (data.length !== size) throw new Error(`条目 ${name} 解压后长度不对`);
    if (crc32(data) !== crc) throw new Error(`条目 ${name} 的 CRC 校验不通过`);

    entries.push({ name, method, size, data });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, names: entries.map((entry) => entry.name) };
}

// ---------- 简易 XML 合法性检查 ----------
// 只覆盖我们自己生成的那点结构（元素 / 属性 / 实体 / 注释 / DOCTYPE），
// 足以发现「漏转义 & <、标签没闭合」这类会把整本 EPUB 弄坏的错误。
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
    if (ch === '<') return -1;
  }
  return -1;
}

function checkEntities(value, fail) {
  if (value.includes('<')) fail('属性值 / 文本里出现了没有转义的 <');
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) {
    fail('出现了没有转义的 &');
  }
}

function checkAttributes(rest, fail) {
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(rest))) {
    const between = rest.slice(last, match.index);
    if (between.trim()) fail(`属性区有无法识别的内容：${between.trim()}`);
    checkEntities(match[2].slice(1, -1), fail);
    last = pattern.lastIndex;
  }
  if (rest.slice(last).trim()) fail(`属性区有无法识别的内容：${rest.slice(last).trim()}`);
}

function assertWellFormedXml(text, label = 'XML') {
  const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const stack = [];
  let i = 0;
  const fail = (message) => {
    throw new Error(`${label} 不是合法 XML：${message}（位置 ${i}）`);
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      checkEntities(source.slice(i), fail);
      break;
    }
    if (lt > i) checkEntities(source.slice(i, lt), fail);
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) fail('注释没有结束');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0) fail('CDATA 没有结束');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) fail('处理指令没有结束');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i + 2);
      if (end < 0) fail('DOCTYPE 没有结束');
      i = end + 1;
      continue;
    }
    const gt = findTagEnd(source, i);
    if (gt < 0) fail('标签没有结束');
    const raw = source.slice(i + 1, gt);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail(`结束标签名字不对：${name}`);
      const top = stack.pop();
      if (top !== name) fail(`结束标签 </${name}> 和开始标签 <${top || '（空）'}> 不匹配`);
    } else {
      const selfClosing = raw.trimEnd().endsWith('/');
      const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;
      const match = /^([A-Za-z_][\w.:-]*)\s*([\s\S]*)$/.exec(body);
      if (!match) fail(`开始标签格式不对：<${body}>`);
      checkAttributes(match[2], fail);
      if (!selfClosing) stack.push(match[1]);
    }
    i = gt + 1;
  }
  if (stack.length) fail(`有 ${stack.length} 个标签没有闭合（最后一个：<${stack[stack.length - 1]}>）`);
  return true;
}

module.exports = {
  readZip,
  crc32,
  assertWellFormedXml
};
