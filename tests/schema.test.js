const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../core/schema');

test('schema：当前版本是 1', () => {
  assert.equal(schema.CURRENT_SCHEMA_VERSION, 1);
});

test('schema：旧书（没有版本号）迁移成 1，其他字段原样保留', () => {
  const legacy = {
    version: 1,
    id: 'b_legacy',
    title: '旧书',
    fileSeq: 2,
    chapters: [{ id: 'ch_001', file: '001-未命名.txt', name: '起风' }],
    lastOpenChapterId: 'ch_001'
  };
  const meta = schema.migrateMeta(legacy);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.title, '旧书');
  assert.equal(meta.fileSeq, 2);
  assert.equal(meta.chapters.length, 1);
  // 不改调用方传进来的对象
  assert.equal(legacy.schemaVersion, undefined);
});

test('schema：已经是最新版本的书原样通过（幂等）', () => {
  const meta = schema.migrateMeta({ schemaVersion: 1, title: '新书', chapters: [] });
  assert.equal(meta.schemaVersion, 1);
  assert.equal(schema.migrateMeta(meta).schemaVersion, 1);
});

test('schema：比本应用新的版本号原样保留，不擅自降级', () => {
  const future = schema.migrateMeta({ schemaVersion: 9, title: '未来书', chapters: [] });
  assert.equal(future.schemaVersion, 9);
  assert.equal(future.title, '未来书');
});

test('schema：版本号缺失 / 非法 / 小数 / 0 / 负数都兜底成当前版本', () => {
  for (const bad of [undefined, null, '', 'abc', 0, -3, 1.5, NaN, Infinity, {}, []]) {
    assert.equal(schema.migrateMeta({ schemaVersion: bad }).schemaVersion, 1, String(bad));
    assert.equal(schema.normalizeSchemaVersion(bad), 1, String(bad));
  }
  // 数字字符串是合法的（json 里被引号包住也能读懂）
  assert.equal(schema.sanitizeSchemaVersion('2'), 2);
});

test('schema：非对象输入不炸，返回只带版本号的对象', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(schema.migrateMeta(bad), { schemaVersion: 1 });
  }
});

test('schema：normalize 保留未来版本，缺失补 1', () => {
  assert.equal(schema.normalizeSchemaVersion(7), 7);
  assert.equal(schema.normalizeSchemaVersion(undefined), 1);
  assert.equal(schema.normalizeSchemaVersion('1'), 1);
});

test('schema：迁移表存在（给将来加字段留的口子）', () => {
  assert.equal(typeof schema.MIGRATIONS, 'object');
  assert.ok(schema.MIGRATIONS && !Array.isArray(schema.MIGRATIONS));
});
