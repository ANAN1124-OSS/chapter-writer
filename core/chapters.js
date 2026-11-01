/* 章节相关的纯逻辑：编号、标题、文件名净化、顺序增删、章节状态 / 备注、分卷。
 * 这里不碰磁盘，全部可单测。
 *
 * 同时被 Node（main.js / core/*、单测）和渲染层（index.html 里 <script>）使用，
 * 所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWChapters。
 * 渲染层只通过 formatTitle() 取章节显示名，不再自己拼「第N章：」（v0.8.6 R3，代码审计 F6）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWChapters = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_TEMPLATE = '第{num}章：{name}';
  const MAX_NAME_LENGTH = 40;
  const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
  const EDGE_DOTS_SPACES = /^[.\s]+|[.\s]+$/g;
  // 章节状态：只记在 书目.json 里（可选字段），txt 一个字节都不动。
  // draft = 草稿（默认）/ revising = 待修 / done = 完稿
  const CHAPTER_STATUSES = ['draft', 'revising', 'done'];
  const CHAPTER_STATUS_LABELS = { draft: '草稿', revising: '待修', done: '完稿' };
  const DEFAULT_CHAPTER_STATUS = 'draft';
  const MAX_NOTE_LENGTH = 200;
  // 原文自带章节标题（导进来的书）：显示时原样保留，不再叠加「第N章：」
  const RAW_TITLE_RE =
    /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷集篇部话幕]|楔子|序章|序言|引子|前言|前传|外传|尾声|后记|番外|终章|大结局|附录|开篇|Chapter\s+\d+)/i;

  function pad3(n) {
    return String(n).padStart(3, '0');
  }

  function formatTitle(meta, index, name) {
    const template =
      meta && typeof meta.titleTemplate === 'string' && meta.titleTemplate.trim()
        ? meta.titleTemplate
        : TITLE_TEMPLATE;
    const number = String(index + 1);
    const clean = String(name == null ? '' : name).trim();
    // 原文自带的章节标题（如「第1章 关于本作品」）原样显示，避免「第1章：第1章 …」重复
    if (clean && RAW_TITLE_RE.test(clean)) return clean;
    // 没有名字的章节：显示「第N章」，不再显示「第N章：未命名」
    if (!clean) return `第${number}章`;
    return template.split('{num}').join(number).split('{name}').join(clean);
  }

  function safeName(raw) {
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(ILLEGAL_CHARS, '').replace(EDGE_DOTS_SPACES, '');
    if (!s) s = '未命名';
    if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(EDGE_DOTS_SPACES, '');
    return s || '未命名';
  }

  function buildFileName(seq, name) {
    return `${pad3(seq)}-${safeName(name)}.txt`;
  }

  function uniqueFileName(seq, name, existingFiles = []) {
    const used = new Set(existingFiles);
    let candidate = buildFileName(seq, name);
    let i = 2;
    while (used.has(candidate)) {
      candidate = buildFileName(seq, `${safeName(name)}-${i}`);
      i += 1;
    }
    return candidate;
  }

  function nextFileSeq(meta) {
    const n = Number(meta && meta.fileSeq);
    if (!Number.isFinite(n) || n < 0) return 1;
    return Math.floor(n) + 1;
  }

  function findChapterIndex(meta, chapterId) {
    if (!meta || !Array.isArray(meta.chapters)) return -1;
    return meta.chapters.findIndex((c) => c && c.id === chapterId);
  }

  function insertChapter(meta, insertIndex, chapter) {
    const list = Array.isArray(meta.chapters) ? meta.chapters.slice() : [];
    const rawIndex = Number(insertIndex);
    const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(Math.floor(rawIndex), list.length)) : list.length;
    list.splice(index, 0, chapter);
    return { ...meta, chapters: list };
  }

  function removeChapter(meta, chapterId) {
    const list = (meta.chapters || []).filter((c) => c.id !== chapterId);
    return { ...meta, chapters: list };
  }

  function updateChapter(meta, chapterId, patch) {
    return {
      ...meta,
      chapters: (meta.chapters || []).map((c) => (c.id === chapterId ? { ...c, ...patch } : c))
    };
  }

  // ---------- 章节状态 / 备注（可选字段，只影响书目） ----------
  function isChapterStatus(raw) {
    return typeof raw === 'string' && CHAPTER_STATUSES.includes(raw.trim().toLowerCase());
  }

  function sanitizeChapterStatus(raw) {
    return isChapterStatus(raw) ? raw.trim().toLowerCase() : DEFAULT_CHAPTER_STATUS;
  }

  // 备注当成一句话：换行收成空格、去首尾空白、最多 200 字；清空 = 删除备注
  function sanitizeChapterNote(raw) {
    if (typeof raw !== 'string') return '';
    const oneLine = raw.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').trim();
    return oneLine.length > MAX_NOTE_LENGTH ? oneLine.slice(0, MAX_NOTE_LENGTH) : oneLine;
  }

  function chapterStatus(chapter) {
    return sanitizeChapterStatus(chapter && chapter.status);
  }

  function chapterNote(chapter) {
    return sanitizeChapterNote(chapter && chapter.note);
  }

  // 读取时清洗：合法 status 保留（统一小写），非法/缺失就不写这个字段；
  // 空备注同样不保留字段 —— 旧版书目读进来不会平白多出字段，写回时也不会带脏值。
  function cleanChapterMeta(chapter) {
    const next = { ...chapter };
    if (isChapterStatus(chapter && chapter.status)) {
      next.status = String(chapter.status).trim().toLowerCase();
    } else {
      delete next.status;
    }
    const note = sanitizeChapterNote(chapter && chapter.note);
    if (note) next.note = note;
    else delete next.note;
    return next;
  }

  // 只接受白名单字段（status/note）；空备注删除该字段，草稿状态显式保留
  function applyChapterMeta(chapter, patch) {
    const next = { ...chapter };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
      next.status = sanitizeChapterStatus(patch.status);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'note')) {
      const note = sanitizeChapterNote(patch.note);
      if (note) next.note = note;
      else delete next.note;
    }
    return next;
  }

  function countChapterStatuses(meta) {
    const counts = { total: 0, draft: 0, revising: 0, done: 0 };
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    for (const chapter of list) {
      counts.total += 1;
      counts[chapterStatus(chapter)] += 1;
    }
    return counts;
  }

  function countChars(text) {
    return String(text == null ? '' : text).replace(/\s/g, '').length;
  }

  // ---------- 分卷 ----------
  // 书的分卷：meta.volumes = [{ id, name }]（数组顺序 = 显示顺序），章节上的 volumeId 指向卷；
  // 没有 volumeId（或指向已不存在的卷）= 「未分卷」。
  // 顺序约定：chapters 数组顺序 == 界面显示顺序，且必须按「未分卷 → 第1卷 → 第2卷 …」分组连续排列；
  // 任何改卷归属的操作之后都用 normalizeChapterOrder() 归一（稳定排序，组内相对顺序不变）。

  function sanitizeVolumes(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      out.push({ id, name });
    }
    return out;
  }

  // 卷在排序里的权重：0 = 未分卷，1..n = 第1..n卷；找不到的卷也算未分卷
  function volumeRank(meta, volumeId) {
    if (!volumeId) return 0;
    const index = sanitizeVolumes(meta && meta.volumes).findIndex((v) => v.id === volumeId);
    return index < 0 ? 0 : index + 1;
  }

  function normalizeChapterOrder(meta) {
    const volumes = sanitizeVolumes(meta && meta.volumes);
    const rank = new Map(volumes.map((v, i) => [v.id, i + 1]));
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters.slice() : [];
    // 卷没了 / 卷 id 不认识的章节一律回「未分卷」，避免界面里出现指向不存在卷的章
    const decorated = list.map((chapter, index) => {
      const volumeId = chapter && chapter.volumeId && rank.has(chapter.volumeId) ? chapter.volumeId : null;
      const next = volumeId === (chapter && chapter.volumeId) ? chapter : { ...chapter, volumeId };
      return { chapter: next, index, r: rank.get(volumeId) || 0 };
    });
    decorated.sort((a, b) => (a.r - b.r) || (a.index - b.index));
    return { ...meta, volumes, chapters: decorated.map((d) => d.chapter) };
  }

  function nextVolumeId(meta) {
    const ids = new Set(sanitizeVolumes(meta && meta.volumes).map((v) => v.id));
    let i = 1;
    for (;;) {
      const id = `v_${pad3(i)}`;
      if (!ids.has(id)) return id;
      i += 1;
    }
  }

  // 某卷里最后一章的数组下标之后（没有章节就返回该组插入点）
  function insertIndexForVolume(meta, volumeId) {
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    const target = volumeId || null;
    let last = -1;
    for (let i = 0; i < list.length; i += 1) {
      const id = (list[i] && list[i].volumeId) || null;
      if (id === target) last = i;
    }
    if (last >= 0) return last + 1;
    // 卷里还没有章节：插到该卷分组应该开始的位置（下一个卷的第一章之前，或全书末尾）
    const rank = volumeRank(meta, target);
    for (let i = 0; i < list.length; i += 1) {
      const id = (list[i] && list[i].volumeId) || null;
      if (volumeRank(meta, id) > rank) return i;
    }
    return list.length;
  }

  function countChaptersInVolume(meta, volumeId) {
    const target = volumeId || null;
    return (Array.isArray(meta && meta.chapters) ? meta.chapters : []).filter(
      (c) => ((c && c.volumeId) || null) === target
    ).length;
  }

  // 调整卷的先后顺序（只改 volumes 数组顺序，章节按新卷序重新归一；章节文件不动）
  function moveVolume(meta, volumeId, toIndex) {
    const volumes = sanitizeVolumes(meta && meta.volumes).slice();
    const from = volumes.findIndex((v) => v.id === volumeId);
    const total = volumes.length;
    const to = Math.max(0, Math.min(Math.round(Number(toIndex) || 0), total - 1));
    if (from < 0 || from === to) {
      return { meta: normalizeChapterOrder({ ...meta, volumes }), moved: false, from, to: from };
    }
    const [moved] = volumes.splice(from, 1);
    volumes.splice(to, 0, moved);
    return { meta: normalizeChapterOrder({ ...meta, volumes }), moved: true, from, to };
  }



  function normalizeNewlines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  function toDiskNewlines(text) {
    return normalizeNewlines(text).replace(/\n/g, '\r\n');
  }


  return {
    TITLE_TEMPLATE,
    MAX_NAME_LENGTH,
    RAW_TITLE_RE,
    CHAPTER_STATUSES,
    CHAPTER_STATUS_LABELS,
    DEFAULT_CHAPTER_STATUS,
    MAX_NOTE_LENGTH,
    pad3,
    formatTitle,
    safeName,
    buildFileName,
    uniqueFileName,
    nextFileSeq,
    findChapterIndex,
    insertChapter,
    removeChapter,
    updateChapter,
    isChapterStatus,
    sanitizeChapterStatus,
    sanitizeChapterNote,
    chapterStatus,
    chapterNote,
    cleanChapterMeta,
    applyChapterMeta,
    countChapterStatuses,
    sanitizeVolumes,
    volumeRank,
    normalizeChapterOrder,
    nextVolumeId,
    insertIndexForVolume,
    countChaptersInVolume,
    moveVolume,
    countChars,
    normalizeNewlines,
    toDiskNewlines
  };
});
