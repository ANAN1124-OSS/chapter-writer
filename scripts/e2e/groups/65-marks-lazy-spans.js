// E2E 第 65 组：标记层「惰性 span」（v0.9 A-3，编辑器手感 A3）。
//
// 单测（tests/editor-marks-plan.test.js）已经把「节点计划」的切法钉住；这一组走**真实 Electron
// + 真实 IPC**，确认真实窗口里的标记层行为与优化前一致：
//   1. 干净行合并成文本节点：章节有 40+ 行，但 `.marks-line` span 只有「超长段 / 当前段 / 带标记」
//      这几行（优化前是每行一个 span）。这条是省掉 10 万字整层重建近一半成本的直接证据。
//   2. 影子层正文逐字等于编辑区正文（把 ␣ / · 这两个装饰字符去掉后比对）——只要差一个字，
//      所有标记的位置都会跟着错位，这是标记层唯一不能破的不变量。
//   3. 对齐没被节点结构影响：影子层的 scrollHeight / 宽度 / 字体仍然和编辑区一致（换行必须一样）。
//   4. 光标移到「干净行」（本次没被标记的行）时高亮照常出现——渲染层会整层重建一次补上 span；
//      同一行内继续打字仍然只改 class。
//   5. 全流程只读：章节 txt 的字节与书目都不变，不生成 _trash。
//
// 自足：本组自己造一本 1 章（40+ 行 / 一段超长 / 一处全角空格 + 行尾空白）的演练书，
// 自己收尾删掉（走书架 _trash），不污染后面的多窗口组。

