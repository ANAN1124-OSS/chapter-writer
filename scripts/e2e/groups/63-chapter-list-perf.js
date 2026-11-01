// E2E 第 63 组：大书章节栏渲染（v0.9 A-2，前端 / 大数据量体验 A2）。
//
// 这一组钉住两件「只改显示层」的优化，行为必须和优化前一致：
//   1. `.chapter-item` 上的 content-visibility: auto（屏幕外条目跳过布局）——
//      条目仍在 DOM 里、仍有接近真实行高的尺寸，当前章滚动进可视区。
//   2. 切章只挪「当前章」高亮、不整表重建（syncActiveChapterItem）——
//      用「在条目上打标记、切完标记还在」证明 DOM 没被重建；而新建 / 删除章节这种
//      会改 state.chapters 的入口必须认得失配、退回整表重建（条目数 / 当前章都对）。
//
// 自足：本组自己造一本 40 章的书、自己收尾删掉（走书架 _trash），不污染后面的多窗口组。

module.exports = async function group63ChapterListPerf(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  // 63a. 造演练书：直接走 storage（和真实书同一个格式），40 章足够让列表滚起来
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  const created = await storage.createBook(booksRoot, '章节栏渲染演练');
  const bookPath = created.path;
  for (let i = 1; i < 40; i += 1) {
    await storage.createChapter(bookPath, i, `第${i + 1}章 演练`);
  }
  const meta = await storage.readBookMeta(bookPath);
  check('章节栏渲染：演练书造好 40 章', meta.chapters.length === 40, meta.chapters.length);

  // 63b. 打开：条目数、屏幕外条目的 content-visibility / intrinsic 尺寸、真实行高
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 40");
  const c63Layout = await exec(`(() => {
    const list = document.getElementById('chapter-list');
    const items = list.querySelectorAll('.chapter-item');
    const first = items[0];
    const cs = getComputedStyle(first);
    const active = list.querySelector('.chapter-item.active');
    return {
      count: items.length,
      contentVisibility: cs.contentVisibility,
      containIntrinsicSize: cs.containIntrinsicSize,
      firstHeight: first.offsetHeight,
      activeIndex: active ? active.dataset.index : null,
      firstIndex: first.dataset.index,
      activeChapterId: active ? active.dataset.chapterId : null
    };
  })()`);
  check(
    '章节栏渲染：40 条都在 DOM 里，屏幕外条目用 content-visibility 跳过渲染但保留尺寸',
    c63Layout.count === 40 &&
      c63Layout.contentVisibility === 'auto' &&
      /38px/.test(String(c63Layout.containIntrinsicSize)),
    c63Layout
  );
  check(
    '章节栏渲染：intrinsic 尺寸和真实行高一致（20–80px，否则滚动条 / 拖动落点会漂）',
    Number(c63Layout.firstHeight) >= 20 && Number(c63Layout.firstHeight) <= 80,
    { firstHeight: c63Layout.firstHeight }
  );
  check(
    '章节栏渲染：打开书时当前章有高亮，且条目带 data-chapter-id',
    c63Layout.activeIndex === String(0) && c63Layout.activeChapterId === meta.chapters[0].id,
    { activeIndex: c63Layout.activeIndex, activeChapterId: c63Layout.activeChapterId }
  );

  // 63c. 切到最后一章（屏幕外）：只挪高亮，DOM 不重建；当前章滚进可视区
  const c63Fast = await exec(`(async () => {
    const list = document.getElementById('chapter-list');
    Array.from(list.querySelectorAll('.chapter-item')).forEach((item) => {
      item.dataset.c63Keep = '1';
    });
    await window.__cwTest.switchTo(39, 'discard');
    const active = list.querySelectorAll('.chapter-item.active');
    const listRect = list.getBoundingClientRect();
    const activeRect = active[0].getBoundingClientRect();
    return {
      kept: list.querySelectorAll('.chapter-item[data-c63-keep="1"]').length,
      count: list.querySelectorAll('.chapter-item').length,
      activeCount: active.length,
      activeIndex: active[0].dataset.index,
      activeChapterId: active[0].dataset.chapterId,
      inView: activeRect.top >= listRect.top - 1 && activeRect.bottom <= listRect.bottom + 1,
      scrollTop: list.scrollTop,
      title: document.getElementById('chapter-title').textContent
    };
  })()`);
  check(
    '章节栏渲染：切章只挪当前章高亮（40 条 DOM 一个都没重建），旧条目不再 active',
    c63Fast.kept === 40 &&
      c63Fast.count === 40 &&
      c63Fast.activeCount === 1 &&
      c63Fast.activeIndex === '39' &&
      c63Fast.activeChapterId === meta.chapters[39].id,
    c63Fast
  );
  check(
    '章节栏渲染：切到列表末尾的章后，当前章滚进可视区、标题同步',
    c63Fast.inView === true && c63Fast.scrollTop > 0 && String(c63Fast.title).includes('第40章'),
    { inView: c63Fast.inView, scrollTop: c63Fast.scrollTop, title: c63Fast.title }
  );

  // 63d. 新建章节（会改 state.chapters）：必须退回整表重建，新条目出现、旧标记清掉
  await exec(`window.__cwTest.newChapter('尾部新章')`);
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 41");
  const c63New = await exec(`(() => {
    const list = document.getElementById('chapter-list');
    const active = list.querySelectorAll('.chapter-item.active');
    return {
      count: list.querySelectorAll('.chapter-item').length,
      rebuilt: list.querySelectorAll('.chapter-item[data-c63-keep="1"]').length,
      activeCount: active.length,
      activeIndex: active[0].dataset.index,
      title: document.getElementById('chapter-title').textContent
    };
  })()`);
  check(
    '章节栏渲染：新建章节后列表整表重建（41 条、旧标记清掉、新章是当前章）',
    c63New.count === 41 &&
      c63New.rebuilt === 0 &&
      c63New.activeCount === 1 &&
      c63New.activeIndex === '40' &&
      String(c63New.title).includes('尾部新章'),
    c63New
  );

  // 63e. 删除当前章（章号 / 章节 id 都会变）：退回整表重建，当前章落到正确的那一条
  await exec('window.__cwTest.deleteChapterAt(40, { skipConfirm: true })');
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 40");
  const c63AfterDeleteMeta = await storage.readBookMeta(bookPath);
  const c63Deleted = await exec(`(() => {
    const list = document.getElementById('chapter-list');
    const active = list.querySelectorAll('.chapter-item.active');
    return {
      count: list.querySelectorAll('.chapter-item').length,
      activeCount: active.length,
      activeIndex: active[0].dataset.index,
      activeChapterId: active[0].dataset.chapterId
    };
  })()`);
  check(
    '章节栏渲染：删除当前章后列表重建、当前章落到正确条目（章号与章节 id 都对）',
    c63Deleted.count === 40 &&
      c63Deleted.activeCount === 1 &&
      c63Deleted.activeIndex === '39' &&
      c63Deleted.activeChapterId === c63AfterDeleteMeta.chapters[39].id,
    { dom: c63Deleted, expectedId: c63AfterDeleteMeta.chapters[39].id }
  );

  // 63f. 收尾：删掉演练书（走书架 _trash 兜底），书架数量回到演练前
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c63Removed = await deleteBookWithRetry(bookPath);
  check(
    '章节栏渲染：演练书已移入书架 _trash（没有真删）',
    Boolean(c63Removed && c63Removed.ok === true) && c63Removed.data.method === 'move',
    c63Removed
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '章节栏渲染：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
