/* 码字日历的纯逻辑（v0.9 B-6：从 renderer.js 按域拆出来）——不碰 DOM、不读盘、不依赖 Electron。
 *
 * 改前这些算法全长在 renderer.js 的 renderStatsCalendar / shiftStatsCalendar 里，只能靠 E2E 的
 * 44h 组顺带覆盖；拆出来以后 Node 单测能直接钉边界（跨年翻月、不翻到未来、月首空格、色阶 class、
 * 汇总文案），渲染层只剩「建 DOM」这一步。
 *
 * 范围（只搬码字日历这一域，不改任何显示结果）：
 *   - 月份游标：当前年月、比较、翻月（跨年）、从日历视图恢复游标；
 *   - 翻月边界：不翻到未来（含本月）、不低于 1970-01、delta 为 0 / 非数字返回 null；
 *   - 日历网格计划：月首空格数、每天格子的 class / 悬停提示 / dataset、月尾补空格到整周；
 *   - 文案：连续写作天数、月度汇总、书架上的「今天 +N 字」。
 *
 * 字数 / 时长的格式化口径只有渲染层一份（formatChars / formatDuration），本模块**不复制第二套**：
 * 需要格式化的函数都由调用方把 fmt = { formatChars, formatDuration } 传进来，缺了直接报错。
 * 这样「码字日历说 1.20 万字、书架说 12000 字」这类两套口径的分叉从结构上就不会出现。
 *
 * 浏览器里挂成全局 CWStatsLogic（index.html 排在 renderer.js 之前），Node 里可以直接加载。
 * 红线：不读盘、不写盘、不联网、不缓存状态。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWStatsLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 周一开头（与主进程 core/stats.js 的月视图一致）；主进程没给 weekdayLabels 时用这一份兜底。
  const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
  // 翻月下限：再往前没有码字记录，也不该出现 1970 之前的年份。
  const MIN_YEAR = 1970;
  // 一天格子写到 DOM 上的 dataset 键（E2E 的 calendarDayInfo 读的就是这几个）。
  const CELL_DATASET_KEYS = ['day', 'chars', 'seconds', 'level', 'goalMet'];

  // 日期既可以是 Date，也可以不传（= 现在）。不用 instanceof：跨 realm（node:vm 沙箱）的
  // Date 过不了 instanceof，会把「传了日期」当成「没传」（v0.9 B-3 踩过）。
  function resolveDate(now) {
    return now && typeof now.getFullYear === 'function' ? now : new Date();
  }

  function currentYearMonth(now) {
    const date = resolveDate(now);
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }

  function compareYearMonth(a, b) {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  }

  // 翻 delta 个月（负数往前）；跨年由 Date 自己算（12 月 + 1 → 次年 1 月）。
  function shiftYearMonth(cursor, delta) {
    const date = new Date(cursor.year, cursor.month - 1 + Math.trunc(delta), 1, 12, 0, 0, 0);
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }

  // 日历视图里的游标：主进程回报的 year / month 是整数就用它（翻月后停在那个月），
  // 旧 stats.json / 字段缺失时退回本月。
  function calendarCursor(view, now) {
    if (view && Number.isInteger(view.year) && Number.isInteger(view.month)) {
      return { year: view.year, month: view.month };
    }
    return currentYearMonth(now);
  }

  // 翻月前的边界判断：不翻到未来（含本月，未来月份没有记录）、不低于 1970-01。
  // 返回翻页后的 { year, month }；不该翻（delta 为 0 / 非数字 / 越界）返回 null。
  function shiftCalendarCursor(cursor, delta, now) {
    const step = Math.trunc(Number(delta));
    if (!Number.isFinite(step) || step === 0) return null;
    const next = shiftYearMonth(cursor, step);
    if (compareYearMonth(next, currentYearMonth(now)) > 0) return null;
    if (next.year < MIN_YEAR) return null;
    return next;
  }

  // 「上一月 / 下一月 / 本月」三个按钮的禁用状态：停在 1970-01 不能再往前，
  // 停在本月时「下一月」与「本月」都没意义。view 为空时三个都禁用（还没有统计数据）。
  function calendarButtons(view, now) {
    if (!view) return { prevDisabled: true, nextDisabled: true, todayDisabled: true };
    const current = currentYearMonth(now);
    const isCurrent = view.year === current.year && view.month === current.month;
    return {
      prevDisabled: view.year <= MIN_YEAR && view.month <= 1,
      nextDisabled: isCurrent,
      todayDisabled: isCurrent
    };
  }

  // 星期表头：主进程给的是 7 个就用它，否则用内置的「一…日」。返回副本，调用方改不到常量。
  function weekdayLabels(view) {
    const labels =
      view && Array.isArray(view.weekdayLabels) && view.weekdayLabels.length === 7
        ? view.weekdayLabels
        : null;
    return (labels || WEEKDAY_LABELS).slice();
  }

  // 连续写作天数：还没记录 / 断了 / 正在连续三种说法（与 v0.8-1 的文案逐字一致）。
  function calendarStreakLabel(streak) {
    const current = Math.max(0, Math.round(Number(streak && streak.current) || 0));
    const best = Math.max(0, Math.round(Number(streak && streak.best) || 0));
    if (best <= 0) return '还没有写作记录';
    if (current > 0) return `已连续写作 ${current} 天 · 最长 ${best} 天`;
    return `连续写作中断 · 最长 ${best} 天`;
  }

  // 格式化口径由调用方传入：缺了就报错，不悄悄退回另一套数字格式。
  function formatters(fmt) {
    const source = fmt || {};
    if (typeof source.formatChars !== 'function' || typeof source.formatDuration !== 'function') {
      throw new TypeError('CWStatsLogic：需要传入 { formatChars, formatDuration }');
    }
    return source;
  }

  // 月度汇总：本月 / 哪天最高 / 达标几天 / 用时；没有记录时给一句更直白的提示。
  function calendarSummaryText(view, fmt) {
    if (!view) return '';
    const { formatChars, formatDuration } = formatters(fmt);
    const durationText = view.totalSeconds > 0 ? ` · 用时 ${formatDuration(view.totalSeconds)}` : '';
    if (!view.writtenDays) {
      const base = view.isCurrentMonth ? '本月还没有保存记录（保存一次后开始记录）' : '这个月没有保存记录';
      return view.totalSeconds > 0 ? `${base}（计时 ${formatDuration(view.totalSeconds)}）` : base;
    }
    const goalText = view.goal > 0 ? ` · 达标 ${view.goalDays} 天` : '';
    const bestText = view.bestDay
      ? ` · 最高 ${view.bestDay.day.slice(5)}（${formatChars(view.bestDay.chars)}）`
      : '';
    const prefix = view.isCurrentMonth ? '本月' : `${view.month}月`;
    return `${prefix} ${formatChars(view.total)} · 写了 ${view.writtenDays} 天 · 日均 ${formatChars(view.average)}${goalText}${bestText}${durationText}`;
  }

  // 书架顶部的「今天 +N 字」；没写字时说一句，不显示 +0。
  function statsTodayText(stats, fmt) {
    const { formatChars } = formatters(fmt);
    const today = Math.max(0, Math.round(Number(stats && stats.todayChars) || 0));
    return today > 0 ? `今天 +${formatChars(today)}` : '今天还没写字';
  }

  // 一天格子的 class：base + written（带色阶 lvN）+ goal-met / today / future。
  // 与拆之前逐个 class 加进去的顺序一致（CSS 不依赖顺序，但 DOM 上的字符串看起来一样）。
  function cellClassName(day) {
    let name = 'cal-day';
    if (day.written) name += ` written lv${day.level}`;
    if (day.goalMet) name += ' goal-met';
    if (day.today) name += ' today';
    if (day.future) name += ' future';
    return name;
  }

  // 一天格子的悬停提示：字数 / 用时 / 达标 / 今天 / 还没到。
  function cellTitle(day, fmt) {
    const { formatChars, formatDuration } = formatters(fmt);
    return (
      `${day.day} · ${day.chars > 0 ? formatChars(day.chars) : '没写'}` +
      (day.seconds > 0 ? ` · 用时 ${formatDuration(day.seconds)}` : '') +
      (day.goalMet ? ' · 已达标' : '') +
      (day.today ? ' · 今天' : '') +
      (day.future ? ' · 还没到' : '')
    );
  }

  // 日历网格计划：月首空格 + 每天格子 + 月尾补空格，凑成整周（7 列）。
  // 渲染层只按计划建 DOM，不再自己算空格 / class / dataset。
  function calendarCells(view, fmt) {
    formatters(fmt); // 先校验，别等到算到一半才炸
    const days = view && Array.isArray(view.days) ? view.days : [];
    const rawFirst = Number(view && view.firstWeekday);
    // 主进程给的是 0–6；坏值夹紧才不会算出 NaN 把尾部空格吞掉。
    const firstWeekday = Number.isFinite(rawFirst) ? Math.max(0, Math.min(6, Math.trunc(rawFirst))) : 0;
    const cells = days.map((raw) => {
      const day = raw || {};
      return {
        // span 里的日号（1…31）
        dayOfMonth: String(day.dayOfMonth),
        className: cellClassName(day),
        title: cellTitle(day, fmt),
        // dataset 值一律是字符串（DOM 的 dataset 也只收字符串）
        dataset: {
          day: String(day.day),
          chars: String(day.chars),
          seconds: String(day.seconds || 0),
          level: String(day.level),
          goalMet: day.goalMet ? '1' : '0'
        }
      };
    });
    const filled = firstWeekday + cells.length;
    const blanksAfter = (7 - (filled % 7)) % 7;
    return { blanksBefore: firstWeekday, cells, blanksAfter };
  }

  return {
    WEEKDAY_LABELS,
    MIN_YEAR,
    CELL_DATASET_KEYS,
    currentYearMonth,
    compareYearMonth,
    shiftYearMonth,
    calendarCursor,
    shiftCalendarCursor,
    calendarButtons,
    weekdayLabels,
    calendarStreakLabel,
    calendarSummaryText,
    statsTodayText,
    calendarCells
  };
});
