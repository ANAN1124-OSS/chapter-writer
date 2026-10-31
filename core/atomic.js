// 原子写工具：临时文件 -> fsync -> rename，失败重试。
// 所有落盘都必须经过这里，保证「要么是旧完整版，要么是新完整版」，不会出现半截文件。
const fs = require('node:fs/promises');
const path = require('node:path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from, to, { tries = 3, delay = 80 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = RETRY_CODES.has(err.code);
      if (!retryable || attempt === tries - 1) throw err;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ensureDir=false：只写「已经存在的目录」（保存章节用），目录被删时直接报错，
// 绝不 mkdir 重建出一个只有一章 txt 的影子书文件夹。
async function atomicWriteFile(filePath, data, encoding = 'utf8', { ensureDir = true } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  let handle = null;
  try {
    if (ensureDir) await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(data, encoding);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
    try { await fs.unlink(tmp); } catch { /* 忽略 */ }
    throw err;
  }
}

function stripBom(text) {
  const s = String(text == null ? '' : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(stripBom(raw));
}

async function writeJsonAtomic(filePath, obj, options = {}) {
  await atomicWriteFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8', options);
}

module.exports = {
  atomicWriteFile,
  renameWithRetry,
  readJson,
  writeJsonAtomic,
  stripBom,
  sleep
};
