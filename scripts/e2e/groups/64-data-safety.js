// E2E 第 64 组：数据安全回归（v0.9 C-7，安全审计 C7）。
//
// 单测（tests/atomic.test.js、tests/data-safety.test.js）已经把「原子写 / 备份完整性 / 书目损坏恢复」
// 的契约钉住；这一组走**真实 Electron + 真实 IPC**，确认同一套保证在真实进程里也成立，
// 并且界面的失败提示是中文可读的（不是半截界面、不是英文堆栈）：
//   1. 书目写盘前留 .bak，内容是上一版的**原始字节**（还原的最后一根救命稻草）。
//   2. 整本替换写盘前把原章节备份到书内 `_trash/替换备份-<时间戳>`，备份内容 = 替换前原文。
//   3. 连做两次整本替换：两份备份**互不覆盖**（同一秒撞名也不许共用目录），最早那份还能还原回最初正文；
//      还原前把当前内容再备份一份（还原点错了还有退路）。
//   4. 书目被外部写坏（截断成半写）：打开书明确报 PARSE_ERROR，不半还原、不写盘；
//      从 .bak 恢复后章节与正文完整，坏文件留档（`书目.json.corrupt-*`）。
//
// 自足：本组自己造一本 2 章的演练书、自己收尾删掉（走书架 _trash），不污染后面的多窗口组。

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group64DataSafety(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  // 64a. 造演练书：2 章，第一章两处命中（正文带 CRLF，和真实保存后的磁盘形态一致）
  const created = await storage.createBook(booksRoot, '数据安全演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  const file1 = meta.chapters[1].file;
  const original0 = '阿明走进屋里。\r\n阿明坐下。';
  await storage.saveChapterText(bookPath, file0, original0);
  await storage.saveChapterText(bookPath, file1, '这里没有那个人。');
  meta = await storage.readBookMeta(bookPath);
  check('数据安全：演练书造好 2 章', meta.chapters.length === 2, meta.chapters.length);

  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');

  // 64b. 真实 IPC 改章名 → 写盘前必须先把上一版原样备份成 .bak
  const beforeFirstWrite = await fs.readFile(metaPath, 'utf8');
  const renamed = await exec(
    `window.api.renameChapter(${JSON.stringify(bookPath)}, ${JSON.stringify(meta.chapters[1].id)}, '第二章 改名')`
  );
  check('数据安全：真实 IPC 改章名成功（书目写盘正常）', renamed && renamed.ok === true, renamed);
  check(
    '数据安全：书目写盘前留下 .bak，内容是上一版的原始字节（逐字节相同）',
    (await fs.readFile(bakPath, 'utf8')) === beforeFirstWrite,
    '书目.json.bak 与写盘前的 书目.json 不一致'
  );

  // 64c. 整本替换：备份内容 = 替换前原文；只备命中的章
  const first = await exec(
    `window.api.replaceBook(${JSON.stringify(bookPath)}, { query: '阿明', replacement: '小明' })`
  );
  check(
    '数据安全：整本替换命中 1 章 / 2 处',
    first && first.ok === true && first.data.chaptersChanged === 1 && first.data.occurrences === 2,
    first
  );
  const firstBackupName = path.basename(String(first.data.backupDir));
  check(
    '数据安全：替换备份落在书内 _trash，且只备份改动的章',
    (await fs.readdir(first.data.backupDir)).join(',') === file0,
    await fs.readdir(first.data.backupDir)
  );
  check(
    '数据安全：备份里是替换前的原文（逐字节）',
    (await fs.readFile(path.join(first.data.backupDir, file0), 'utf8')) === original0,
    '备份内容与替换前不一致'
  );
  check(
    '数据安全：替换后磁盘上是新正文（CRLF 保留）',
    (await fs.readFile(path.join(bookPath, file0), 'utf8')) === '小明走进屋里。\r\n小明坐下。',
    await fs.readFile(path.join(bookPath, file0), 'utf8')
  );

  // 64d. 再替换一次：两份备份互不覆盖（同一秒撞名时加 -2），最早那份仍是最初原文
  const second = await exec(
    `window.api.replaceBook(${JSON.stringify(bookPath)}, { query: '小明', replacement: '小红' })`
  );
  check('数据安全：第二次整本替换成功', second && second.ok === true && second.data.chaptersChanged === 1, second);
  const listed = await exec(`window.api.listReplaceBackups(${JSON.stringify(bookPath)})`);
  const backups = (listed && listed.data) || [];
  check(
    '数据安全：两次整本替换各自留一份备份（目录名不重复、不覆盖前一份）',
    listed.ok === true &&
      backups.length >= 2 &&
      new Set(backups.map((item) => item.name)).size === backups.length,
    backups.map((item) => item.name)
  );
  const earliest = backups.find((item) => item.name === firstBackupName);
  check(
    '数据安全：最早那份备份仍在，内容还是最初原文（没被第二次替换盖掉）',
    Boolean(earliest) &&
      (await fs.readFile(path.join(bookPath, '_trash', firstBackupName, file0), 'utf8')) === original0,
    earliest
  );

  // 64e. 「还原到替换前」还原最早那份 = 回到最初正文；还原前再备份一份当前内容
  const restored = await exec(
    `window.api.restoreReplaceBackup(${JSON.stringify(bookPath)}, ${JSON.stringify(firstBackupName)})`
  );
  check(
    '数据安全：还原最早那份备份后回到最初正文',
    restored &&
      restored.ok === true &&
      restored.data.restored === 1 &&
      (await storage.loadChapterText(bookPath, file0)).text === '阿明走进屋里。\n阿明坐下。',
    restored
  );
  const restoreBackupName = restored.ok ? path.basename(String(restored.data.restoreBackupDir)) : '';
  check(
    '数据安全：还原前把当前内容再备份一份（还原前备份-*，点错了还有退路）',
    restoreBackupName.startsWith('还原前备份-') &&
      (await fs.readFile(path.join(bookPath, '_trash', restoreBackupName, file0), 'utf8')) ===
        '小红走进屋里。\r\n小红坐下。',
    restoreBackupName
  );
  check(
    '数据安全：原替换备份不消耗，可以重复还原',
    (await exec(`window.api.listReplaceBackups(${JSON.stringify(bookPath)})`)).data.some(
      (item) => item.name === firstBackupName
    ),
    firstBackupName
  );

  // 64f. 书目被外部写坏（截断成半写）：打开书要明确报错，不能给半个界面、不能改写磁盘
  const fullMeta = await fs.readFile(metaPath, 'utf8');
  const truncated = fullMeta.slice(0, Math.floor(fullMeta.length * 0.6));
  await fs.writeFile(metaPath, truncated, 'utf8');
  const opened = await exec(`window.api.openBook(${JSON.stringify(bookPath)})`);
  check(
    '数据安全：书目半写时打开书明确报 PARSE_ERROR（不半还原、不崩）',
    opened && opened.ok === false && opened.code === 'PARSE_ERROR',
    opened
  );
  check('数据安全：打开失败不许改写磁盘（半写文件原样留着）', (await fs.readFile(metaPath, 'utf8')) === truncated);
  check(
    '数据安全：打开失败不把书登记成「打开中」（后面还能修复 / 删除）',
    (await storage.findOpenBookWindow(bookPath)) === null
  );

  // 64g. 从 .bak 恢复：章节与正文完整、坏文件留档、书架重新认这本书
  const repaired = await exec(`window.api.repairBook(${JSON.stringify(bookPath)}, 'bak')`);
  check(
    '数据安全：从 .bak 恢复成功，章节数还是 2',
    repaired && repaired.ok === true && repaired.data.meta.chapters.length === 2,
    repaired
  );
  const afterRepair = await storage.readBookMeta(bookPath);
  check(
    '数据安全：恢复后两章正文一个字节没丢',
    (await storage.loadChapterText(bookPath, afterRepair.chapters[0].file)).text === '阿明走进屋里。\n阿明坐下。' &&
      (await storage.loadChapterText(bookPath, afterRepair.chapters[1].file)).text === '这里没有那个人。',
    afterRepair.chapters.map((chapter) => chapter.file)
  );
  const corruptFiles = (await fs.readdir(bookPath)).filter((name) => name.startsWith('书目.json.corrupt-'));
  check('数据安全：坏掉的书目被留档成 书目.json.corrupt-*（不删、可回看）', corruptFiles.length === 1, corruptFiles);
  check(
    '数据安全：坏文件里就是那份半写内容（原样留证）',
    (await fs.readFile(path.join(bookPath, corruptFiles[0]), 'utf8')) === truncated
  );
  const shelfAfter = await storage.listBooks(booksRoot);
  check(
    '数据安全：修复后书架把这本书重新当成正常书（状态 ok）',
    shelfAfter.some((book) => book.path === bookPath && book.status === 'ok'),
    shelfAfter.filter((book) => book.path === bookPath).map((book) => book.status)
  );

  // 64h. 收尾：删掉演练书（书架 _trash 兜底），书架数量回到演练前
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removed = await deleteBookWithRetry(bookPath);
  check(
    '数据安全：演练书已移入书架 _trash（没有真删）',
    Boolean(removed && removed.ok === true) && removed.data.method === 'move',
    removed
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '数据安全：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
