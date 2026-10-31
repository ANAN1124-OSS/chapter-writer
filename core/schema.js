// 书目.json 的格式版本（schemaVersion）与读取迁移。
// 原则：新字段一律可选、旧书照常打开；比本应用新的版本号原样保留，不擅自降级。
// 这里只做纯数据变换，不碰磁盘，可直接单测。
const CURRENT_SCHEMA_VERSION = 1;

// 合法版本 = ≥1 的整数；缺失 / 非法返回 null（调用方决定兜底成当前版本）
function sanitizeSchemaVersion(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// 版本 N → N+1 的迁移函数表。现在版本 1 没有字段要改（空迁移），
// 将来加字段时在这里补 `1: (meta) => ({ ...meta, 新字段: 默认值 })`，
// 旧书读到后就会自动升级，不需要用户手动改 书目.json。
const MIGRATIONS = {};

// 读取时调用：把旧书目迁移到当前版本。
// - 没有 schemaVersion（v0.4.x 的书）按版本 0 处理，依次跑迁移，最后补成 1；
// - 版本号比本应用新：只按已知字段尽力读，版本号原样保留，写回也不降级；
// - 非法版本号：当成旧的，按当前版本补。
function migrateMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    return { schemaVersion: CURRENT_SCHEMA_VERSION };
  }
  const declared = sanitizeSchemaVersion(rawMeta.schemaVersion);
  const meta = { ...rawMeta };
  if (declared != null && declared > CURRENT_SCHEMA_VERSION) {
    meta.schemaVersion = declared;
    return meta;
  }
  let version = declared == null ? 0 : declared;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version + 1];
    if (typeof step === 'function') {
      const next = step(meta);
      if (next && typeof next === 'object' && !Array.isArray(next)) Object.assign(meta, next);
    }
    version += 1;
  }
  meta.schemaVersion = version;
  return meta;
}

// 写盘时调用：缺失 / 非法补当前版本；未来版本保留（不把新格式写旧）
function normalizeSchemaVersion(raw) {
  const declared = sanitizeSchemaVersion(raw);
  return declared == null ? CURRENT_SCHEMA_VERSION : declared;
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  sanitizeSchemaVersion,
  migrateMeta,
  normalizeSchemaVersion
};
