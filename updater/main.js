'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const backend = require('./lib/backend');
const update = require('./lib/update');

const KEEP_ALIVE = process.env.DSH_DESKTOP_KEEP_ALIVE !== '0';
const AUTOTEST = process.env.DSH_DESKTOP_AUTOTEST === '1';
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_FAILURE_THRESHOLD = 2;

function resolveRoot() {
  if (process.env.DSH_INSTALL_ROOT) return path.resolve(process.env.DSH_INSTALL_ROOT);
  if (!app.isPackaged) return path.resolve(__dirname, '..', '..');
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

const ROOT = resolveRoot();
const LOG_DIR = path.join(ROOT, '.desktop-logs');
const MAIN_LOG = path.join(LOG_DIR, 'main.log');
const BACKEND_LOG = path.join(LOG_DIR, 'backend.log');
let mainWindow;
let tray;
let backendChild;
let spawnedByUs = false;
let healthTimer;
let healthMisses = 0;
let recovering = false;
let quitting = false;
let updating = false;
let updateInfo;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(MAIN_LOG, line + '\n', 'utf8');
  } catch (_) { /* logging never blocks startup */ }
}

function backendLog(buffer) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(BACKEND_LOG, buffer);
  } catch (_) { /* ignore */ }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  run().catch((error) => {
    log('启动失败:', error.stack || error.message);
    if (!AUTOTEST) dialog.showErrorBox('DeepSeek Harness 启动失败', `${error.message}\n\n日志：${LOG_DIR}`);
    quit(1);
  });
}

async function run() {
  app.setAppUserModelId('com.deepseek.harness.safe-updater');
  log('==== 启动 ====', `packaged=${app.isPackaged}`, `root=${ROOT}`);
  if (!fs.existsSync(backend.binPath(ROOT))) throw new Error(`找不到后端入口：${backend.binPath(ROOT)}`);
  await app.whenReady();
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  await startAndLoad();
  checkUpdates(false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.once('ready-to-show', () => !quitting && mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (!quitting && KEEP_ALIVE) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    tray = new Tray(icon);
    tray.setToolTip('DeepSeek Harness');
    tray.on('click', showWindow);
    refreshTray();
  } catch (error) {
    log('创建托盘失败:', error.message);
  }
}

function refreshTray() {
  if (!tray) return;
  const items = [];
  if (updating) items.push({ label: '正在安全更新…', enabled: false }, { type: 'separator' });
  else if (updateInfo?.updateAvailable) {
    items.push({
      label: `更新到官方 ${updateInfo.latest}（当前 ${updateInfo.current}）`,
      click: confirmUpdate,
    }, { type: 'separator' });
  }
  items.push(
    { label: '显示窗口', click: showWindow },
    { label: '检查更新', enabled: !updating, click: () => checkUpdates(true) },
    { type: 'separator' },
    { label: '退出', enabled: !updating, click: () => quit(0) },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function spawnBackend() {
  const child = backend.startBackend(ROOT, { port: backend.PORT });
  backendChild = child;
  spawnedByUs = true;
  child.stdout.on('data', backendLog);
  child.stderr.on('data', backendLog);
  child.once('exit', (code, signal) => {
    if (backendChild === child) {
      backendChild = null;
      spawnedByUs = false;
      log(`后端退出 code=${code} signal=${signal}`);
    }
  });
  await backend.waitForHttpReady(child, backend.PORT, { timeoutMs: 120000 });
  log(`后端探活通过 pid=${child.pid}`);
}

async function startAndLoad() {
  if (await backend.probePort(backend.PORT)) {
    if (!await backend.probeHttp(backend.PORT)) throw new Error(`${backend.PORT} 被非 DSH 服务占用`);
    spawnedByUs = false;
    log(`复用 ${backend.PORT} 上的现有 DSH`);
  } else await spawnBackend();
  await mainWindow.loadURL(`http://${backend.HOST}:${backend.PORT}`);
  mainWindow.show();
  startHealthMonitor();
  if (AUTOTEST) setTimeout(() => quit(0), 3000);
}

function startHealthMonitor() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (quitting || updating || recovering) return;
    if (await backend.probeHttp(backend.PORT)) {
      healthMisses = 0;
      return;
    }
    if (++healthMisses < HEALTH_FAILURE_THRESHOLD) return;
    recovering = true;
    try {
      stopBackend();
      if (!await backend.probePort(backend.PORT)) await spawnBackend();
      await mainWindow?.loadURL(`http://${backend.HOST}:${backend.PORT}`);
      healthMisses = 0;
    } catch (error) {
      log('后端恢复失败:', error.message);
    } finally {
      recovering = false;
    }
  }, HEALTH_INTERVAL_MS);
}

