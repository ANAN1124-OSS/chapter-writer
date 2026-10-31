// 手拼 ZIP（store / deflate 两种方式），EPUB 与 DOCX 导出共用。
//
// 只用 Node 内置 zlib，不引入任何第三方运行时依赖。
// 时间戳走 DOS 格式（1980 起、2 秒精度）：同一份内容 + 同一个时间 ⇒ 字节完全一样，
// 单测和 E2E 才能拿固定时间断言「同样的输入导出同样的文件」。
const zlib = require('node:zlib');

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

module.exports = { crc32, dosDateTime, buildZip };
