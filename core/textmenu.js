// 可编辑区域（正文 textarea、章节名 / 书名 / 书架搜索 / 查找替换输入框）的右键菜单。
// 只出「剪切 / 复制 / 粘贴 / 全选」四项；可用状态直接沿用 Electron context-menu 给的 editFlags，
// 没有选中文字时「剪切 / 复制」是灰的，剪贴板里没有文本时「粘贴」是灰的。
// 注意：章节列表 / 书架卡片有自己的 HTML 右键菜单（renderer 里），这里只认可编辑元素，不掺和。

const EDIT_ITEMS = [
  { role: 'cut', label: '剪切', flag: 'canCut' },
  { role: 'copy', label: '复制', flag: 'canCopy' },
  { role: 'paste', label: '粘贴', flag: 'canPaste' }
];

// 只对「可以填入文字的地方」出菜单
function shouldShow(params) {
  return Boolean(params && params.isEditable);
}

// 返回给 Menu.buildFromTemplate 的模板（纯数据，方便单测；不依赖 electron）
function buildTemplate(params) {
  const flags = (params && params.editFlags) || {};
  const template = EDIT_ITEMS.map(({ role, label, flag }) => ({
    role,
    label,
    enabled: Boolean(flags[flag])
  }));
  template.push({ type: 'separator' });
  // 可编辑区域里「全选」永远可用
  template.push({ role: 'selectAll', label: '全选', enabled: true });
  return template;
}

module.exports = { shouldShow, buildTemplate };
