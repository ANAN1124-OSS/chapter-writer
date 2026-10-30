// 一键跑端到端自检：独立临时 userData/书库，真实启动 Electron 走一遍主流程。
// 用法：pnpm run e2e
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const base = path.join(os.tmpdir(), `cw-e2e-${stamp}-${process.pid}`);
const userData = path.join(base, 'userdata');
const books = path.join(base, 'books');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(books, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(
  process.execPath,
  [
    path.join(root, 'scripts', 'start.js'),
    '--e2e',
    `--user-data=${userData}`,
    `--books-root=${books}`
  ],
  { cwd: root, env }
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const timer = setTimeout(() => {
  console.error('[e2e] 超时（180 秒），强制结束');
  try { child.kill(); } catch { /* 忽略 */ }
  process.exit(1);
}, 180000);
timer.unref();

child.on('close', (code) => {
  clearTimeout(timer);
  const match = stdout.match(/E2E_RESULT (.+)/);
  if (!match) {
    console.error('[e2e] 没有拿到结果，应用可能启动失败。');
    console.error(stdout.trim());
    console.error(stderr.trim());
    process.exit(code || 1);
  }
  let result;
  try {
    result = JSON.parse(match[1]);
  } catch {
    console.error('[e2e] 结果 JSON 解析失败：', match[1]);
    process.exit(1);
  }
  const details = result.details || [];
  for (const item of details) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`);
  }
  console.log('');
  if (result.ok) {
    console.log(`端到端自检通过：${result.checks} 项全部通过。`);
    console.log(`临时书库：${books}`);
    process.exit(0);
  }
  console.error(`端到端自检失败：${result.error || '未知错误'}`);
  process.exit(1);
});
