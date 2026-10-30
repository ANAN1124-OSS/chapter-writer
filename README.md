# 章节写作器 v0.1

给写个人自用的 Windows 桌面写作工具：**整本书一键保存、绝不丢稿**；新建章节自动生成「第12章：」这样的标题，你只填名字。

技术形态：Electron + 原生 HTML/CSS/JS，v0.1 不打包 exe，命令行启动窗口。

---

## ⚠️ 先看这三条（本版是「完全手动保存」）

1. **没有自动保存**：只有按 `Ctrl+S` 或点「保存」按钮时，正文才写进磁盘。
2. **没有每日备份**：应用不备份任何东西。**改坏了、崩溃了、关机了，靠的是你自己拷的副本。**
3. 切章节、关窗口、导出之前，如果当前章有未保存修改，应用会弹窗让你选「保存 / 不保存 / 取消」，**不会静默丢失，也不会偷偷替你保存**。

> 强烈建议：把书架目录（默认 `文档\我的小说`）放进 OneDrive / 坚果云等同步盘，或打开 Windows 的「文件历史记录」。
> 这样即使不用应用内备份，也能免费拿到每日版本历史。

---

## 环境要求

- Windows 11（Windows 10 1809+ 也可）
- Node.js ≥ 22（开发机实测 v24.22.1）
- pnpm ≥ 10（实测 12.11.2）

## 安装与启动

```bash
cd D:\code\chapter-writer
pnpm install        # 第一次会下载 Electron（约 100MB，走 npmmirror 镜像）
pnpm start          # 启动应用
```

> **如果 `pnpm start` 报「无法加载文件 …pnpm.ps1，因为在此系统上禁止运行脚本」**
>
> 这是 Windows PowerShell 5.1 的默认执行策略（Restricted）拦住了 pnpm 的 `.ps1` 垫片，不是项目的问题。
> 任选一种即可：
>
> 1. **双击项目根目录的 `启动写作器.cmd`**（最省事，不用记命令）；
> 2. 在当前 PowerShell 里改用 **`pnpm.cmd start`**（走 `.cmd` 垫片，不受脚本策略限制）；
> 3. 一次性放开当前用户策略（无需管理员）：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，之后 `pnpm start` 就能用；想改回去：`Set-ExecutionPolicy -Scope CurrentUser Undefined`。
>
> 用 PowerShell 7（`pwsh`）打开终端也可以直接用 `pnpm start`。

说明：

- `.npmrc` 已配置 `electron_mirror=https://npmmirror.com/mirrors/electron/`，避免卡 GitHub。
- 某些宿主环境（例如某些 AI 工具、CI）会带 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node 而启动失败。
  `pnpm start` 实际执行的是 `scripts/start.js`，它会自动清掉这个环境变量再启动。
- 数据目录不在项目里：默认 `文档\我的小说`，可在应用「设置」里改。

## 数据在哪

```
文档\我的小说\                     ← 书架目录（可在设置里改）
├─ _trash\                       ← 回收站不可用时，删除的整本书移到这里（可人工找回）
├─ 星海旅人\                     ← 一本书 = 一个文件夹
│  ├─ 书目.json                  ← 书名、章节顺序、章名（唯一事实来源）
│  ├─ 书目.json.bak              ← 上一次写入前的版本（json 写坏时用）
│  ├─ 001-未命名.txt             ← 创建序号 + 名字，文件名永不修改
│  ├─ 002-夜雨.txt
│  ├─ 003-未命名.txt
│  └─ _trash\                    ← 删除的章节移到这里，不真删
└─ 另一本草稿\
```

应用配置单独存放在 `%APPDATA%\chapter-writer\config.json`（书架目录、窗口位置、字体、字号）。

关键规则：

- **章节显示名 = 「第N章：名字」，N 由章节顺序现算，不写死**。插入/删除后章号自动重排。
- **插入章节只改 `书目.json` 记录，不重命名任何文件**。所以文件名前缀是「创建序号」，不需要和显示章号一致。
- 章节 txt 里只有正文：UTF-8 无 BOM、`\r\n` 换行，记事本直接打开不乱码。
- 改名（书名、章名）只改 json，文件夹名/文件名都不动。

## 怎么用

