'use strict';

const fs = require('fs');
const path = require('path');

const STATE_SCHEMA = 1;

function updaterDir(root) {
  return path.join(root, '.updater');
}

function slotsDir(root) {
  return path.join(updaterDir(root), 'slots');
}

function slotPath(root, slot) {
  if (!['a', 'b'].includes(slot)) throw new Error(`非法槽位：${slot}`);
  return path.join(slotsDir(root), `slot-${slot}`);
}

function statePath(root) {
  return path.join(updaterDir(root), 'state.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function readState(root) {
  try {
    const state = readJson(statePath(root));
    if (state.schema !== STATE_SCHEMA || !['a', 'b'].includes(state.activeSlot)) return null;
    return state;
  } catch (_) {
    return null;
  }
}

function packageVersion(appDir) {
  try {
    const file = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const version = readJson(file).version;
    return typeof version === 'string' ? version : null;
  } catch (_) {
    return null;
  }
}

function currentVersion(root) {
  return packageVersion(path.join(root, 'runtime')) || packageVersion(path.join(root, 'app'));
}

function isDirectoryLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

function createDirectoryLink(target, link) {
  fs.symlinkSync(path.resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir');
}

function assertManagedSlot(root, target) {
  const base = path.resolve(slotsDir(root)) + path.sep;
  const resolved = path.resolve(target);
  if (!resolved.startsWith(base) || !/^slot-[ab]$/i.test(path.basename(resolved))) {
    throw new Error(`拒绝操作非托管槽位：${target}`);
  }
}

function removeManagedSlot(root, target) {
  assertManagedSlot(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}

function recordActive(root, activeSlot, version, extra = {}) {
  const state = {
    schema: STATE_SCHEMA,
    activeSlot,
    version,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  writeJsonAtomic(statePath(root), state);
  return state;
}

function copyLegacyApp(root, options = {}) {
  const app = path.join(root, 'app');
  if (!fs.existsSync(app)) throw new Error(`缺少部署目录：${app}`);
  fs.mkdirSync(slotsDir(root), { recursive: true });
  const existing = readState(root);
  if (existing) return existing;

  const firstSlot = slotPath(root, 'a');
  if (!fs.existsSync(firstSlot)) {
    fs.cpSync(app, firstSlot, {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  const version = packageVersion(firstSlot);
  if (!version) throw new Error('复制到 slot-a 后无法读取 DSH 版本');
  return recordActive(root, 'a', version, { legacyRuntime: true, preparedOnly: options.preparedOnly !== false });
}

function switchActiveSlot(root, targetSlot) {
  const target = slotPath(root, targetSlot);
  if (!fs.existsSync(path.join(target, 'node_modules'))) throw new Error(`目标槽位无 node_modules：${target}`);
  const runtime = path.join(root, 'runtime');
  const active = path.join(runtime, 'node_modules');
  if (!isDirectoryLink(active)) throw new Error('runtime/node_modules 不是目录链接，拒绝切槽');

  const next = path.join(runtime, '.node_modules-next');
  const previous = path.join(runtime, '.node_modules-previous');
  if (fs.existsSync(next)) fs.rmSync(next, { recursive: true, force: true });
  if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
  createDirectoryLink(path.join(target, 'node_modules'), next);
  fs.renameSync(active, previous);
  try {
    fs.renameSync(next, active);
  } catch (error) {
    fs.renameSync(previous, active);
    if (fs.existsSync(next)) fs.rmSync(next, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
}

function updateLaunchScript(root) {
  const file = path.join(root, 'start-deepseek-harness.cmd');
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, 'utf8');
  const legacy = `${root}\\app\\node_modules`;
  const managed = `${root}\\runtime\\node_modules`;
  const updated = source.split(legacy).join(managed);
  if (updated === source) return false;
  fs.writeFileSync(file, updated, 'utf8');
  return true;
}

module.exports = {
  STATE_SCHEMA,
  updaterDir,
  slotsDir,
  slotPath,
  statePath,
  readState,
  writeJsonAtomic,
  packageVersion,
  currentVersion,
  isDirectoryLink,
  assertManagedSlot,
  removeManagedSlot,
  recordActive,
  copyLegacyApp,
  switchActiveSlot,
  updateLaunchScript,
};
