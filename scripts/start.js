// 启动 Electron。
// 某些宿主环境（例如 DeepSeek Harness 的 shell）会带 ELECTRON_RUN_AS_NODE=1，
// 若不清除，Electron 会退化成纯 Node 运行、require('electron') 拿不到 API。
const { spawn } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const appDir = path.join(__dirname, '..');
const args = [appDir, ...process.argv.slice(2)];

const child = spawn(electronPath, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('[start] 启动 Electron 失败:', err);
  process.exit(1);
});