| 操作 | 方式 |
|---|---|
| 新建书 | 书架 →「＋ 新建一本书」 |
| 导入小说 | 书架右上「导入小说」，选一个或多个文件夹，自动识别三种来源：① 现成的章节写作器书（含 `书目.json`）整本复制；② 一本书的章节目录（txt 名如 `001-xxx.txt` / `第一章 xxx.txt`）合成一本书；③ **一堆独立小说 txt（如 `小说txt文件夹` 那种收藏夹，每个 txt 是一整本小说）→ 每个 txt 导成一本书，并按「第X章 / 楔子 / Chapter N」自动分章**。自动识别 UTF-8 / UTF-16 / GBK 编码；只复制不移动源文件；重名自动加 `-2`；大批量导入会显示进度 |
| 删除小说 | 鼠标移到书卡右上角「⋯」→「删除这本书…」，或右键书卡 → 删除。整本书移到 Windows 回收站（回收站不可用时移到书架 `_trash`），不会真删 |
| 打开书 | 点书卡；如果 `书目.json` 损坏，卡片会标红并提供修复 |
| 新建章节 | 左栏底部「＋ 新建章节」，输入章节名（可留空 = 未命名） |
| 在中间插入 | 当前章标题栏「＋ 插入」，或章节右键 → 在此前/后插入 |
| 切换章节 | 单击左栏章节；有未保存修改时会弹窗 |
| 保存整本 | `Ctrl+S` 或右上「保存」；保存时会顺带校验全书章节文件是否齐全 |
| 重命名章节 | 双击章节，或右键 → 重命名（只改显示名） |
| 删除章节 | 右键 → 删除（文件进 `_trash`，不真删） |
| 复制整本 | 右上「导出 ▾」→ 复制整本到剪贴板 |
| 导出 TXT | 右上「导出 ▾」→ 导出 TXT…（UTF-8 带 BOM，记事本友好） |
| 打开书文件夹 | 右上「导出 ▾」→ 打开本书文件夹 |
| 设置 | 书架右上「设置」：书架目录、正文字体、字号 |

快捷键：`Ctrl+S` 保存、`Ctrl+N` 新建章节、`Esc` 关弹层、`Ctrl+Shift+I` 开发者工具（调试用）。

## 防丢稿设计（为什么敢叫绝不丢稿）

虽然不做自动保存，但底层仍然为「不丢稿」做了这些：

1. **所有写盘都是原子写**：临时文件 → fsync → rename（失败重试 3 次）。不会出现写一半的半截文件。
2. **`书目.json` 每次写入前保留上一版 `.bak`**：json 写坏可以从上一版恢复。
3. **删除不真删**：章节文件移到 `_trash\{时间戳}-{原文件名}`。
4. **未保存状态四处可见**：窗口标题前 `*`、状态栏橙点、保存按钮高亮、章节名后 `•`。
5. **四处拦截**：切章、关窗、导出/复制、返回书架，都会先问。
6. **关窗保存失败会阻止退出**：弹「返回保存 / 放弃修改退出」，不会静默关掉。
7. **外部修改检测**：用记事本改了当前章节后，切回应用会提示「重新加载 / 保留我的」。
8. **损坏恢复**：`书目.json` 坏了，可以从 `.bak` 恢复，或按目录里的 txt 文件名重建书目（损坏文件改名为 `.corrupt-时间戳` 保留）。
9. **保存失败不更新「已保存」状态**：状态栏红字显示具体错误。

## 开发与自检

```bash
pnpm test          # 单元测试（node:test，35 项，覆盖编号/文件名/原子写/备份/重建/导出格式）
pnpm run e2e       # 端到端自检：真实启动 Electron 走 38 项主流程，并校验磁盘结果
pnpm run demo      # 生成演示书库到 shots/demo-library（截图/演示用）
```

截图（开发自检用）：应用支持在测试模式下截取窗口画面：

```bash
# 书架
pnpm start -- --user-data=shots/ud-1 --books-root=shots/demo-library --screenshot=shots/shelf.png
# 编辑视图（打开指定书、指定章节）
pnpm start -- --user-data=shots/ud-2 --books-root=shots/demo-library --book=shots/demo-library/星海旅人 --chapter=0 --screenshot=shots/editor.png
```

> `--user-data=...` 用来隔离配置，避免动到你正在用的书架；不带这些参数就是正常使用。

## 目录结构

