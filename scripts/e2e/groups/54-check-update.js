// E2E 第 54 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组自足：更新的网络全部走主进程假响应（update:test-mock），不真连 GitHub、不下载不安装；
// 54h 自己造一本「标题统一测试书」再删掉，不污染后面的多窗口组。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group54CheckUpdate(t) {
  const {
    exec,
    check,
    waitFor,
    storage,
    booksRoot,
    // 54f 核对「检查更新不往 userData 里多写东西」，54g 关设置 / 回书架也要按路径核。
    userData,
    // 第 51 组留下的那本书（本组按路径再打开一次，核对「不写配置 / 不写书库」）。
    bookPath,
    // 界面版本号与 package.json 同源（场景里 appVersion = require(package.json).version）。
    appVersion,
    // 54h 标题统一拿 core 的 formatTitle / countChars 当口径。
    chapters: chaptersLib
  } = t;
  // 54. 检查更新（提案 7.1）：手动检查 GitHub Release → 提示有新版本 → 打开下载页。
  //     网络全部走主进程的假响应（update:test-mock），E2E 不真连 GitHub；
  //     不下载、不安装、不写配置、不写书库。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const updateConfigPath = path.join(userData, 'config.json');
  const updateConfigBefore = await fs.readFile(updateConfigPath, 'utf8');
  const updateBookMetaPath = path.join(bookPath, '书目.json');
  const updateBookMetaBefore = await fs.readFile(updateBookMetaPath, 'utf8');
  const updateBookMetaJson = JSON.parse(updateBookMetaBefore);
  const updateChapterPath = path.join(bookPath, updateBookMetaJson.chapters[0].file);
  const updateTxtBefore = await fs.readFile(updateChapterPath, 'utf8');
  const updateBookFilesBefore = (await fs.readdir(bookPath)).sort().join('|');
  const updateUserDataBefore = (await fs.readdir(userData)).sort().join('|');
  const pkgVersion = appVersion;
  const setUpdateMock = (mock) =>
    exec(`window.__cwTest.setUpdateMock(${JSON.stringify(mock)})`);
  const releaseBody = (tag, extra = {}) => ({
    tag_name: tag,
    name: `${tag} · 自检`,
    html_url: `https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/${tag}`,
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...extra
  });

  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const initialUpdate = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：设置里有「检查更新」分组，显示当前版本，初始没有下载按钮',
    (await exec('window.__cwTest.updateGroupVisible()')) === true &&
      initialUpdate.version === `v${pkgVersion}` &&
      initialUpdate.status === 'idle' &&
      initialUpdate.downloadVisible === false &&
      initialUpdate.text.includes('尚未检查'),
    initialUpdate
  );

  // 还没检查就点下载页：只给提示，绝不打开任意地址
  const beforeCheckOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：还没检查就点「打开下载页」只给提示，不打开任何地址',
    beforeCheckOpen.ok === true &&
      beforeCheckOpen.data.opened === false &&
      beforeCheckOpen.data.url === '' &&
      /先/.test(beforeCheckOpen.data.message || ''),
    beforeCheckOpen
  );

  // 54a. 发现新版本：显示版本号 + 下载页按钮，地址只能是本仓库 Release
  await setUpdateMock({ type: 'json', body: releaseBody('v9.9.9') });
  const newerResult = await exec('window.__cwTest.checkUpdateNow()');
  const newerStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：发现新版本时显示「新版本 + 当前版本」，并出现「打开下载页」',
    newerResult.status === 'update' &&
      newerResult.latestVersion === '9.9.9' &&
      newerResult.currentVersion === pkgVersion &&
      newerStatus.status === 'update' &&
      newerStatus.text.includes('发现新版本 v9.9.9') &&
      newerStatus.text.includes(`当前 v${pkgVersion}`) &&
      newerStatus.downloadVisible === true,
    { newerResult, newerStatus }
  );
  const downloadResult = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：下载页是本仓库的 GitHub Release 地址（自检环境只回报、不弹浏览器）',
    downloadResult.ok === true &&
      downloadResult.data.opened === false &&
      downloadResult.data.url ===
        'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v9.9.9' &&
      /自检/.test(downloadResult.data.note || ''),
    downloadResult
  );

  // 54b. 已是最新：下载按钮收起，上一轮的地址也不能再被打开
  await setUpdateMock({ type: 'json', body: releaseBody(`v${pkgVersion}`) });
  const latestResult = await exec('window.__cwTest.checkUpdateNow()');
  const latestStatus = await exec('window.__cwTest.updateStatus()');
  const staleOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：同版本时显示「已是最新版本」，下载按钮收起',
    latestResult.status === 'latest' &&
      latestStatus.text.includes('已是最新版本') &&
      latestStatus.downloadVisible === false,
    { latestResult, latestStatus }
  );
  check(
    '检查更新：检查到「已是最新」后不能再用上一轮的地址打开下载页',
    staleOpen.ok === true && staleOpen.data.opened === false && staleOpen.data.url === '',
    staleOpen
  );

  // 54c. 更旧的版本（例如本机是开发版）不提示降级
  await setUpdateMock({ type: 'json', body: releaseBody('v0.1.0') });
  const olderResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 上版本更旧时仍显示「已是最新版本」，不会提示降级',
    olderResult.status === 'latest' && olderResult.latestVersion === '0.1.0',
    olderResult
  );

  // 54d. 网络失败 / 超时 / HTTP 错误 / 限流 / 坏 JSON：都只给一句提示，设置弹层照常可用
  await setUpdateMock({ type: 'network-error' });
  const networkResult = await exec('window.__cwTest.checkUpdateNow()');
  const networkStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：没网时给友好提示（连不上 GitHub），不影响写作',
    networkResult.status === 'error' &&
      networkResult.code === 'NETWORK' &&
      networkStatus.text.includes('连不上 GitHub') &&
      networkStatus.downloadVisible === false,
    networkResult
  );

  await setUpdateMock({ type: 'timeout' });
  const timeoutResult = await exec('window.__cwTest.checkUpdateNow()');
  const timeoutStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：超时给友好提示，不卡住设置弹层',
    timeoutResult.status === 'error' &&
      timeoutResult.code === 'TIMEOUT' &&
      timeoutStatus.text.includes('超时'),
    timeoutResult
  );

  await setUpdateMock({ type: 'http', status: 500, text: '' });
  const serverResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 返回 5xx 时说明「暂时不可用」，不是假装没更新',
    serverResult.status === 'error' &&
      serverResult.code === 'HTTP_ERROR' &&
      serverResult.message.includes('HTTP 500'),
    serverResult
  );

  await setUpdateMock({ type: 'http', status: 403, text: '' });
  const limitedResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 限流时提示「请求太频繁」',
    limitedResult.status === 'error' &&
      limitedResult.code === 'RATE_LIMIT' &&
      limitedResult.message.includes('频繁'),
    limitedResult
  );

  await setUpdateMock({ type: 'http', status: 200, text: '{not json' });
  const badJsonResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：返回的不是 JSON 时提示「格式不对」，不崩',
    badJsonResult.status === 'error' &&
      badJsonResult.code === 'BAD_JSON' &&
      badJsonResult.message.includes('格式不对'),
    badJsonResult
  );

  // 54e. 恶意 / 坏的 html_url 不能把作者带到别的网站：退回按 tag 拼的官方下载页
  await setUpdateMock({
    type: 'json',
    body: releaseBody('v9.9.9', { html_url: 'http://evil.example/steal' })
  });
  const unsafeResult = await exec('window.__cwTest.checkUpdateNow()');
  const unsafeOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：Release 里的坏链接被丢掉，只使用本仓库的官方下载页',
    unsafeResult.status === 'update' &&
      unsafeResult.releaseUrl ===
        'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v9.9.9' &&
      unsafeOpen.data.url === unsafeResult.releaseUrl,
    { unsafeResult, unsafeOpen }
  );

  // 54f. 只读：检查更新不写配置 / 不写书目 / 不改正文 / 不多出文件
  check(
    '检查更新：全程只读（config / 书目 / 章节 txt 一个字节都没变）',
    (await fs.readFile(updateConfigPath, 'utf8')) === updateConfigBefore &&
      (await fs.readFile(updateBookMetaPath, 'utf8')) === updateBookMetaBefore &&
      (await fs.readFile(updateChapterPath, 'utf8')) === updateTxtBefore
  );
  check(
    '检查更新：书库和 userData 没有多出任何文件（不下载、不缓存更新包）',
    (await fs.readdir(bookPath)).sort().join('|') === updateBookFilesBefore &&
      (await fs.readdir(userData)).sort().join('|') === updateUserDataBefore
  );
  const updateConfigJson = JSON.parse(await fs.readFile(updateConfigPath, 'utf8'));
  const updateConfigKeys = [
    'updateCheckOnStartup',
    'updateFeed',
    'updateFeedUrl',
    'lastUpdateCheck',
    'autoUpdate',
    'updateChannel'
  ].filter((key) => key in updateConfigJson);
  check(
    '检查更新：配置不新增任何更新字段（检查只存在内存里，不需要作者配置）',
    updateConfigKeys.length === 0,
    updateConfigKeys
  );

  // 54g. 按书设置里不显示「检查更新」（一个应用一个版本，和诊断日志同一处理）
  await exec('window.__cwTest.closeSettings()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '检查更新：按书设置里不显示更新分组（更新是整个应用的事）',
    (await exec('window.__cwTest.updateGroupVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 54h. 章节标题统一（v0.8.6 R3，代码审计 F6）：标题栏 / 章节列表不再自己拼「第N章：」，
  //      统一走 core/chapters.js 的 formatTitle（UMD 后渲染层也能加载）。原来渲染层不认
  //      书目里的 titleTemplate，同一章在界面和导出 / 复制里会不一样；这里造一本临时书，
  //      分别按默认模板和自定义模板打开，逐章对照界面标题 / 章节列表与 core。
  const titleBook = await storage.createBook(booksRoot, '标题统一测试书');
  const titleBookPath = titleBook.path;
  const titleDefs = [
    { name: '起风', text: '风从海面吹来。' },
    { name: '第1章 关于本作品', text: '原文自带标题的章。' },
    { name: '', text: '没有章名的章。' },
    { name: '夜雨', text: '雨下了一夜。' }
  ];
  for (let i = 1; i < titleDefs.length; i += 1) {
    await storage.createChapter(titleBookPath, i, titleDefs[i].name);
  }
  let titleMeta = await storage.readBookMeta(titleBookPath);
  for (let i = 0; i < titleDefs.length; i += 1) {
    const chapter = titleMeta.chapters[i];
    chapter.name = titleDefs[i].name;
    await storage.saveChapterText(titleBookPath, chapter.file, titleDefs[i].text);
    chapter.chars = chaptersLib.countChars(titleDefs[i].text);
  }
  await storage.writeBookMeta(titleBookPath, titleMeta);
  titleMeta = await storage.readBookMeta(titleBookPath);
  const titleExpected = (meta) =>
    meta.chapters.map((chapter, index) => chaptersLib.formatTitle(meta, index, chapter.name));
  const titleFilesBefore = (await fs.readdir(titleBookPath)).sort().join('|');
  const titleTxtBefore = {};
  for (const chapter of titleMeta.chapters) {
    titleTxtBefore[chapter.file] = await fs.readFile(path.join(titleBookPath, chapter.file), 'utf8');
  }

  // 默认模板：普通章「第1章：起风」、原文标题原样、空名「第3章」；界面三处（API / 标题栏 / 列表）一致
  const titleDefaultExpected = titleExpected(titleMeta);
  check(
    '标题统一：默认模板下 core 的标题形态符合预期（普通 / 原文标题 / 空名）',
    JSON.stringify(titleDefaultExpected) ===
      JSON.stringify(['第1章：起风', '第1章 关于本作品', '第3章', '第4章：夜雨']),
    titleDefaultExpected
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(titleBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const titleDefaultUi = await exec('window.__cwTest.chapterTitles()');
  check(
    '标题统一：默认模板下界面章节标题与 core.formatTitle 逐项一致',
    JSON.stringify(titleDefaultUi) === JSON.stringify(titleDefaultExpected),
    { ui: titleDefaultUi, core: titleDefaultExpected }
  );
  check(
    '标题统一：默认模板下标题栏就是 core 的「第1章：起风」',
    (await exec('window.__cwTest.currentTitle()')) === titleDefaultExpected[0]
  );
  const titleDefaultList = await exec('window.__cwTest.chapterListLabels()');
  check(
    '标题统一：默认模板下章节列表两格拼起来与 core / 标题栏一字不差',
    JSON.stringify(titleDefaultList) === JSON.stringify(titleDefaultExpected),
    { list: titleDefaultList, core: titleDefaultExpected }
  );
  const titleDefaultParts = await exec(`(() => Array.from(document.querySelectorAll('#chapter-list .chapter-item')).map((item) => ({
    num: item.querySelector('.chapter-num').textContent,
    name: item.querySelector('.chapter-name').textContent
  })))()`);
  check(
    '标题统一：默认模板下列表按「第N章：」+ 名字两段显示，空名章只显示章号、不再补「未命名」',
    titleDefaultParts[0].num === '第1章：' &&
      titleDefaultParts[0].name === '起风' &&
      titleDefaultParts[1].num === '' &&
      titleDefaultParts[1].name === '第1章 关于本作品' &&
      titleDefaultParts[2].num === '' &&
      titleDefaultParts[2].name === '第3章' &&
      titleDefaultParts[3].num === '第4章：' &&
      titleDefaultParts[3].name === '夜雨',
    titleDefaultParts
  );
  await exec("window.__cwTest.switchTo(1, 'discard')");
  check(
    '标题统一：切到原文自带标题的章，标题栏原样显示、不叠加章号',
    (await exec('window.__cwTest.currentTitle()')) === '第1章 关于本作品'
  );
  await exec("window.__cwTest.switchTo(2, 'discard')");
  check(
    '标题统一：切到空名章，标题栏只显示「第3章」（与 core / 列表一致）',
    (await exec('window.__cwTest.currentTitle()')) === '第3章'
  );
  await exec("window.__cwTest.switchTo(3, 'discard')");

  // 自定义 titleTemplate：以前只有 TXT / EPUB / DOCX 导出与「复制本章」认模板，界面不认
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  titleMeta = await storage.readBookMeta(titleBookPath);
  await storage.writeBookMeta(titleBookPath, { ...titleMeta, titleTemplate: 'Chapter {num} - {name}' });
  const titleCustomMeta = await storage.readBookMeta(titleBookPath);
  const titleCustomExpected = titleExpected(titleCustomMeta);
  check(
    '标题统一：自定义 titleTemplate 下 core 的标题正确（原文标题 / 空名仍按 core 口径）',
    JSON.stringify(titleCustomExpected) ===
      JSON.stringify(['Chapter 1 - 起风', '第1章 关于本作品', '第3章', 'Chapter 4 - 夜雨']),
    titleCustomExpected
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(titleBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const titleCustomUi = await exec('window.__cwTest.chapterTitles()');
  const titleCustomList = await exec('window.__cwTest.chapterListLabels()');
  check(
    '标题统一：自定义 titleTemplate 下界面标题 / 章节列表都跟 core 一致（以前只有导出认模板）',
    JSON.stringify(titleCustomUi) === JSON.stringify(titleCustomExpected) &&
      JSON.stringify(titleCustomList) === JSON.stringify(titleCustomExpected),
    { ui: titleCustomUi, list: titleCustomList, core: titleCustomExpected }
  );
  // 重新打开会回到上次那章（上面刚切到第 4 章），先切回第 1 章再验标题栏
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '标题统一：自定义 titleTemplate 下第 1 章标题栏是「Chapter 1 - 起风」（界面认模板、不再写死「第N章：」）',
    (await exec('window.__cwTest.currentTitle()')) === titleCustomExpected[0],
    await exec('window.__cwTest.currentTitle()')
  );
  await exec("window.__cwTest.switchTo(3, 'discard')");
  check(
    '标题统一：自定义 titleTemplate 下切到第 4 章，标题栏跟着变「Chapter 4 - 夜雨」',
    (await exec('window.__cwTest.currentTitle()')) === titleCustomExpected[3]
  );
  const titleMetaAfterUi = await storage.readBookMeta(titleBookPath);
  const titleFilesAfter = (await fs.readdir(titleBookPath)).sort().join('|');
  const titleTxtAfter = {};
  for (const chapter of titleMetaAfterUi.chapters) {
    titleTxtAfter[chapter.file] = await fs.readFile(path.join(titleBookPath, chapter.file), 'utf8');
  }
  check(
    '标题统一：打开书 / 切章只改书目的 lastOpenChapterId——书目录文件列表与四章 txt 逐字节不变',
    titleFilesAfter === titleFilesBefore &&
      JSON.stringify(titleTxtAfter) === JSON.stringify(titleTxtBefore) &&
      titleMetaAfterUi.titleTemplate === 'Chapter {num} - {name}',
    { titleFilesAfter, titleFilesBefore }
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
};
