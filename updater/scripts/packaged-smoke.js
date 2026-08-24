'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const executable = path.resolve(__dirname, '..', 'dist', 'DeepSeek-Harness.exe');
if (!fs.existsSync(executable)) throw new Error(`missing packaged updater: ${executable}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packaged-smoke-'));
const temp = path.join(root, 'temp');
const bin = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
fs.mkdirSync(path.dirname(bin), { recursive: true });
fs.mkdirSync(temp, { recursive: true });
fs.writeFileSync(path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
fs.writeFileSync(bin, `
const http = require('http');
const args = process.argv.slice(2);
const at = args.indexOf('--port');
const port = at >= 0 ? Number(args[at + 1]) : 3080;
const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
server.listen(port, '127.0.0.1');
const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
`);

const logFile = path.join(root, '.desktop-logs', 'main.log');
const child = spawn(executable, [], {
  env: {
    ...process.env,
    DSH_INSTALL_ROOT: root,
    DSH_DESKTOP_AUTOTEST: '1',
    DSH_DESKTOP_KEEP_ALIVE: '0',
    DSH_DESKTOP_NO_UPDATE_CHECK: '1',
    TEMP: temp,
    TMP: temp,
  },
  windowsHide: true,
  stdio: 'ignore',
});

const started = Date.now();
const timeoutMs = 90000;
let sawReady = false;
const timer = setInterval(() => {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  sawReady ||= log.includes('后端探活通过');
  if (Date.now() - started > timeoutMs) finish(1, `packaged updater probe timed out\n${log.slice(-4000)}`);
}, 500);

child.once('error', (error) => finish(1, error.stack || error.message));
child.once('exit', (code) => {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  sawReady ||= log.includes('后端探活通过');
  if (code === 0 && sawReady) finish(0, 'packaged updater startup probe passed');
  else finish(1, `packaged updater exited before a healthy startup (${code})\n${log.slice(-4000)}`);
});

let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (code !== 0) {
    try { child.kill(); } catch (_) { /* already exited */ }
  }
  setTimeout(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* CI temp cleanup */ }
    console.log(message);
    process.exit(code);
  }, 1500);
}
