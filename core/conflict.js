// 同步盘冲突副本识别（OneDrive / 坚果云 / Dropbox 等）。
// 两边同时改过时，同步盘会在书文件夹里额外生成
//   「书目 (conflicted copy 1).json」「001-起风-冲突副本.txt」这类文件。
// 这里只做纯字符串判断，不碰磁盘：识别出来只提示，绝不自动合并、更不会删文件。
const CONFLICT_RE = /conflicted|冲突副本/i;

function isConflictCopyName(name) {
  if (typeof name !== 'string') return false;
  const base = name.trim();
  if (!base) return false;
  return CONFLICT_RE.test(base);
}

// 从文件名列表里挑出冲突副本：去空、去重、按中文排序；非数组 / 非字符串安全兜底。
function findConflictCopies(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const clean = name.trim();
    if (!clean || seen.has(clean) || !isConflictCopyName(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

module.exports = {
  CONFLICT_RE,
  isConflictCopyName,
  findConflictCopies
};
