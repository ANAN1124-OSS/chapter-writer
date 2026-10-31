const test = require('node:test');
const assert = require('node:assert/strict');
const textMenu = require('../core/textmenu');

function paramsOf(overrides = {}) {
  return {
    isEditable: true,
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false
    },
    ...overrides
  };
}

test('右键菜单：只在可编辑的地方出现', () => {
  assert.equal(textMenu.shouldShow(paramsOf()), true);
  assert.equal(textMenu.shouldShow(paramsOf({ isEditable: false })), false);
  assert.equal(textMenu.shouldShow(null), false);
  assert.equal(textMenu.shouldShow(undefined), false);
});

test('右键菜单：四项 + 一条分隔线，中文标签', () => {
  const template = textMenu.buildTemplate(paramsOf());
  assert.equal(template.length, 5);
  assert.deepEqual(
    template.map((item) => item.label),
    ['剪切', '复制', '粘贴', undefined, '全选']
  );
  assert.deepEqual(
    template.map((item) => item.role),
    ['cut', 'copy', 'paste', undefined, 'selectAll']
  );
  assert.equal(template[3].type, 'separator');
});

test('右键菜单：没选中文字时剪切/复制是灰的', () => {
  const template = textMenu.buildTemplate(
    paramsOf({ editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } })
  );
  assert.equal(template[0].enabled, false);
  assert.equal(template[1].enabled, false);
  assert.equal(template[2].enabled, true);
});

test('右键菜单：剪贴板里没有文本时粘贴是灰的', () => {
  const template = textMenu.buildTemplate(
    paramsOf({ editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true } })
  );
  assert.equal(template[2].enabled, false);
});

test('右键菜单：全选始终可用（编辑区里永远能全选）', () => {
  const template = textMenu.buildTemplate(paramsOf({ editFlags: {} }));
  assert.equal(template[4].enabled, true);
});

test('右键菜单：editFlags 缺失时不至于抛错（各项按不可用处理）', () => {
  const template = textMenu.buildTemplate({ isEditable: true });
  assert.equal(template[0].enabled, false);
  assert.equal(template[2].enabled, false);
  assert.equal(template[4].enabled, true);
});
