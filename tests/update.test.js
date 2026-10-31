const test = require('node:test');
const assert = require('node:assert/strict');
const updateLib = require('../core/update');

// 假网络：不真连 GitHub，按测试需要返回 {status, text} 或抛错。
function fakeFetch(response) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
}

function releaseJson(overrides = {}) {
  return JSON.stringify({
    tag_name: 'v0.7.0',
    name: 'v0.7.0 · 体验层',
    html_url: 'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0',
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...overrides
  });
}

test('检查更新：版本号解析接受 v 前缀 / 两位 / 预发布 / build 元数据', () => {
  assert.equal(updateLib.parseVersion('0.4.1').text, '0.4.1');
  assert.equal(updateLib.parseVersion(' v0.4.1 ').text, '0.4.1');
  assert.equal(updateLib.parseVersion('1.2').text, '1.2.0');
  assert.equal(updateLib.parseVersion('1').text, '1.0.0');
  assert.equal(updateLib.parseVersion('0.5.0-beta.2').text, '0.5.0-beta.2');
  assert.equal(updateLib.parseVersion('0.5.0+build.9').text, '0.5.0');
  assert.equal(updateLib.parseVersion('0.5.0-rc.1+build.9').text, '0.5.0-rc.1');
  for (const bad of ['', '   ', 'v', '0.4.1.2', '0..1', '0.4.x', '-1.0.0', '0.4.1-', '0.4.1-beta..1', null, 42]) {
    assert.equal(updateLib.parseVersion(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('检查更新：版本比较按 主.次.修订 逐段比', () => {
  assert.equal(updateLib.compareVersions('0.4.1', '0.4.1'), 0);
  assert.equal(updateLib.compareVersions('0.4.2', '0.4.1'), 1);
  assert.equal(updateLib.compareVersions('0.11.0', '0.4.9'), 1);
  assert.equal(updateLib.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(updateLib.compareVersions('v0.4.1', '0.4.2'), -1);
  assert.equal(updateLib.isNewerVersion('0.7.0', '0.4.1'), true);
  assert.equal(updateLib.isNewerVersion('0.4.1', '0.4.1'), false);
  assert.equal(updateLib.isNewerVersion('0.4.0', '0.4.1'), false);
});

test('检查更新：预发布版排序（beta < rc、数字 < 字母、正式版最高）', () => {
  assert.equal(updateLib.compareVersions('1.0.0-beta', '1.0.0-rc.1'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(updateLib.compareVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(updateLib.compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(updateLib.compareVersions('bad', '1.0.0'), null);
});

test('检查更新：只接受本仓库的 https GitHub Release 链接', () => {
  const good = [
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0',
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/latest',
    'https://github.com/ANAN1124-OSS/chapter-writer/releases'
  ];
  for (const url of good) assert.equal(updateLib.safeReleaseUrl(url), url);
  const bad = [
    'http://github.com/ANAN1124-OSS/chapter-writer/releases',
    'https://github.com.evil.example/ANAN1124-OSS/chapter-writer/releases',
    'https://evil.example/ANAN1124-OSS/chapter-writer/releases',
    'https://github.com/ANAN1124-OSS/chapter-writer-evil/releases',
    'https://github.com/ANAN1124-OSS/chapter-writer/issues',
    'https://github.com:8443/ANAN1124-OSS/chapter-writer/releases',
    'https://user:pass@github.com/ANAN1124-OSS/chapter-writer/releases',
    'javascript:alert(1)',
    '',
    null
  ];
  for (const url of bad) assert.equal(updateLib.safeReleaseUrl(url), '', `应拒绝 ${url}`);
});

test('检查更新：没有 html_url 时按 tag 拼下载页，坏 tag 退回 Release 列表', () => {
  assert.equal(
    updateLib.releasePageUrl('v0.7.0'),
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0'
  );
  assert.equal(
    updateLib.releasePageUrl('0.7.0-beta.1'),
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/0.7.0-beta.1'
  );
  assert.equal(updateLib.releasePageUrl('../evil'), updateLib.RELEASES_URL);
  assert.equal(updateLib.releasePageUrl(''), updateLib.RELEASES_URL);
});

test('检查更新：解析 GitHub Release JSON，字段清洗后只留需要的元数据', () => {
  const parsed = updateLib.parseReleasePayload(JSON.parse(releaseJson()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.release.version, '0.7.0');
  assert.equal(parsed.release.tag, 'v0.7.0');
  assert.equal(parsed.release.name, 'v0.7.0 · 体验层');
  assert.equal(parsed.release.publishedAt, '2026-11-01T00:00:00.000Z');
  assert.equal(
    parsed.release.url,
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0'
  );
});

test('检查更新：恶意 html_url 退回按 tag 拼的官方下载页', () => {
  const parsed = updateLib.parseReleasePayload(
    JSON.parse(releaseJson({ html_url: 'http://evil.example/download' }))
  );
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.release.url,
    'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0'
  );
});

test('检查更新：缺版本号 / 草稿 / 非对象都返回明确错误', () => {
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ tag_name: '' }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ tag_name: 'nightly' }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ draft: true }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(null).code, 'BAD_RESPONSE');
  assert.equal(updateLib.parseReleasePayload([]).code, 'BAD_RESPONSE');
});

test('检查更新：发现新版本时返回 update + 当前 / 最新版本与下载页', async () => {
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  const result = await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText });
  assert.equal(result.status, 'update');
  assert.equal(result.currentVersion, '0.4.1');
  assert.equal(result.latestVersion, '0.7.0');
  assert.equal(result.releaseUrl, 'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0');
  assert.match(result.message, /发现新版本 v0\.7\.0/);
  assert.equal(fetchText.calls.length, 1);
  assert.equal(fetchText.calls[0].url, updateLib.LATEST_RELEASE_API);
  assert.ok(fetchText.calls[0].timeoutMs >= 1500);
});

test('检查更新：同版本 / 更旧的版本都返回 latest，不会提示降级', async () => {
  const same = await updateLib.checkForUpdates({
    currentVersion: '0.7.0',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(same.status, 'latest');
  assert.match(same.message, /已经是最新版本/);
  const older = await updateLib.checkForUpdates({
    currentVersion: '0.9.0',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(older.status, 'latest');
  assert.equal(older.latestVersion, '0.7.0');
});

test('检查更新：当前版本是预发布时，同号正式版算更新', async () => {
  const result = await updateLib.checkForUpdates({
    currentVersion: '0.7.0-beta.1',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(result.status, 'update');
  assert.equal(result.currentVersion, '0.7.0-beta.1');
});

test('检查更新：没网 / 超时都转成友好错误，不抛错', async () => {
  const offline = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
  const network = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(offline)
  });
  assert.equal(network.status, 'error');
  assert.equal(network.code, 'NETWORK');
  assert.match(network.message, /连不上 GitHub/);

  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const timeout = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(abort)
  });
  assert.equal(timeout.status, 'error');
  assert.equal(timeout.code, 'TIMEOUT');
  assert.match(timeout.message, /超时/);
});

test('检查更新：HTTP 404 / 403 / 500 各给一句能看懂的提示', async () => {
  const notFound = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 404, text: '' })
  });
  assert.equal(notFound.code, 'NO_RELEASE');
  assert.match(notFound.message, /还没有发布版本/);

  const limited = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 403, text: '' })
  });
  assert.equal(limited.code, 'RATE_LIMIT');

  const server = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 500, text: '' })
  });
  assert.equal(server.code, 'HTTP_ERROR');
  assert.match(server.message, /HTTP 500/);
});

