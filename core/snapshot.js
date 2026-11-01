// 可选「每日快照」的纯逻辑：目录命名、保留天数、过期判断。
// 这里不读不写文件系统（复制 / 清理在 core/storage.js，必须原子写、只在保存时发生），
// 方便单测覆盖日期边界与「只认自己生成的目录」这条安全规则。

const { pad2 } = require('./common');

const SNAPSHOT_PREFIX = '快照-';
const DEFAULT_KEEP_DAYS = 7;
const MIN_KEEP_DAYS = 1;
const MAX_KEEP_DAYS = 90;
// 目录名：快照-YYYYMMDD（本地日期，一天一个目录）
const SNAPSHOT_DIR_RE = /^快照-(\d{4})(\d{2})(\d{2})$/;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 本地日期键 YYYYMMDD（和目录名一致；用本地时区，作者看到的「今天」就是今天）
function localDayKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function snapshotDirName(value) {
  const key = localDayKey(value);
  return key ? `${SNAPSHOT_PREFIX}${key}` : null;
}

// 解析「快照-YYYYMMDD」：只认严格格式且日期真实存在（20260231 之类返回 null）。
// 不认识的目录名一律返回 null —— 清理逻辑据此保证「绝不碰别的备份」。
function parseSnapshotDirName(name) {
  const raw = String(name == null ? '' : name).trim();
  const match = SNAPSHOT_DIR_RE.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return {
    name: raw,
    dayKey: `${match[1]}${match[2]}${match[3]}`,
    startMs: date.getTime()
  };
}

// 保留天数清洗：非法值回落默认 7；范围 1–90 天（1 = 只留今天）。
function normalizeKeepDays(value, fallback = DEFAULT_KEEP_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_KEEP_DAYS, Math.max(MIN_KEEP_DAYS, Math.round(n)));
}

// 保留窗口的第一天（含）的 0 点。keepDays=7 表示「今天 + 前 6 天」共 7 天。
// 按年月日构造而不是减毫秒，避免夏令时（本机中国无 DST，但逻辑上更稳）。
function retentionCutoff(value, keepDays) {
  const date = toDate(value);
  if (!date) return null;
  const days = normalizeKeepDays(keepDays);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - (days - 1)).getTime();
}

// 是否已超出保留天数。非法目录名永远不判过期（调用方应原样保留）。
function isExpiredSnapshotDir(name, value, keepDays) {
  const info = parseSnapshotDirName(name);
  const cutoff = retentionCutoff(value, keepDays);
  if (!info || cutoff == null) return false;
  return info.startMs < cutoff;
}

// 从一批名字里挑出要清理的快照目录：只认严格合法的「快照-YYYYMMDD」，
// 其它目录 / 文件 / 乱写的名字原样不动；未来的日期（时钟回拨）也不动。
function selectExpiredSnapshotDirs(names, value, keepDays) {
  if (!Array.isArray(names)) return [];
  const cutoff = retentionCutoff(value, keepDays);
  if (cutoff == null) return [];
  const expired = [];
  for (const name of names) {
    const info = parseSnapshotDirName(name);
    if (info && info.startMs < cutoff) expired.push(info.name);
  }
  expired.sort();
  return expired;
}

module.exports = {
  SNAPSHOT_PREFIX,
  DEFAULT_KEEP_DAYS,
  MIN_KEEP_DAYS,
  MAX_KEEP_DAYS,
  localDayKey,
  snapshotDirName,
  parseSnapshotDirName,
  normalizeKeepDays,
  retentionCutoff,
  isExpiredSnapshotDir,
  selectExpiredSnapshotDirs
};