module.exports = async function group65MarksLazySpans(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;
  const fs = require('node:fs/promises');
  const path = require('node:path');

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  // 65a. 造演练书：一行超长段（>500 字）、一行带全角空格 + 行尾空白、其余普通行，共 45 行
  const created = await storage.createBook(booksRoot, '标记层惰性渲染演练');
  const bookPath = created.path;
  const lines = [];
  for (let i = 0; i < 45; i += 1) {
    if (i === 3) lines.push('长'.repeat(700)); // 第 4 行：超长段落
    else if (i === 5) lines.push('这一行有全角\u3000空格和行尾空白  '); // 第 6 行：两处标记
    else lines.push(`第${i + 1}行：这是一行普通正文，用来把章节撑到 40 行以上。`);
  }
  const chapterText = lines.join('\n');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, chapterText);
  const chapterPath = path.join(bookPath, file0);
  const txtBefore = await fs.readFile(chapterPath, 'utf8');
  // 只比「章节身份」这一层：打开书时主进程会按磁盘重算字数缓存（写书目），那属于正常行为，
  // 不是标记层干的；这里要钉的是「标记层一个字都不写」。
  const chapterIds = async () =>
    JSON.stringify(
      (await storage.readBookMeta(bookPath)).chapters.map((item) => ({
        id: item.id,
        file: item.file,
        name: item.name,
        volumeId: item.volumeId || null
      }))
    );
  const idsBefore = await chapterIds();

  // 65b. 打开书，三个标记开关全开（真实入口：setMarksToggle → renderEditorMarks）
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(chapterText)}`);
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', true);" +
      "window.__cwTest.setMarksToggle('longParagraphs', true);" +
      "window.__cwTest.setMarksToggle('caretParagraph', true);"
  );
  await waitFor('window.__cwTest.marksOverlayVisible() === true');
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');

  // 65c. 节点结构：40+ 行里只有「超长段 + 当前段 + 带标记」这几行是 span，其余合并成文本节点
  const structure = await exec(`(() => {
    const overlay = document.getElementById('editor-marks');
    const spans = overlay.querySelectorAll('.marks-line');
    return {
      lines: window.__cwTest.text().split('\\n').length,
      spanCount: spans.length,
      spanLines: Array.from(spans).map((el) => el.dataset.line),
      childNodes: overlay.childNodes.length,
      elementChildren: overlay.children.length,
      textLength: overlay.textContent.length
    };
  })()`);
  check(
    '标记层惰性渲染：45 行正文里只有少数几行是 span（优化前是每行一个）',
    structure.lines === 45 && structure.spanCount > 0 && structure.spanCount <= 6,
    structure
  );
  check(
    '标记层惰性渲染：整层子节点数远少于行数（干净行合并成文本节点）',
    structure.childNodes <= 12 && structure.elementChildren <= 6,
    structure
  );

  // 65d. 不变量：影子层正文逐字等于编辑区正文（去掉 ␣ / · 两个装饰字符）——换行必须一模一样
  const mirror = await exec(
    "window.__cwTest.marksText().split('\u2423').join('').split('\u00b7').join('')"
  );
  check('标记层惰性渲染：影子层正文逐字等于编辑区正文（差一个字标记就会错位）', mirror === chapterText, {
    mirrorLength: mirror.length,
    textLength: chapterText.length
  });

  // 65e. 对齐没被节点结构影响：宽高 / 字体 / 行高与编辑区一致（E2E 50 系列同一套口径）
  const metrics = await exec('window.__cwTest.marksMetrics()');
  check(
    '标记层惰性渲染：影子层与编辑区同宽同高、同字体同行高（换行一致）',
    metrics.visible &&
      Math.abs(metrics.overlayWidth - metrics.contentWidth) <= 0.5 &&
      Math.abs(metrics.overlayScrollHeight - metrics.contentHeight) <= 1 &&
      metrics.editorFontFamily === metrics.overlayFontFamily &&
      metrics.overlayLineHeight === metrics.editorLineHeight,
    metrics
  );

  // 65f. 三类标记都还在：超长段 1 行、全角空格 1 处、行尾空白 1 处
  check(
    '标记层惰性渲染：超长段落 / 全角空格 / 行尾空白三类标记照常画出来',
    (await exec('window.__cwTest.marksLongParaCount()')) === 1 &&
      (await exec('window.__cwTest.marksFullwidthCount()')) === 1 &&
      (await exec('window.__cwTest.marksTrailingCount()')) === 1,
    {
      long: await exec('window.__cwTest.marksLongParaCount()'),
      fw: await exec('window.__cwTest.marksFullwidthCount()'),
      trail: await exec('window.__cwTest.marksTrailingCount()')
    }
  );

  // 65g. 光标移到「干净行」：这一行本来没有 span，渲染层必须整层重建补上（高亮不能静默消失）
  const cleanLineIndex = 20; // 第 21 行：普通正文行，没有任何标记
  const cleanLineStart = chapterText.split('\n').slice(0, cleanLineIndex).join('\n').length + 1;
  await exec(`window.__cwTest.setCaret(${cleanLineStart + 2})`);
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  check(
    '标记层惰性渲染：光标移到干净行后高亮照常出现（整层重建补 span，行号对得上）',
    (await exec('window.__cwTest.marksCaretLine()')) === cleanLineIndex + 1,
    { expected: cleanLineIndex + 1, actual: await exec('window.__cwTest.marksCaretLine()') }
  );
  const afterCaret = await exec(`(() => {
    const overlay = document.getElementById('editor-marks');
    return {
      spanCount: overlay.querySelectorAll('.marks-line').length,
      caretSpans: overlay.querySelectorAll('.caret-para').length,
      childNodes: overlay.childNodes.length
    };
  })()`);
  check(
    '标记层惰性渲染：重建后仍然只有少数行是 span（没有退回逐行 span）',
    afterCaret.caretSpans === 1 && afterCaret.spanCount <= 6,
    afterCaret
  );

  // 65h. 同一行内继续打字：只改 class、不整层重建（行号不变 → 高亮不闪、span 数不变）
  await exec(
    `window.__cwTest.setText(${JSON.stringify(chapterText.replace('第21行：', '第21行：改一下'))})`
  );
  await waitFor('window.__cwTest.marksOverlayVisible() === true');
  const afterType = await exec(`(() => {
    const overlay = document.getElementById('editor-marks');
    return {
      caretSpans: overlay.querySelectorAll('.caret-para').length,
      spanCount: overlay.querySelectorAll('.marks-line').length,
      mirror: window.__cwTest.marksText().split('\\u2423').join('').split('\\u00b7').join('')
    };
  })()`);
  check(
    '标记层惰性渲染：改字后影子层跟着更新、当前段高亮仍在、span 数不增长',
    afterType.caretSpans === 1 &&
      afterType.spanCount <= 6 &&
      afterType.mirror === chapterText.replace('第21行：', '第21行：改一下'),
    afterType
  );
  // 把正文改回原样：onEditorInput 会把 dirty 算回 false，后面 backToShelf 才不会弹「保存吗」。
  await exec(`window.__cwTest.setText(${JSON.stringify(chapterText)})`);
  await waitFor('window.__cwTest.dirty() === false');

  // 65i. 全程只读：章节 txt 字节、章节身份都没变，也没有 _trash
  const txtAfter = await fs.readFile(chapterPath, 'utf8');
  const idsAfter = await chapterIds();
  const trashList = await fs.readdir(path.join(bookPath, '_trash')).catch(() => null);
  check(
    '标记层惰性渲染：全程只读（章节 txt 字节与章节身份都没变、不生成 _trash）',
    txtAfter === txtBefore && idsAfter === idsBefore && !trashList,
    { txtSame: txtAfter === txtBefore, idsSame: idsAfter === idsBefore, trash: trashList }
  );

  // 65j. 收尾：关掉标记、删掉演练书（走书架 _trash），书架数量回到演练前
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', false);" +
      "window.__cwTest.setMarksToggle('longParagraphs', false);" +
      "window.__cwTest.setMarksToggle('caretParagraph', false);"
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removed = await deleteBookWithRetry(bookPath);
  check(
    '标记层惰性渲染：演练书已移入书架 _trash（没有真删）',
    Boolean(removed && removed.ok === true) && removed.data.method === 'move',
    removed
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '标记层惰性渲染：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
