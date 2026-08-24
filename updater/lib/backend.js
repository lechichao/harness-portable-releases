'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3080;
const SECRET_ENV = /(api.?key|token|secret|password|credential)/i;

function nodeBinary(root) {
  const candidates = [
    path.join(root, 'runtime', 'nodejs', 'node.exe'),
    path.join(root, 'node-portable', 'node.exe'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || 'node';
}

function npmCli(root) {
  const candidates = [
    path.join(root, 'runtime', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(root, 'node-portable', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function baseEnv(root, source = process.env) {
  return {
    ...source,
    DSH_HOME: path.join(root, 'data'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_prefix: path.join(root, 'npm-global'),
    TEMP: path.join(root, 'temp'),
    TMP: path.join(root, 'temp'),
  };
}

function sanitizedEnv(root, overrides = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(key)) clean[key] = value;
  }
  return { ...baseEnv(root, clean), ...overrides };
}

function binPath(root, appDir = path.join(root, 'runtime')) {
  return path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function startBackend(root, options = {}) {
  const appDir = options.appDir || path.join(root, 'runtime');
  const args = [binPath(root, appDir), 'web'];
  if (options.port !== undefined) args.push('--port', String(options.port));
  return spawn(nodeBinary(root), args, {
    cwd: options.cwd || root,
    env: options.env || { ...baseEnv(root), ...(options.overrides || {}) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function probePort(port, host = HOST, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function probeHttp(port, host = HOST, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: '/', timeout: timeoutMs }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode >= 200 && response.statusCode < 400));
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

function availablePort(host = HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForHttpReady(child, port, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      error ? reject(error) : resolve(port);
    };
    const onExit = (code, signal) => finish(new Error(`后端探活前退出 (code=${code}, signal=${signal})`));
    const onError = (error) => finish(new Error(`后端启动失败：${error.message}`));
    const poll = async () => {
      if (settled) return;
      if (Date.now() - started >= timeoutMs) return finish(new Error(`后端 ${Math.round(timeoutMs / 1000)} 秒内未通过 HTTP 探活`));
      if (await probeHttp(port)) return finish();
      timer = setTimeout(poll, options.intervalMs || 400);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    poll();
  });
}

function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    const windowsDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    try {
      spawnSync(path.join(windowsDir, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      });
    } catch (_) { /* fall through */ }
  }
  try { child.kill(); } catch (_) { /* already exited */ }
}

module.exports = {
  HOST,
  PORT,
  SECRET_ENV,
  nodeBinary,
  npmCli,
  baseEnv,
  sanitizedEnv,
  binPath,
  startBackend,
  probePort,
  probeHttp,
  availablePort,
  waitForHttpReady,
  killTree,
};