async function checkUpdates(showResult) {
  if (process.env.DSH_DESKTOP_NO_UPDATE_CHECK === '1') return;
  try {
    updateInfo = await update.checkForUpdate(ROOT);
    log(`更新检查 current=${updateInfo.current} latest=${updateInfo.latest} source=${updateInfo.release.source}`);
    refreshTray();
    if (showResult && !AUTOTEST) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'DeepSeek Harness 更新',
        message: updateInfo.updateAvailable ? `发现官方 RC ${updateInfo.latest}` : `当前已是最新官方 RC ${updateInfo.current}`,
      });
    }
  } catch (error) {
    log('更新检查失败:', error.message);
    if (showResult && !AUTOTEST) dialog.showErrorBox('更新检查失败', error.message);
  }
}

async function confirmUpdate() {
  if (!updateInfo?.updateAvailable || updating) return;
  if (!AUTOTEST) {
    const result = await dialog.showMessageBox({
      type: 'question',
      title: '安全更新 DeepSeek Harness',
      message: `更新 ${updateInfo.current} → ${updateInfo.latest}？`,
      detail: '将先在非活动槽精确安装并检查三个本地插件，再把 DSH_HOME、插件和桌面配置备份到本机。隔离探活不复制设置或凭据；真实启动失败会自动回滚。',
      buttons: ['开始更新', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return;
  }
  await performUpdate();
}

async function waitPortClosed(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!await backend.probePort(backend.PORT)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${backend.PORT} 端口仍被占用`);
}

async function performUpdate() {
  updating = true;
  refreshTray();
  let updateError;
  try {
    if (!spawnedByUs && await backend.probePort(backend.PORT)) {
      throw new Error('当前正在复用外部 DSH；请先退出该后端，再重试更新。');
    }
    const result = await update.applyUpdate(ROOT, updateInfo.latest, {
      release: updateInfo.release,
      onLog: (line) => log('[updater]', line),
      beforeSwitch: async () => {
        log('[updater] 候选槽验证完成，关闭旧后端并切槽');
        stopBackend();
        await waitPortClosed();
      },
    });
    updateInfo = null;
    log('更新成功:', JSON.stringify({ target: result.target, slot: result.activeSlot, backup: result.backup }));
    if (!AUTOTEST) {
      await dialog.showMessageBox({
        type: 'info',
        title: '更新完成',
        message: `DeepSeek Harness 已更新到 ${result.target}`,
        detail: `活动槽：slot-${result.activeSlot}\n本地回滚备份：${result.backup}`,
      });
    }
  } catch (error) {
    updateError = error;
    log('更新失败:', error.stack || error.message);
    if (!AUTOTEST) dialog.showErrorBox('更新失败，已执行回滚流程', error.message);
  } finally {
    try {
      if (!await backend.probePort(backend.PORT)) await spawnBackend();
      await mainWindow?.loadURL(`http://${backend.HOST}:${backend.PORT}`);
    } catch (restartError) {
      log('恢复启动失败:', restartError.message);
      if (!updateError && !AUTOTEST) dialog.showErrorBox('后端恢复失败', restartError.message);
    }
    updating = false;
    refreshTray();
  }
}

function stopBackend() {
  if (spawnedByUs && backendChild) backend.killTree(backendChild);
  backendChild = null;
  spawnedByUs = false;
}

function quit(code) {
  if (quitting) return;
  quitting = true;
  clearInterval(healthTimer);
  stopBackend();
  AUTOTEST ? app.exit(code) : app.quit();
}

app.on('window-all-closed', () => { if (!KEEP_ALIVE || quitting) app.quit(); });
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; stopBackend(); });
app.on('will-quit', stopBackend);