```
chapter-writer/
├─ package.json / pnpm-workspace.yaml / .npmrc
├─ main.js                  # Electron 主进程：窗口、生命周期、关闭拦截、全部文件 IO
├─ preload.js               # contextBridge 白名单 IPC
├─ core/                    # 纯 Node 逻辑，不依赖 Electron，可单测
│  ├─ atomic.js             # 原子写（临时文件 + fsync + rename + 重试）
│  ├─ chapters.js           # 编号、标题、文件名净化、顺序增删
│  ├─ storage.js            # 书架扫描、书目读写、章节读写、_trash、写锁
│  ├─ config.js             # 配置读写
│  ├─ repair.js             # 从 .bak 恢复 / 从目录 txt 重建
│  ├─ importer.js           # 导入小说（整本书复制 / 从 txt 重建书目）
│  └─ exporter.js           # 整本拼接（导出与复制共用）
├─ renderer/                # 界面（HTML/CSS/JS，无框架）
├─ scripts/
│  ├─ start.js              # 启动器（清理 ELECTRON_RUN_AS_NODE）
│  ├─ run-e2e.js            # pnpm run e2e
│  ├─ e2e-scenario.js       # 端到端自检场景
│  └─ demo-data.js          # 生成演示书库
├─ tests/                   # node:test 单元测试
├─ README.md
└─ 验收清单.md
```

## 已知限制（v0.1 有意不做）

- 不打包 exe / 没有安装器（需求约定）
- 无自动保存、无每日备份、无云同步、无多端（按作者要求）
- 无富文本、无大纲、无设定库、无 AI 辅助（需求砍掉）
- 章节拖拽排序、全书搜索替换、多窗口同时编辑两本书 → 留给 v0.2
- 「Windows 关机拦截」是尽力而为：系统关机不强等应用，可能来不及弹提示

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 书架是空的 | 书架目录里还没有书；点「新建一本书」，或把书文件夹放进该目录 |
| 书卡标红「书目损坏」 | 点开修复：从 `.bak` 恢复 / 从目录 txt 重建。不要自己删文件 |
| `pnpm start` 闪退、提示 `Cannot read properties of undefined (reading 'whenReady')` | 环境里有 `ELECTRON_RUN_AS_NODE=1`；确认用 `pnpm start`（走 scripts/start.js），或手动清掉该变量 |
| `pnpm start` 报「无法加载文件 …pnpm.ps1，因为在此系统上禁止运行脚本」 | Windows PowerShell 5.1 执行策略限制，与应用无关。改用 `pnpm.cmd start`、双击 `启动写作器.cmd`，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试（详见「安装与启动」） |
| Electron 下载很慢/失败 | 检查 `.npmrc` 的镜像；或 `pnpm approve-builds` 放行 electron 的 install 脚本 |
| 记事本打开 txt 是乱码 | 章节文件是 UTF-8 无 BOM；较老的记事本请升级到 Win11 自带版本，或用 VSCode 打开 |
| 保存失败 | 看状态栏红字：磁盘满 / 文件被占用 / 无权限。处理后再按 `Ctrl+S`，关窗时也会阻止退出 |
| 想回退到昨天的版本 | v0.1 没有应用内备份：从你自己的同步盘 / 文件历史记录里找回，或从 `_trash`、`.bak` 里找 |
| 删除的小说去哪了 | 默认进 **Windows 回收站**（可还原）；回收站不可用（例如某些网络盘）时移到书架目录的 `_trash\`，同样不会真删 |
| 导入支持什么格式 | 支持三种：① 章节写作器自己的书文件夹（含合法 `书目.json`）→ 整本复制；② 一本书的章节 txt 文件夹（文件名带序号 `001-xxx.txt`，或 `第一章 xxx.txt`）→ 合成一本；③ 一堆完整小说 txt（如 `小说txt文件夹`，每个 txt 是一整本小说）→ 每个 txt 一本书，自动按「第X章 / 楔子 / Chapter N」分章。编码自动识别 UTF-8 / UTF-16 / GBK；原文件夹不会被移动或删除；单个 txt 也可以放进一个空文件夹后导入 |

## v0.2 候选（按需再做）

- 打包 exe + 图标 + 安装包
- 章节拖拽排序、全书搜索替换
- 护眼/夜间主题
- 若作者改变主意：可加回自动保存与每日备份（架构里保存入口都已集中，改动集中在 renderer 的保存触发点）