test('检查更新：坏 JSON / 空响应 / 超大响应 / 坏状态都不崩', async () => {
  const badJson = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: 'not json' })
  });
  assert.equal(badJson.code, 'BAD_JSON');

  const empty = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: '   ' })
  });
  assert.equal(empty.code, 'BAD_RESPONSE');

  const huge = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: 'x'.repeat(updateLib.MAX_RESPONSE_CHARS + 1) })
  });
  assert.equal(huge.code, 'TOO_LARGE');

  const badStatus = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 'oops', text: '{}' })
  });
  assert.equal(badStatus.code, 'BAD_RESPONSE');

  const noResponse = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(null)
  });
  assert.equal(noResponse.code, 'BAD_RESPONSE');
});

test('检查更新：当前版本坏 / 没有网络实现时返回结构化错误', async () => {
  const badCurrent = await updateLib.checkForUpdates({
    currentVersion: 'dev',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(badCurrent.status, 'error');
  assert.equal(badCurrent.code, 'BAD_CURRENT');

  const noFetch = await updateLib.checkForUpdates({ currentVersion: '0.4.1' });
  assert.equal(noFetch.status, 'error');
  assert.equal(noFetch.code, 'NO_FETCH');
});

test('检查更新：结果带时区无关的 ISO 时间，便于界面显示', async () => {
  const result = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: releaseJson() }),
    now: () => Date.UTC(2026, 10, 1, 3, 30, 0)
  });
  assert.equal(result.checkedAt, '2026-11-01T03:30:00.000Z');
  assert.equal(result.publishedAt, '2026-11-01T00:00:00.000Z');
});

test('检查更新：超时参数夹在 1.5–30 秒，坏值回默认', async () => {
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 50 });
  assert.equal(fetchText.calls[0].timeoutMs, 1500);
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 999999 });
  assert.equal(fetchText.calls[1].timeoutMs, 30000);
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 'bad' });
  assert.equal(fetchText.calls[2].timeoutMs, updateLib.DEFAULT_TIMEOUT_MS);
});

test('检查更新：模块本身不联网、不写盘，只通过传入的 fetchText 取数据', async () => {
  const before = new Set(Object.keys(require.cache));
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  const result = await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText });
  assert.equal(result.status, 'update');
  // 纯函数：调用前后 require 缓存不变（没有偷偷加载 fs / net / http）
  assert.deepEqual(new Set(Object.keys(require.cache)), before);
});
