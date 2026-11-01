// E2E 第 61 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group61IpcLimits(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  // 61. IPC 参数边界与 DoS（v0.9 C-5，安全审计 C2）：
  //     文本类 / 查找替换 / 导出预览 / 跳章这些频道接收渲染层传来的正文、查找词、替换词、
  //     当前章覆盖内容与章节列表。坏类型 / 超长输入必须被拒（固定错误码 + 中文提示）或降级，
  //     而且不能留下任何副作用（章节文件、_trash、config）；之后主进程仍要能正常响应。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c5ShelfBefore = (await storage.listBooks(booksRoot)).length;
  await exec(`window.__cwTest.newBook('边界演练')`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const c5BookPath = await exec('window.__cwTest.bookPathValue()');
  await exec(`window.__cwTest.setText('边界演练的正文：风从海面吹来。')`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec(`window.__cwTest.newChapter('第二章')`);
  await waitFor('window.__cwTest.chapterTitles().length === 2');
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const c5Meta = await storage.readBookMeta(c5BookPath);
  const c5FirstChapter = c5Meta.chapters[0];
  const c5FirstPath = path.join(c5BookPath, c5FirstChapter.file);
  const c5DiskBefore = await fs.readFile(c5FirstPath, 'utf8');

  // 61a. 正文：非文本 BAD_TEXT、超长 TEXT_TOO_LARGE（固定错误码 + 中文提示，带千分位）
  const c5BadText = JSON.parse(await exec(`window.api.formatText({}).then((r) => JSON.stringify(r))`));
  const c5HugeText = JSON.parse(
    await exec(`window.api.findAll('字'.repeat(5000001), '字').then((r) => JSON.stringify(r))`)
  );
  check(
    'IPC 边界：非文本正文回 BAD_TEXT / 超大正文回 TEXT_TOO_LARGE（中文提示、带千分位）',
    Boolean(c5BadText && c5BadText.ok === false) &&
      c5BadText.code === 'BAD_TEXT' &&
      c5BadText.message === '正文必须是文本' &&
      Boolean(c5HugeText && c5HugeText.ok === false) &&
      c5HugeText.code === 'TEXT_TOO_LARGE' &&
      c5HugeText.message === '正文太长（5,000,001 字，最多 5,000,000 字）',
    { badText: c5BadText, hugeText: c5HugeText }
  );

  // 61b. 查找词 / 替换词：坏类型与超长都被拒（上限 1 万字）
  const c5BadQuery = JSON.parse(
    await exec(`window.api.findInText('正文', {}).then((r) => JSON.stringify(r))`)
  );
  const c5LongQuery = JSON.parse(
    await exec(`window.api.findAll('正文', 'q'.repeat(10001)).then((r) => JSON.stringify(r))`)
  );
  const c5BadReplaceWord = JSON.parse(
    await exec(`window.api.replaceInText('abc', 'a', 42).then((r) => JSON.stringify(r))`)
  );
  const c5LongReplaceWord = JSON.parse(
    await exec(`window.api.replaceInText('abc', 'a', 'x'.repeat(10001)).then((r) => JSON.stringify(r))`)
  );
  check(
    'IPC 边界：坏查找词回 BAD_QUERY / 超长回 QUERY_TOO_LARGE / 坏替换词回 BAD_REPLACEMENT',
    Boolean(c5BadQuery && c5BadQuery.ok === false) &&
      c5BadQuery.code === 'BAD_QUERY' &&
      c5BadQuery.message === '查找内容必须是文本' &&
      Boolean(c5LongQuery && c5LongQuery.ok === false) &&
      c5LongQuery.code === 'QUERY_TOO_LARGE' &&
      c5LongQuery.message === '查找内容太长（10,001 字，最多 10,000 字）' &&
      Boolean(c5BadReplaceWord && c5BadReplaceWord.ok === false) &&
      c5BadReplaceWord.code === 'BAD_REPLACEMENT' &&
      c5BadReplaceWord.message === '替换内容必须是文本' &&
      Boolean(c5LongReplaceWord && c5LongReplaceWord.ok === false) &&
      c5LongReplaceWord.code === 'REPLACEMENT_TOO_LARGE' &&
      c5LongReplaceWord.message === '替换内容太长（10,001 字，最多 10,000 字）',
    { badQuery: c5BadQuery, longQuery: c5LongQuery, badReplace: c5BadReplaceWord, longReplace: c5LongReplaceWord }
  );

  // 61c. 替换放大：3000 处 × 一处换 1 万字 ≈ 3000 万字，先拒绝、不生成字符串；正常替换照旧
  const c5Amp = JSON.parse(
    await exec(
      `window.api.replaceInText('中'.repeat(3000), '中', 'x'.repeat(10000)).then((r) => JSON.stringify(r))`
    )
  );
  const c5NormalReplace = JSON.parse(
    await exec(`window.api.replaceInText('abcabc', 'abc', 'XYZ').then((r) => JSON.stringify(r))`)
  );
  check(
    'IPC 边界：替换结果估算超 2000 万字直接拒绝，正常替换结果不变',
    Boolean(c5Amp && c5Amp.ok === false) &&
      c5Amp.code === 'REPLACE_TOO_LARGE' &&
      c5Amp.message === '替换结果太大（约 30,000,000 字，最多 20,000,000 字）；请缩短替换内容或减少替换处数' &&
      Boolean(c5NormalReplace && c5NormalReplace.ok === true) &&
      c5NormalReplace.data.text === 'XYZXYZ' &&
      c5NormalReplace.data.count === 2,
    { amp: c5Amp, normal: c5NormalReplace }
  );

  // 61d. 书级查找 / 替换：坏 options 被拒；被拒的替换不写章节文件、不留 _trash
  const c5BookBadQuery = JSON.parse(
    await exec(`window.api.searchBook(${JSON.stringify(c5BookPath)}, { query: {} }).then((r) => JSON.stringify(r))`)
  );
  const c5BookLongReplace = JSON.parse(
    await exec(
      `window.api.replaceBook(${JSON.stringify(c5BookPath)}, { query: '边界演练', replacement: 'y'.repeat(10001) }).then((r) => JSON.stringify(r))`
    )
  );
  // 非对象 options：按旧行为当 {}（降级成 EMPTY_QUERY，不是崩溃 / 不是整本乱替换）
  const c5BookBadOptions = JSON.parse(
    await exec(`window.api.replaceBook(${JSON.stringify(c5BookPath)}, '不是对象').then((r) => JSON.stringify(r))`)
  );
  check(
    'IPC 边界：书级查找坏查询回 BAD_QUERY / 超长替换词被拒 / 坏 options 降级成空查询',
    Boolean(c5BookBadQuery && c5BookBadQuery.ok === false) &&
      c5BookBadQuery.code === 'BAD_QUERY' &&
      Boolean(c5BookLongReplace && c5BookLongReplace.ok === false) &&
      c5BookLongReplace.code === 'REPLACEMENT_TOO_LARGE' &&
      Boolean(c5BookBadOptions && c5BookBadOptions.ok === false) &&
      c5BookBadOptions.code === 'EMPTY_QUERY' &&
      c5BookBadOptions.message === '查找内容不能为空',
    { badQuery: c5BookBadQuery, longReplace: c5BookLongReplace, badOptions: c5BookBadOptions }
  );
  const c5TrashExists = await fs
    .access(path.join(c5BookPath, '_trash'))
    .then(() => true)
    .catch(() => false);
  check(
    'IPC 边界：被拒的书级替换没有改动章节文件、也没有建 _trash 备份目录',
    (await fs.readFile(c5FirstPath, 'utf8')) === c5DiskBefore && c5TrashExists === false,
    { disk: await fs.readFile(c5FirstPath, 'utf8'), trash: c5TrashExists }
  );

  // 61e. 跳章：超过 2 万条只取前 2 万条（降级），章名超长截断后仍能命中，坏条目跳过
  const c5JumpBad = JSON.parse(
    await exec(`window.api.jumpMatch('不是数组', 'x').then((r) => JSON.stringify(r))`)
  );
  const c5JumpMany = `Array.from({ length: 20005 }, (_, i) => ({ id: 'ch_' + i, name: '第' + (i + 1) + '章' }))`;
  const c5JumpLast = JSON.parse(
    await exec(`window.api.jumpMatch(${c5JumpMany}, '第20000章').then((r) => JSON.stringify(r))`)
  );
  const c5JumpBeyond = JSON.parse(
    await exec(`window.api.jumpMatch(${c5JumpMany}, '第20005章').then((r) => JSON.stringify(r))`)
  );
  const c5JumpLongName = JSON.parse(
    await exec(
      `window.api.jumpMatch([{ id: 'ch_long', name: '关键词' + '啊'.repeat(50000) }], '关键词').then((r) => JSON.stringify(r))`
    )
  );
  check(
    'IPC 边界：跳章章节列表超 2 万条降级、超长章名截断后仍能命中、非数组回 BAD_CHAPTERS',
    Boolean(c5JumpBad && c5JumpBad.ok === false) &&
      c5JumpBad.code === 'BAD_CHAPTERS' &&
      c5JumpBad.message === '章节列表格式不对' &&
      Boolean(c5JumpLast && c5JumpLast.ok === true) &&
      c5JumpLast.data.chapterCount === 20000 &&
      c5JumpLast.data.total === 1 &&
      c5JumpLast.data.matches[0].index === 19999 &&
      Boolean(c5JumpBeyond && c5JumpBeyond.ok === true) &&
      c5JumpBeyond.data.total === 0 &&
      Boolean(c5JumpLongName && c5JumpLongName.ok === true) &&
      c5JumpLongName.data.total === 1 &&
      c5JumpLongName.data.matches[0].name.length === 2000,
    { bad: c5JumpBad, last: c5JumpLast && c5JumpLast.data, beyond: c5JumpBeyond && c5JumpBeyond.data }
  );

  // 61f. 导出预览：override 坏类型 / 超长被拒；坏 range 按旧行为收紧 / 降级，不报错
  const c5PlanBadOverride = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c5BookPath)}, { text: 123 }, null).then((r) => JSON.stringify(r))`
    )
  );
  const c5PlanHugeOverride = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c5BookPath)}, { text: 'x'.repeat(5000001) }, null).then((r) => JSON.stringify(r))`
    )
  );
  const c5PlanUnsaved = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c5BookPath)}, { chapterId: ${JSON.stringify(c5FirstChapter.id)}, text: '未保存的正文' }, null).then((r) => JSON.stringify(r))`
    )
  );
  const c5PlanRange = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c5BookPath)}, null, { mode: 'range', from: -5, to: 999999 }).then((r) => JSON.stringify(r))`
    )
  );
  const c5PlanUnknown = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c5BookPath)}, null, '不是范围').then((r) => JSON.stringify(r))`
    )
  );
  check(
    'IPC 边界：导出预览拒绝坏 / 超长 override，坏 range 按全书或收紧到 1–总章数（降级不报错）',
    Boolean(c5PlanBadOverride && c5PlanBadOverride.ok === false) &&
      c5PlanBadOverride.code === 'BAD_TEXT' &&
      c5PlanBadOverride.message === '当前章正文必须是文本' &&
      Boolean(c5PlanHugeOverride && c5PlanHugeOverride.ok === false) &&
      c5PlanHugeOverride.code === 'TEXT_TOO_LARGE' &&
      c5PlanHugeOverride.message === '当前章正文太长（5,000,001 字，最多 5,000,000 字）' &&
      Boolean(c5PlanUnsaved && c5PlanUnsaved.ok === true) &&
      c5PlanUnsaved.data.includedUnsaved === true &&
      c5PlanUnsaved.data.chars === 6 &&
      c5PlanUnsaved.data.chapterCount === 2 &&
      Boolean(c5PlanRange && c5PlanRange.ok === true) &&
      c5PlanRange.data.from === 1 &&
      c5PlanRange.data.to === 2 &&
      c5PlanRange.data.chapterCount === 2 &&
      Boolean(c5PlanUnknown && c5PlanUnknown.ok === true) &&
      c5PlanUnknown.data.mode === 'all' &&
      c5PlanUnknown.data.chapterCount === 2,
    {
      badOverride: c5PlanBadOverride,
      hugeOverride: c5PlanHugeOverride,
      unsaved: c5PlanUnsaved && c5PlanUnsaved.data,
      range: c5PlanRange && c5PlanRange.data,
      unknown: c5PlanUnknown && c5PlanUnknown.data
    }
  );

  // 61g. 所有拒绝提示都是中文结论，不含本机路径 / 输入原文
  const c5Rejections = [
    c5BadText,
    c5HugeText,
    c5BadQuery,
    c5LongQuery,
    c5BadReplaceWord,
    c5LongReplaceWord,
    c5Amp,
    c5BookBadQuery,
    c5BookLongReplace,
    c5JumpBad,
    c5PlanBadOverride,
    c5PlanHugeOverride
  ];
  check(
    'IPC 边界：拒绝提示全部是中文结论，不含盘符路径 / 书库根目录 / 超长输入原文',
    c5Rejections.every(
      (item) =>
        item &&
        item.ok === false &&
        typeof item.message === 'string' &&
        item.message.length > 0 &&
        item.message.length < 200 &&
        !/[A-Za-z]:[\\/]/.test(item.message) &&
        !item.message.includes(booksRoot) &&
        !item.message.includes('不是数组') &&
        !/^\s*[\[{]/.test(item.message)
    ),
    c5Rejections.map((item) => ({ code: item && item.code, message: item && item.message }))
  );

  // 61h. 连续坏参数之后主进程仍在响应：正常排版 / 查找 / 保存照旧
  const c5StillOk = JSON.parse(
    await exec(`(async () => {
      const formatted = await window.api.formatText('第一段\\n\\n第二段', {});
      const found = await window.api.findAll('风从海面吹来。', '风', {});
      return JSON.stringify({ formatted, found });
    })()`)
  );
  check(
    'IPC 边界：坏参数风暴之后排版 / 查找仍正常（主进程还在响应）',
    Boolean(c5StillOk && c5StillOk.formatted && c5StillOk.formatted.ok === true) &&
      typeof c5StillOk.formatted.data.text === 'string' &&
      c5StillOk.formatted.data.text.includes('　　') &&
      Boolean(c5StillOk.found && c5StillOk.found.ok === true) &&
      c5StillOk.found.data.count === 1,
    c5StillOk
  );
  await exec("window.__cwTest.setText('边界演练：主进程还在响应。')");
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  check(
    'IPC 边界：坏参数风暴之后真实保存照常落盘（当前章内容写进 txt）',
    (await fs.readFile(path.join(c5BookPath, c5Meta.chapters[1].file), 'utf8')) ===
      '边界演练：主进程还在响应。'
  );

  // 61i. 收尾：删掉演练书（走书架 _trash 兜底），书架数量回到演练前
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c5Deleted = await deleteBookWithRetry(c5BookPath);
  check(
    'IPC 边界：演练书已移入书架 _trash',
    Boolean(c5Deleted && c5Deleted.ok === true) && c5Deleted.data.method === 'move',
    c5Deleted
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    'IPC 边界：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === c5ShelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
