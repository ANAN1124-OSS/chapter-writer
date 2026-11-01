// 手拼 ZIP（store / deflate 两种方式），EPUB 与 DOCX 导出共用。
//
// 只用 Node 内置 zlib，不引入任何第三方运行时依赖。
// 时间戳走 DOS 格式（1980 起、2 秒精度）：同一份内容 + 同一个时间 ⇒ 字节完全一样，
// 单测和 E2E 才能拿固定时间断言「同样的输入导出同样的文件」。
//
// 条目名闸门（v0.9 C-3，安全审计 C6）：EPUB / DOCX 的条目名全部由本应用生成
// （`OEBPS/text/chapter-0001.xhtml` 这种），书名 / 卷名 / 章名只进正文，一个字节都不进条目名。
// 但万一以后有人把作者输入拼进条目名，`../`、`C:`、反斜杠这类名字解压时会变成
// 「写到包外面」（zip-slip）。所以 buildZip 先过 assertEntryName：
// 只允许 ASCII 可打印字符，不允许反斜杠 / 冒号 / 绝对路径 / `.` `..` 段 / 空段，
// 名字最长 255 字节。不合法直接抛错，宁可导出失败也不产出能把文件写到别处的包。
const zlib = require('node:zlib');

// zip 条目名字节上限：解压到常见文件系统都够用（我们自己生成的名字都不到 40 字节）
const MAX_ENTRY_NAME_BYTES = 255;
// 只允许 ASCII 可打印字符（0x20–0x7e）：控制字符 / 换行 / 非 ASCII 一律不收。
// 非 ASCII 也挡掉是有意的——本地文件头不写 UTF-8 标志位（flag=0），
// 名字一旦不是 ASCII，不同解压器就会按 CP437 解成乱码；真需要中文条目名时，
// 得先给这个文件加 UTF-8 标志位支持，再放开这里。
const ENTRY_NAME_CHARS = /^[\x20-\x7e]+$/;

// 检查一个 zip 条目名：返回空串表示合法，否则返回原因码。
// 只回原因码、不回名字本身，免得把可能带控制字符的字符串写进错误信息 / 日志。
function entryNameProblem(raw) {
  if (typeof raw !== 'string' || !raw) return 'EMPTY';
  if (!ENTRY_NAME_CHARS.test(raw)) return 'NON_PRINTABLE';
  if (raw.includes('\\')) return 'BACKSLASH';
  if (raw.includes(':')) return 'COLON';
  if (raw.startsWith('/')) return 'ABSOLUTE';
  if (Buffer.byteLength(raw, 'utf8') > MAX_ENTRY_NAME_BYTES) return 'TOO_LONG';
  for (const part of raw.split('/')) {
    if (!part || part === '.' || part === '..') return 'DOT_SEGMENT';
  }
  return '';
}

// 校验并原样返回条目名；不合法抛错（错误信息里只有原因码）。
function assertEntryName(raw) {
  const problem = entryNameProblem(raw);
  if (problem) throw new Error(`ZIP 条目名不合法（${problem}）`);
  return raw;
}

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
// store=true 的条目原样存（EPUB 的 mimetype 必须这样，阅读器靠它判断是不是 EPUB）。
function buildZip(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  // zip 的中央目录用 2 字节记条目数：超了不写坏包，直接报错（不写 zip64，本应用用不到）
  if (list.length > 0xffff) throw new Error('ZIP 条目太多（上限 65535 项）');
  const stamp = dosDateTime(options && options.date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of list) {
    const name = Buffer.from(assertEntryName(entry && entry.name), 'utf8');
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
    // 中央目录用 4 字节记偏移 / 长度：超 4 GB 直接报错（同上，不写 zip64）
    if (offset + 30 + name.length + payload.length > 0xffffffff) {
      throw new Error('ZIP 包超过 4 GB 上限');
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

module.exports = { crc32, dosDateTime, buildZip, entryNameProblem, assertEntryName, MAX_ENTRY_NAME_BYTES };
