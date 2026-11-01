// E2E 第 53 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组自足：自己造「正文搜索测试书 / 索引删除测试书 / 正文分页测试书」，靠 window.api.deleteBook /
// deleteChapter 收尾（走书架 _trash），不污染后面的多窗口组。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group53SearchIndex(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    fileExists,
    userData,
    booksRoot,
    // 书库根下「测试书」的目录与 v0.4.1 旧书（灵感箱旧书）的书目路径都是前面组留下的：
    // 53a 要按路径核对「书库与书文件夹里都没多出索引文件」，53k 要核对旧书书目没被补 schemaVersion。
    bookDir,
    fragLegacyMetaPath
  } = t;

  // 53. 正文全文搜索索引（提案 7.3）：书架搜索升级成能搜正文。
  // 索引只写 userData\search-index.json（不进书库、不含正文），靠每章 mtime/size 增量更新。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const searchIndexPath = path.join(userData, 'search-index.json');
  const ensureSearchIndex = async (force) => {
    const res = await exec(
      `window.__cwTest.ensureSearchIndex({ force: ${force ? 'true' : 'false'} })`
    );
    if (!res) throw new Error('建正文索引失败');
    return res;
  };
  const waitShelfContent = async (query, predicate = () => true, timeout = 20000) => {
    const startedAt = Date.now();
    let state = null;
    for (;;) {
      state = await exec('window.__cwTest.shelfContentState()');
      if (state && state.query === query && !state.loading && predicate(state)) return state;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待正文搜索结果超时：${query} :: ${JSON.stringify(state)}`);
      }
      await sleep(150);
    }
  };
  const addSearchChapter = async (name, text) => {
    await exec(`window.__cwTest.newChapter(${JSON.stringify(name)})`);
    await waitFor(`window.__cwTest.currentTitle().includes(${JSON.stringify(name)})`);
    await exec(`window.__cwTest.setText(${JSON.stringify(text)})`);
    await exec('window.__cwTest.save()');
    await waitFor('window.__cwTest.dirty() === false');
  };

  // 53a. 书架加载后索引自动建好：只写 userData，书库 / 书文件夹里都没有索引文件
  const searchStatus = await ensureSearchIndex(false);
  check(
    '正文搜索：书架加载后自动建好索引（userData\\search-index.json，不在书库）',
    searchStatus &&
      searchStatus.file === searchIndexPath &&
      searchStatus.books >= 1 &&
      searchStatus.chapters >= 1 &&
      searchStatus.bytes > 0 &&
      searchStatus.ready === true &&
      String(searchStatus.builtAt || '').length > 10,
    {
      file: searchStatus && searchStatus.file,
      books: searchStatus && searchStatus.books,
      chapters: searchStatus && searchStatus.chapters
    }
  );
  check(
    '正文搜索：索引只在 userData，书库根目录 / 书文件夹里都没有多出索引文件',
    (await fileExists(searchIndexPath)) &&
      (await fileExists(path.join(booksRoot, 'search-index.json'))) === false &&
      (await fileExists(path.join(bookDir, 'search-index.json'))) === false &&
      (await fs.readdir(booksRoot)).every((name) => !/search-index/i.test(name))
  );

  // 53b. 造一本已知正文的书：三章，前两章带同一个少见短语，第三章不带
  await exec("window.__cwTest.newBook('正文搜索测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const searchBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '旧车站')");
  const searchText1 = '雨还在下。他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风从海面吹来。';
  const searchText2 = '夜雨敲着窗。青柠色的雨伞靠在门边，滴着水。\n她一直没有回来。';
  const searchText3 = '清晨的街道很安静，只有早点摊的蒸汽。';
  await exec(`window.__cwTest.setText(${JSON.stringify(searchText1)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await addSearchChapter('夜雨', searchText2);
  await addSearchChapter('清晨', searchText3);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const searchMetaPath = path.join(searchBookPath, '书目.json');
  const searchMeta = JSON.parse(await fs.readFile(searchMetaPath, 'utf8'));
  const searchChapterFiles = searchMeta.chapters.map((chapter) => chapter.file);
  const searchBuilt = await ensureSearchIndex(true);
  check(
    '正文搜索：新书 / 新章进入索引（每章都有 mtime/size 指纹）',
    searchBuilt.books >= 2 && searchBuilt.chapters >= 4 && searchMeta.chapters.length === 3,
    { books: searchBuilt.books, chapters: searchBuilt.chapters }
  );
  const indexRaw = await fs.readFile(searchIndexPath, 'utf8');
  const indexParsed = JSON.parse(indexRaw);
  const indexBook = indexParsed.books.find((book) => book.folder === path.basename(searchBookPath));
  check(
    '正文搜索：索引里只有哈希位图和文件指纹，不存正文（正文句子不在索引文件里）',
    indexBook &&
      indexBook.chapters.length === 3 &&
      indexBook.chapters.every((chapter) => chapter.mtimeMs > 0 && chapter.size > 0) &&
      indexBook.chapters.every((chapter) => !('text' in chapter)) &&
      indexRaw.includes('青柠色的雨伞') === false &&
      indexRaw.includes('早点摊的蒸汽') === false &&
      indexBook.bloom.length > 8 &&
      indexBook.bloomBits > 0,
    { chapters: indexBook && indexBook.chapters.length }
  );

  // 53c. 书架搜正文：书名 / 章名没命中，但正文命中两章；结果带上下文，搜索全程只读
  const searchConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const searchMetaBefore = await fs.readFile(searchMetaPath, 'utf8');
  const searchTxtBefore = [];
  for (const file of searchChapterFiles) {
    searchTxtBefore.push(await fs.readFile(path.join(searchBookPath, file), 'utf8'));
  }
  check(
    '正文搜索：搜索框提示写明可以搜正文',
    String(await exec("document.getElementById('shelf-search').placeholder")).includes('正文')
  );
  await exec("window.__cwTest.setShelfQuery('青柠色的雨伞')");
  const contentHit = await waitShelfContent('青柠色的雨伞', (state) => state.results.length === 2);
  check(
    '正文搜索：能搜到正文，结果显示书名 + 章名 + 命中上下文',
    contentHit.visible === true &&
      contentHit.results.length === 2 &&
      contentHit.results[0].bookTitle === '正文搜索测试书' &&
      contentHit.results[0].chapterIndex === 0 &&
      contentHit.results[0].chapterName === '旧车站' &&
      contentHit.results[1].chapterIndex === 1 &&
      contentHit.results[1].chapterName === '夜雨' &&
      contentHit.results.every((row) => row.snippet && row.snippet.match === '青柠色的雨伞') &&
      contentHit.results[0].snippet.before.includes('一把') &&
      contentHit.results[0].snippet.after.includes('的月台'),
    contentHit.results.map((row) => ({ name: row.chapterName, snippet: row.snippet }))
  );
  check(
    '正文搜索：摘要显示「正文命中 N 处 / 已查几本」，书名与章名过滤仍然有效',
    contentHit.summary.includes('正文命中 2 处') &&
      (await exec('window.__cwTest.shelfSearchSummary()')).includes('正文命中 2 处') &&
      (await exec('window.__cwTest.shelfContentRowTexts()')).some(
        (text) =>
          text.includes('正文搜索测试书') &&
          text.includes('第1章：旧车站') &&
          text.includes('青柠色的雨伞')
      ) &&
      (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0,
    contentHit.summary
  );
  const searchTxtAfter = [];
  for (const file of searchChapterFiles) {
    searchTxtAfter.push(await fs.readFile(path.join(searchBookPath, file), 'utf8'));
  }
  check(
    '正文搜索：搜索过程只读（config.json / 书目.json / 章节 txt 一个字节都没变）',
    (await fs.readFile(path.join(userData, 'config.json'), 'utf8')) === searchConfigBefore &&
      (await fs.readFile(searchMetaPath, 'utf8')) === searchMetaBefore &&
      searchTxtAfter.join('\n') === searchTxtBefore.join('\n')
  );

  // 53d. 点正文结果：直接打开那一章并选中命中位置（只移动选区 / 滚动，不改正文）
  await exec('window.__cwTest.clickShelfContentResult(1)');
  await waitFor("window.__cwTest.view() === 'editor'");
  const openedSearch = {
    path: await exec('window.__cwTest.bookPathValue()'),
    index: await exec('window.__cwTest.currentIndex()'),
    selected: await exec('window.__cwTest.selectionText()'),
    text: await exec('window.__cwTest.text()'),
    dirty: await exec('window.__cwTest.dirty()')
  };
  check(
    '正文搜索：点结果直接打开那一章并选中命中位置（不改正文、不产生未保存修改）',
    openedSearch.path === searchBookPath &&
      openedSearch.index === 1 &&
      openedSearch.selected === '青柠色的雨伞' &&
      openedSearch.text === searchText2 &&
      openedSearch.dirty === false,
    openedSearch
  );

  // 53e / 53f. 没命中时的提示；一个字不搜正文
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('绝对不存在的词组xyz')");
  const contentMiss = await waitShelfContent(
    '绝对不存在的词组xyz',
    (state) => state.results.length === 0 && !state.error
  );
  check(
    '正文搜索：正文没有命中时给出明确提示，不冒充找到',
    contentMiss.visible === true &&
      contentMiss.results.length === 0 &&
      contentMiss.summary.includes('正文没有找到') &&
      (await exec('window.__cwTest.shelfSearchSummary()')).includes('没有匹配')
  );
  await exec("window.__cwTest.setShelfQuery('雨')");
  await sleep(700);
  const shortQuery = await exec('window.__cwTest.shelfContentState()');
  check(
    '正文搜索：一个字不搜正文（最少两个字，避免全书架都命中）',
    shortQuery.visible === false && shortQuery.results.length === 0
  );

  // 53g. 外部改 txt（mtime / size 变了）：强制校验后索引跟着更新，旧正文不再命中
  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(150);
  const externalText = '外部的月光照在窗台上，像是没有人收的旧信。';
  const externalChapterFile = searchChapterFiles[2];
  await fs.writeFile(path.join(searchBookPath, externalChapterFile), externalText, 'utf8');
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('外部的月光')");
  const externalHit = await waitShelfContent('外部的月光', (state) => state.results.length === 1);
  check(
    '正文搜索：外部改过 txt（mtime / size 变了）后重建索引，能搜到新内容',
    externalHit.results.length === 1 && externalHit.results[0].chapterIndex === 2,
    externalHit.results
  );
  await exec("window.__cwTest.setShelfQuery('早点摊的蒸汽')");
  const externalOld = await waitShelfContent('早点摊的蒸汽', (state) => state.results.length === 0);
  check('正文搜索：外部删掉的旧正文不会再命中（索引不留旧文本）', externalOld.results.length === 0);

  // 53h. 改章名 / 删章节：只改元数据或剔除，书名 / 章名 / 章节数与磁盘一致
  await exec("window.__cwTest.setShelfQuery('')");
  const renamed = await exec(
    `window.api.renameChapter(${JSON.stringify(searchBookPath)}, ${JSON.stringify(
      searchMeta.chapters[0].id
    )}, '改名后的站台')`
  );
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('青柠色的雨伞')");
  const renamedHit = await waitShelfContent('青柠色的雨伞', (state) => state.results.length === 2);
  check(
    '正文搜索：改章名后索引跟着更新（结果还是那两章，章名已变）',
    renamed.ok === true && renamedHit.results[0].chapterName === '改名后的站台',
    renamedHit.results.map((row) => row.chapterName)
  );
  const deletedChapter = await exec(
    `window.api.deleteChapter(${JSON.stringify(searchBookPath)}, ${JSON.stringify(
      searchMeta.chapters[2].id
    )})`
  );
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('外部的月光')");
  const deletedHit = await waitShelfContent('外部的月光', (state) => state.results.length === 0);
  const searchBookEntries = await fs.readdir(searchBookPath);
  check(
    '正文搜索：删掉的章节从索引消失（文件进 _trash，不真删）',
    deletedChapter.ok === true &&
      deletedHit.results.length === 0 &&
      searchBookEntries.includes('_trash') &&
      (await fs.readdir(path.join(searchBookPath, '_trash'))).some((name) =>
        name.includes(externalChapterFile)
      ),
    searchBookEntries
  );

  // 53i. 整本书删掉后从索引消失
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.newBook('索引删除测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const disposableBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec(`window.__cwTest.setText('这本书里有一句「要被删掉的一本书」的独有正文。')`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const disposableBuilt = await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('要被删掉的一本书')");
  const disposableHit = await waitShelfContent('要被删掉的一本书', (state) => state.results.length === 1);
  const disposableDelete = await exec(
    `window.api.deleteBook(${JSON.stringify(disposableBookPath)})`
  );
  const afterDeleteBuilt = await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('要被删掉的一本书')");
  const disposableGone = await waitShelfContent('要被删掉的一本书', (state) => state.results.length === 0);
  check(
    '正文搜索：整本书删掉后从索引消失（索引书数跟着减）',
    disposableHit.results.length === 1 &&
      disposableDelete.ok === true &&
      disposableGone.results.length === 0 &&
      afterDeleteBuilt.books === disposableBuilt.books - 1 &&
      (await fileExists(disposableBookPath)) === false,
    { before: disposableBuilt.books, after: afterDeleteBuilt.books }
  );

  // 53j. 结果分页：9 条命中先显示 8 条，「显示更多」再展开；limit 生效并标记 truncated
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.newBook('正文分页测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.renameChapterAt(0, '第1页')");
  for (let i = 0; i < 9; i += 1) {
    if (i > 0) {
      await exec(`window.__cwTest.newChapter('第${i + 1}页')`);
      await waitFor(`window.__cwTest.currentTitle().includes('第${i + 1}页')`);
    }
    await exec(`window.__cwTest.setText(${JSON.stringify(`分页测试词出现在第${i + 1}章。`)} )`);
    await exec('window.__cwTest.save()');
    await waitFor('window.__cwTest.dirty() === false');
  }
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('分页测试词')");
  const paged = await waitShelfContent('分页测试词', (state) => state.results.length === 9);
  const firstPage = {
    rows: paged.rowCount,
    more: paged.moreVisible,
    summary: paged.summary
  };
  const afterMore = await exec('window.__cwTest.clickShelfContentMore()');
  await sleep(150);
  const secondPage = await exec('window.__cwTest.shelfContentState()');
  check(
    '正文搜索：结果分页显示（先 8 条，「显示更多」展开剩下的）',
    firstPage.rows === 8 &&
      firstPage.more === true &&
      firstPage.summary.includes('显示 8 条') &&
      afterMore === 16 &&
      secondPage.rowCount === 9 &&
      secondPage.moreVisible === false,
    { firstPage, afterMore, rows: secondPage.rowCount }
  );
  const limitedSearch = await exec("window.api.searchContent('分页测试词', { limit: 4 })");
  check(
    '正文搜索：limit 生效并标记 truncated（分页 / 限量由主进程兜底）',
    limitedSearch.ok === true &&
      limitedSearch.data.results.length === 4 &&
      limitedSearch.data.limit === 4 &&
      limitedSearch.data.truncated === true
  );

  // 53k. 旧数据兼容 + 索引不出现正文 + 配置不新增字段
  await exec("window.__cwTest.setShelfQuery('旧书正文')");
  const legacyHit = await waitShelfContent('旧书正文', (state) => state.results.length >= 1);
  check(
    '正文搜索：v0.4.1 旧书（没有 schemaVersion）照常能搜正文，书目不被补字段',
    legacyHit.results.some((row) => row.bookTitle === '灵感箱旧书') &&
      (await fs.readFile(fragLegacyMetaPath, 'utf8')).includes('"schemaVersion"') === false,
    legacyHit.results.map((row) => row.bookTitle)
  );
  const finalIndexRaw = await fs.readFile(searchIndexPath, 'utf8');
  const finalConfigAfterSearch = JSON.parse(
    await fs.readFile(path.join(userData, 'config.json'), 'utf8')
  );
  const searchConfigKeys = [
    'searchIndex',
    'searchIndexPath',
    'contentSearch',
    'searchEnabled',
    'bodySearch'
  ].filter((key) => key in finalConfigAfterSearch);
  check(
    '正文搜索：配置不新增任何搜索字段（索引全自动，作者不用配置）',
    searchConfigKeys.length === 0,
    searchConfigKeys
  );
  check(
    '正文搜索：索引文件里始终没有正文（拿本轮写过的正文句子核对）',
    finalIndexRaw.includes('青柠色的雨伞') === false &&
      finalIndexRaw.includes('分页测试词') === false &&
      finalIndexRaw.includes(searchText2.replace(/\n/g, '')) === false
  );
  check(
    '正文搜索：搜索不会在书文件夹里生成任何文件（索引只在 userData）',
    (await fs.readdir(searchBookPath)).every((name) => !/search-index|search_cache/i.test(name)) &&
      (await fs.readdir(booksRoot)).every((name) => !/search-index|search_cache/i.test(name))
  );
};
