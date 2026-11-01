// E2E 第 57 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组只做「渲染层塞进主进程的路径 / 文件名参数会不会被拒」的探测：期望值来源是
// tests/ipc-paths.test.js 与各 core 模块自己的校验；书 / 书架 / 库外文件都由前面的组造好，
// 组文件只 require node 内建，不碰产品代码。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group57IpcPaths(t) {
  const { exec, check, userData, bookDir, booksRoot, fileExists } = t;

  // 57. IPC 路径入口审计（v0.9 C-2）：
  //     渲染层能塞进主进程的每个「路径 / 文件名」参数，在真实 Electron 里都必须拒绝越界输入：
  //       · 书的路径只能是书架目录的直接子目录（handleBook → core/ipc-paths.assertBookPath）；
  //       · 章节文件名只能落在书文件夹里（core/storage.assertInside，含绝对路径与 ..）；
  //       · 历史备份组 / 文件名、替换备份目录名、碎片文件名只能是不带分隔符的基名。
  //     期望值的来源是单测 tests/ipc-paths.test.js + 各 core 模块自己的校验；这里只证明「真的拒绝」
  //     以及「被拒的调用没有副作用」（书目 / 章节 / 书架逐字节不变，库外文件也没被删）。
  //     放在多窗口组之前：那一组最后会关掉最后一个窗口让应用退出。
  const ipcOutsideDir = path.join(userData, 'ipc-审计-库外');
  await fs.mkdir(ipcOutsideDir, { recursive: true });
  await fs.writeFile(path.join(ipcOutsideDir, '外部.txt'), '库外的文件，不该被读到 / 删掉\n', 'utf8');
  const auditBookBytes = async () => {
    const meta = await fs.readFile(path.join(bookDir, '书目.json'), 'utf8');
    const names = (await fs.readdir(bookDir)).filter((name) => /\.txt$/i.test(name)).sort();
    const texts = [];
    for (const name of names) {
      texts.push(`${name}::${await fs.readFile(path.join(bookDir, name), 'utf8')}`);
    }
    return `${meta}\n${texts.join('\n')}`;
  };
  const auditShelfBytes = async () =>
    (await fs.readdir(booksRoot))
      .sort()
      .map((name) => `${name}`)
      .join('|');
  const auditBookBefore = await auditBookBytes();
  const auditShelfBefore = await auditShelfBytes();
  const ipcProbePaths = {
    bookPath: bookDir,
    outsideDir: ipcOutsideDir,
    outsideFile: path.join(ipcOutsideDir, '外部.txt'),
    // 故意不用 path.join 归一化：要的就是带 `..` 的原始串，证明主进程自己 resolve 后再判定
    parentTraversal: `${bookDir}\\..\\..\\Windows`,
    grandchild: path.join(bookDir, '书里的子目录'),
    chapterTraversal: '..\\书目.json',
    chapterAbsolute: path.join(ipcOutsideDir, '外部.txt'),
    historyGroupTraversal: 'dir:..',
    historyFileTraversal: 'file:../../书目.json',
    replaceBackupTraversal: '..\\替换备份-20260101',
    fragmentTraversal: '..\\..\\书目.json'
  };
  const ipcProbe = JSON.parse(
    await exec(`(async () => {
      const P = ${JSON.stringify(ipcProbePaths)};
      const out = {};
      const grab = async (name, fn) => {
        try {
          const res = await fn();
          out[name] = { ok: Boolean(res && res.ok === true), code: (res && res.code) || '', message: (res && res.message) || '' };
        } catch (err) {
          out[name] = { ok: false, code: 'THREW', message: String(err && err.message) };
        }
      };
      await grab('openTraversal', () => window.api.openBook(P.parentTraversal));
      await grab('openGrandchild', () => window.api.openBook(P.grandchild));
      await grab('openNewWindowOutside', () => window.api.openBookInNewWindow(P.outsideDir));
      await grab('loadChapterTraversal', () => window.api.loadChapter(P.bookPath, P.chapterTraversal));
      await grab('loadChapterAbsolute', () => window.api.loadChapter(P.bookPath, P.chapterAbsolute));
      await grab('statChapterAbsolute', () => window.api.statChapter(P.bookPath, P.chapterAbsolute));
      await grab('openBookFolderOutside', () => window.api.openBookFolder(P.outsideDir));
      await grab('deleteBookOutside', () => window.api.deleteBook(P.outsideDir));
      await grab('previewGroupTraversal', () => window.api.previewHistoryFile(P.bookPath, P.historyGroupTraversal, 'x.txt'));
      await grab('previewFileTraversal', () => window.api.previewHistoryFile(P.bookPath, P.historyFileTraversal, 'x'));
      await grab('restoreDirTraversal', () => window.api.restoreHistoryDir(P.bookPath, P.historyGroupTraversal));
      await grab('restoreReplaceOutside', () => window.api.restoreReplaceBackup(P.bookPath, P.replaceBackupTraversal));
      await grab('readFragmentTraversal', () => window.api.readFragment(P.fragmentTraversal));
      const proto = await window.api.getBookDisplay('__proto__');
      out.protoKey = { ok: Boolean(proto && proto.ok === true), keys: proto && proto.data ? Object.keys(proto.data).length : -1, polluted: Boolean(({}).editorFont) };
      return JSON.stringify(out);
    })()`)
  );
  const rejectedWith = (name, code) =>
    Boolean(ipcProbe[name] && ipcProbe[name].ok === false && ipcProbe[name].code === code);
  check('路径审计：书路径带 .. 越界被拒（BAD_PATH）', rejectedWith('openTraversal', 'BAD_PATH'), ipcProbe.openTraversal);
  check(
    '路径审计：书的孙目录不算书（只认书架的直接子目录）',
    rejectedWith('openGrandchild', 'BAD_PATH'),
    ipcProbe.openGrandchild
  );
  check(
    '路径审计：window:open-book 同样只认书架里的书',
    rejectedWith('openNewWindowOutside', 'BAD_PATH'),
    ipcProbe.openNewWindowOutside
  );
  check(
    '路径审计：读章节不能带 .. 跳到书外（BAD_PATH）',
    rejectedWith('loadChapterTraversal', 'BAD_PATH'),
    ipcProbe.loadChapterTraversal
  );
  check(
    '路径审计：读章节不接受库外的绝对路径（BAD_PATH）',
    rejectedWith('loadChapterAbsolute', 'BAD_PATH'),
    ipcProbe.loadChapterAbsolute
  );
  check(
    '路径审计：章节 stat 同样不接受库外绝对路径（BAD_PATH）',
    rejectedWith('statChapterAbsolute', 'BAD_PATH'),
    ipcProbe.statChapterAbsolute
  );
  check(
    '路径审计：打开库外文件夹被拒（BAD_PATH）',
    rejectedWith('openBookFolderOutside', 'BAD_PATH'),
    ipcProbe.openBookFolderOutside
  );
  check('路径审计：删除库外目录被拒（BAD_PATH）', rejectedWith('deleteBookOutside', 'BAD_PATH'), ipcProbe.deleteBookOutside);
  check(
    '路径审计：历史备份组 id 不能带 ..（BAD_GROUP）',
    rejectedWith('previewGroupTraversal', 'BAD_GROUP'),
    ipcProbe.previewGroupTraversal
  );
  check(
    '路径审计：历史备份文件名只能是基名（BAD_GROUP）',
    rejectedWith('previewFileTraversal', 'BAD_GROUP'),
    ipcProbe.previewFileTraversal
  );
  check(
    '路径审计：还原整个备份组也挡 ..（BAD_GROUP）',
    rejectedWith('restoreDirTraversal', 'BAD_GROUP'),
    ipcProbe.restoreDirTraversal
  );
  check(
    '路径审计：替换备份目录名只能是带前缀的基名（BAD_BACKUP）',
    rejectedWith('restoreReplaceOutside', 'BAD_BACKUP'),
    ipcProbe.restoreReplaceOutside
  );
  check(
    '路径审计：碎片文件名不能带路径分隔符（BAD_NAME）',
    rejectedWith('readFragmentTraversal', 'BAD_NAME'),
    ipcProbe.readFragmentTraversal
  );
  check(
    '路径审计：书 id 传 __proto__ 不污染对象原型（按书设置照旧返回空）',
    ipcProbe.protoKey.ok === true && ipcProbe.protoKey.keys === 0 && ipcProbe.protoKey.polluted === false,
    ipcProbe.protoKey
  );
  check('路径审计：被拒的调用没有改书目 / 章节文件（逐字节一致）', (await auditBookBytes()) === auditBookBefore);
  check('路径审计：被拒的调用没有改动书架目录（没有多出 / 少了书）', (await auditShelfBytes()) === auditShelfBefore);
  check(
    '路径审计：库外的目录与文件都还在（删除请求真的被拦在前面）',
    (await fileExists(path.join(ipcOutsideDir, '外部.txt'))) &&
      (await fs.readFile(path.join(ipcOutsideDir, '外部.txt'), 'utf8')).includes('不该被读到')
  );
  check(
    '路径审计：库外文件没有被读进界面（渲染层没拿到正文）',
    !JSON.stringify(ipcProbe).includes('库外的文件') && !JSON.stringify(ipcProbe).includes('不该被读到')
  );
};
