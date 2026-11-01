// E2E 第 66 组：破坏性操作可恢复性（v0.9 C-8，安全审计 C8）。
//
// 单测（tests/destructive-recovery.test.js）已经把「删章回滚 / 整理·替换·还原中途失败的现场」
// 钉在 core/storage.js 这一层；这一组走**真实 Electron + 真实 IPC**，确认在真窗口里：
//   1. 删「当前章」且还有未保存的字 → 先弹「删除前先处理未保存的修改」，取消后一个字都不丢；
//      选「不保存，直接删除」才进删除确认，删掉的只是磁盘上的那一版（在 _trash 里）。
//   2. 整本整理中途写盘失败（真实只读章节文件 → 真实 EPERM）：错误提示要带
//      「已经整理好 N 章 + 整理备份-…」；界面要按磁盘重载（编辑区不许停在旧正文上）；
//      恢复写权限后重跑，剩下那章照常整理完。
//   3. 全程只读断言：_trash 里的东西一份都不少、章节文件不改名、演练结束书架数量复原。
//
// 自足：本组自己造一本 2 章的演练书、自己收尾删掉（走书架 _trash），不污染后面的多窗口组。

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group66DestructiveRecovery(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  // 66a. 造演练书：2 章，正文都带「未整理」的特征（行尾空格、没有段首缩进）
  const created = await storage.createBook(booksRoot, '破坏性操作演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [file0, file1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file0, '阿明第一段  ');
  await storage.saveChapterText(bookPath, file1, '阿明第二段  ');
  meta = await storage.readBookMeta(bookPath);
  check('破坏性操作：演练书造好 2 章', meta.chapters.length === 2, meta.chapters.length);

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const index0 = await exec('window.__cwTest.currentIndex()');
  check('破坏性操作：打开演练书停在第 1 章', index0 === 0, index0);

  // 66b. 改字（未保存）→ 删当前章：必须先问，不能静默丢编辑区里的字
  await exec("window.__cwTest.setText('阿明第一段 改过但还没保存')");
  check('破坏性操作：当前章有未保存的修改', (await exec('window.__cwTest.dirty()')) === true);
  await exec('window.__cwTest.clearToasts()');
  const delCancel = exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '破坏性操作：删「当前章」前先弹「删除前先处理未保存的修改」',
    (await exec('window.__cwTest.dialog()')) === '删除前先处理未保存的修改'
  );
  const unsavedMessage = await exec('window.__cwTest.modalMessage()');
  check(
    '破坏性操作：提示说明编辑区里没保存的字不会跟着进 _trash',
    unsavedMessage.includes('不会跟着进去') && unsavedMessage.includes('_trash'),
    unsavedMessage
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  await delCancel;
  check(
    '破坏性操作：选取消后章节还在、编辑区里的字一个都没丢',
    (await exec('window.__cwTest.chapterTitles()')).length === 2 &&
      (await exec('window.__cwTest.text()')) === '阿明第一段 改过但还没保存' &&
      (await exec('window.__cwTest.dirty()')) === true,
    await exec('window.__cwTest.text()')
  );
  check(
    '破坏性操作：取消时磁盘上的章节文件也没动',
    (await storage.loadChapterText(bookPath, file0)).text === '阿明第一段  '
  );

  // 66c. 再来一次，选「不保存，直接删除」：删掉的只是磁盘上那一版（进 _trash）
  const delOk = exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '破坏性操作：第二次删除仍然先问未保存的修改',
    (await exec('window.__cwTest.dialog()')) === '删除前先处理未保存的修改'
  );
  await exec("window.__cwTest.answerModal('discard')");
  await waitFor("window.__cwTest.dialog() === '删除章节'");
  await exec("window.__cwTest.answerModal('delete')");
  await delOk;
  await waitFor('window.__cwTest.chapterTitles().length === 1');
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  const trashed = trashNames.filter((name) => name.endsWith(file0));
  check(
    '破坏性操作：章节文件移进书内 _trash（带时间戳前缀，不是真删）',
    trashed.length === 1 && trashed[0] !== file0,
    trashNames
  );
  if (trashed.length === 1) {
    check(
      '破坏性操作：_trash 里是磁盘上的那一版（未保存的改字没有被写进去）',
      (await fs.readFile(path.join(bookPath, '_trash', trashed[0]), 'utf8')) === '阿明第一段  ',
      await fs.readFile(path.join(bookPath, '_trash', trashed[0]), 'utf8')
    );
  }
  check(
    '破坏性操作：删除后界面上只剩另一章、且不再是未保存状态',
    (await exec('window.__cwTest.chapterTitles()')).length === 1 &&
      (await exec('window.__cwTest.dirty()')) === false,
    await exec('window.__cwTest.chapterTitles()')
  );

  // 66d. 整本整理中途写盘失败（真实只读章节文件 → 真实 EPERM）
  // 注意：newChapter() 不传章名会弹「新建章节」输入框 —— 那会让本组的 exec 一直等下去，
  // 所以这里必须传名字（和场景里其它组的写法一致）。
  await exec("window.__cwTest.newChapter('第三章')");
  await waitFor('window.__cwTest.chapterTitles().length === 2');
  meta = await storage.readBookMeta(bookPath);
  const currentFile = meta.chapters[0].file;
  const failingFile = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, currentFile, '阿明第二段  ');
  await storage.saveChapterText(bookPath, failingFile, '阿明第三段  ');
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec('window.__cwTest.clearToasts()');

  const failingPath = path.join(bookPath, failingFile);
  await fs.chmod(failingPath, 0o444);
  let formatResult = null;
  try {
    const formatPromise = exec('window.__cwTest.runFormatBook()');
    await waitFor('window.__cwTest.modalOpen()');
    check(
      '破坏性操作：整本整理先弹确认框',
      (await exec('window.__cwTest.dialog()')) === '一键整理本书'
    );
    await exec("window.__cwTest.answerModal('ok')");
    formatResult = await formatPromise;
  } finally {
    await fs.chmod(failingPath, 0o666);
  }

  check(
    '破坏性操作：中途失败时返回失败（不是假装整理完）',
    formatResult && formatResult.ok === false,
    formatResult
  );
  const failMessage = String((formatResult && formatResult.message) || '');
  check(
    '破坏性操作：失败提示带「已经整理好 1 章」与整理备份目录',
    failMessage.includes('已经整理好 1 章') && /_trash\/整理备份-/.test(failMessage),
    failMessage
  );
  check(
    '破坏性操作：失败提示不带本机绝对路径（只给 _trash 下的目录名）',
    !failMessage.includes(booksRoot) && !/[\r\n]/.test(failMessage),
    failMessage
  );
  check(
    '破坏性操作：已经整理好的那一章真写盘了',
    (await storage.loadChapterText(bookPath, currentFile)).text === '　　阿明第二段',
    (await storage.loadChapterText(bookPath, currentFile)).text
  );
  check(
    '破坏性操作：失败的那一章一个字节没动',
    (await storage.loadChapterText(bookPath, failingFile)).text === '阿明第三段  ',
    (await storage.loadChapterText(bookPath, failingFile)).text
  );
  const toasts = await exec('window.__cwTest.toasts()');
  check(
    '破坏性操作：界面上能看到这条失败提示（含备份目录）',
    toasts.some((toast) => toast.message.includes('整理本书失败') && toast.message.includes('已经整理好 1 章')),
    toasts.slice(-3)
  );
  await waitFor(
    `window.__cwTest.text() === ${JSON.stringify('　　阿明第二段')}`,
    10000
  ).catch(() => null);
  check(
    '破坏性操作：失败后编辑区按磁盘重载（不停在整理前的旧正文上）',
    (await exec('window.__cwTest.text()')) === '　　阿明第二段',
    await exec('window.__cwTest.text()')
  );

  // 66e. 恢复写权限后重跑：剩下那一章也整理完，备份目录另起一个
  const retryPromise = exec('window.__cwTest.runFormatBook()');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '破坏性操作：重跑时确认框只报剩下要改的 1 章',
    String(await exec('window.__cwTest.modalMessage()')).includes('1 章有改动'),
    await exec('window.__cwTest.modalMessage()')
  );
  await exec("window.__cwTest.answerModal('ok')");
  const retried = await retryPromise;
  check(
    '破坏性操作：重跑后两章都整理好了',
    retried && retried.ok === true && retried.changed === 1 &&
      (await storage.loadChapterText(bookPath, currentFile)).text === '　　阿明第二段' &&
      (await storage.loadChapterText(bookPath, failingFile)).text === '　　阿明第三段',
    retried
  );
  const backupDirs = (await fs.readdir(path.join(bookPath, '_trash'))).filter((name) =>
    name.startsWith('整理备份-')
  );
  check('破坏性操作：失败那次与重跑那次的整理备份各留一份', backupDirs.length === 2, backupDirs);

  // 66f. 收尾：删掉演练书（书架 _trash 兜底），书架数量回到演练前
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removed = await deleteBookWithRetry(bookPath);
  check(
    '破坏性操作：演练书已移入书架 _trash（没有真删）',
    Boolean(removed && removed.ok === true) && removed.data.method === 'move',
    removed
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '破坏性操作：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
