// 生成演示书库（截图与人工验收用），输出到 shots/demo-library。
// 用法：node scripts/demo-data.js
const path = require('node:path');
const fs = require('node:fs/promises');
const storage = require('../core/storage');

const root = path.resolve(__dirname, '..', 'shots', 'demo-library');

async function makeBook(title, chapters) {
  const created = await storage.createBook(root, title);
  const bookPath = created.path;
  const first = created.meta.chapters[0];
  await storage.renameChapter(bookPath, first.id, chapters[0].name);
  await storage.saveChapterText(bookPath, first.file, chapters[0].text);
  for (let i = 1; i < chapters.length; i += 1) {
    const added = await storage.createChapter(bookPath, i, chapters[i].name);
    await storage.saveChapterText(bookPath, added.chapter.file, chapters[i].text);
  }
  const meta = await storage.readBookMeta(bookPath);
  await storage.setLastOpenChapter(bookPath, meta.chapters[0].id);
  return bookPath;
}

(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  const starPath = await makeBook('星海旅人', [
    {
      name: '起风',
      text: [
        '风从海面吹来，带着咸味和一点铁锈的气息。',
        '',
        '他把最后一只箱子搬上甲板，回头看见码头上的灯还亮着。三年了，他终于要离开这座岛。'
      ].join('\n')
    },
    {
      name: '夜雨',
      text: [
        '雨下了一整夜。',
        '',
        '他站在窗前，看见远处的灯塔在雨幕里一明一暗，像谁在黑暗里眨眼。'
      ].join('\n')
    },
    {
      name: '灯塔',
      text: [
        '灯塔的看守人姓陈，五十多岁，说话很慢。',
        '',
        '“你也是来找人的？”他问。',
        '',
        '我没有回答。'
      ].join('\n')
    }
  ]);

  await makeBook('另一本草稿', [
    { name: '开场', text: '雪落在长安城的屋檐上。\n\n没有风，也没有人。' },
    { name: '旧事', text: '她记得那年的灯会。' }
  ]);

  console.log(JSON.stringify({ root, starPath }, null, 2));
  const books = await storage.listBooks(root);
  console.log(JSON.stringify(books.map((b) => ({ title: b.title, chapters: b.chapterCount, chars: b.totalChars, status: b.status }))));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
