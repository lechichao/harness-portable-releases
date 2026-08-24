'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const semver = require('semver');
const backend = require('./backend');
const layout = require('./layout');
const registry = require('./registry');

const PLUGINS = [
  'dsh-plugin-deepsea-cockpit',
  'dsh-plugin-session-lifecycle',
  'dsh-plugin-usage-cost',
];
const SENSITIVE_FILE = /(^|[._-])(credentials?|secrets?|tokens?|api.?keys?)([._-]|$)|^settings\.ya?ml$/i;

function logger(options) {
  return typeof options.onLog === 'function' ? options.onLog : () => {};
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function requireRc(version) {
  if (!semver.valid(version)) throw new Error(`非法目标版本：${version}`);
  const pre = semver.prerelease(version);
  if (!pre || pre[0] !== 'rc' || !Number.isInteger(pre[1])) {
    throw new Error(`目标不是官方 RC 版本：${version}`);
  }
  return version;
}

function copyTree(source, destination, options = {}) {
  if (!fs.existsSync(source)) return false;
  const normalized = Array.isArray(options) ? { exclusions: options } : options;
  const exclusions = (normalized.exclusions || []).map((item) => item.split('/').join(path.sep).toLowerCase());
  const excludeSensitiveNames = normalized.excludeSensitiveNames === true;
  const absoluteSource = path.resolve(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    verbatimSymlinks: true,
    filter: (candidate) => {
      const relative = path.relative(absoluteSource, path.resolve(candidate));
      const lowered = relative.toLowerCase();
      if (exclusions.some((prefix) => lowered === prefix || lowered.startsWith(prefix + path.sep))) return false;
      if (excludeSensitiveNames && relative && SENSITIVE_FILE.test(path.basename(relative))) return false;
      return true;
    },
  });
  return true;
}

function inventory(root) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(root)) return { files, bytes };
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createBackup(root, targetVersion, options = {}) {
  const log = logger(options);
  const backupRoot = path.join(root, 'backups', `updater-before-${targetVersion}-${timestamp()}`);
  if (fs.existsSync(backupRoot)) throw new Error(`备份目录已存在：${backupRoot}`);
  fs.mkdirSync(backupRoot, { recursive: true });

  const jobs = [
    { name: 'data', exclusions: ['profiles/node_modules'] },
    { name: 'plugins', exclusions: ['node_modules'] },
    { name: 'desktop', exclusions: ['node_modules', 'dist'] },
  ];
  for (const job of jobs) {
    log(`备份 ${job.name}...`);
    copyTree(path.join(root, job.name), path.join(backupRoot, job.name), job);
  }
  const rootFiles = [
    'start-deepseek-harness.cmd',
    '启动-DeepSeek-Harness-Web.cmd',
    'README-中文.txt',
    '桌面版集成说明.md',
  ];
  for (const name of rootFiles) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupRoot, name));
  }

  const critical = {};
  for (const relative of ['desktop/package.json', 'desktop/main.js', 'start-deepseek-harness.cmd']) {
    const file = path.join(backupRoot, ...relative.split('/'));
    if (fs.existsSync(file)) critical[relative] = digest(file);
  }
  const manifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    root,
    currentVersion: layout.currentVersion(root),
    targetVersion,
    included: ['data', 'plugins', 'desktop', ...rootFiles],
    excludedRegenerable: ['data/profiles/node_modules', 'plugins/node_modules', 'desktop/node_modules', 'desktop/dist'],
    inventory: Object.fromEntries(jobs.map((job) => [job.name, inventory(path.join(backupRoot, job.name))])),
    sha256: critical,
    localOnly: true,
  };
  fs.writeFileSync(path.join(backupRoot, 'BACKUP-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`本地备份完成：${backupRoot}`);
  return backupRoot;
}

function restoreBackup(root, backupRoot, options = {}) {
  const log = logger(options);
  const manifestFile = path.join(backupRoot, 'BACKUP-MANIFEST.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`备份清单不存在：${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (path.resolve(manifest.root) !== path.resolve(root)) throw new Error('备份根目录与当前部署不匹配');
  for (const name of ['data', 'plugins', 'desktop']) {
    const source = path.join(backupRoot, name);
    if (fs.existsSync(source)) {
      log(`恢复 ${name}...`);
      copyTree(source, path.join(root, name));
    }
  }
  for (const name of manifest.included || []) {
    if (['data', 'plugins', 'desktop'].includes(name)) continue;
    const source = path.join(backupRoot, name);
    if (fs.existsSync(source) && fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(root, name));
  }
}

function runCommand(command, args, options = {}) {
  const log = logger(options);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (buffer) => {
      const text = buffer.toString('utf8');
      output = (output + text).slice(-20000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(line.trim());
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      backend.killTree(child);
      reject(new Error(`命令超时：${path.basename(command)}`));
    }, options.timeoutMs || 20 * 60 * 1000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, output });
      else reject(new Error(`命令失败 (code=${code}, signal=${signal})\n${output.slice(-4000)}`));
    });
  });
}

function packagePath(nodeModules, name) {
  return path.join(nodeModules, ...name.split('/'), 'package.json');
}

function installedPackage(nodeModules, name) {
  const file = packagePath(nodeModules, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function dshFamilyFromLock(slot) {
  const lock = JSON.parse(fs.readFileSync(path.join(slot, 'package-lock.json'), 'utf8'));
  const found = [];
  for (const [location, value] of Object.entries(lock.packages || {})) {
    if (!value) continue;
    const normalized = location.replace(/\\/g, '/');
    const marker = 'node_modules/';
    const index = normalized.lastIndexOf(marker);
    const tail = index >= 0 ? normalized.slice(index + marker.length) : '';
    const parts = tail.split('/');
    const inferred = parts[0] && parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const name = value.name || inferred;
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      found.push({ name, version: value.version, location: normalized, integrity: value.integrity || null });
    }
  }
  return found;
}

function verifyExactFamily(slot, release) {
  const packages = dshFamilyFromLock(slot);
  const rootPackage = packages.find((item) => item.location === 'node_modules/@deepseek-ai/dsh');
  if (!rootPackage) throw new Error('候选槽位没有安装根包 @deepseek-ai/dsh');
  const mismatches = packages.filter((item) => item.version !== release.version);
  if (mismatches.length) {
    throw new Error(`候选槽混入非目标 DSH 包：${mismatches.slice(0, 12).map((item) => `${item.name}@${item.version}`).join(', ')}`);
  }
  if (release.integrity && rootPackage.integrity !== release.integrity) {
    throw new Error('候选根包完整性摘要与官方 npm 清单不一致');
  }
  return packages;
}

function buildCandidatePackage(activeSlot, targetVersion) {
  const current = JSON.parse(fs.readFileSync(path.join(activeSlot, 'package.json'), 'utf8'));
  const dependencies = { ...(current.dependencies || {}) };
  const familyNames = new Set(dshFamilyFromLock(activeSlot).map((item) => item.name));
  familyNames.add('@deepseek-ai/dsh');
  for (const name of Object.keys(dependencies)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) familyNames.add(name);
  }
  for (const name of familyNames) {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) dependencies[name] = targetVersion;
  }
  dependencies['@deepseek-ai/dsh'] = targetVersion;
  const overrides = { ...(current.overrides || {}) };
  for (const name of familyNames) overrides[name] = targetVersion;
  return {
    name: current.name || 'deepseek-harness-slot',
    private: true,
    version: '0.0.0',
    dependencies,
    overrides,
  };
}

async function installCandidate(root, activeSlot, candidateSlot, release, options = {}) {
  const log = logger(options);
  layout.removeManagedSlot(root, candidateSlot);
  fs.mkdirSync(candidateSlot, { recursive: true });
  fs.writeFileSync(
    path.join(candidateSlot, 'package.json'),
    JSON.stringify(buildCandidatePackage(activeSlot, release.version), null, 2) + '\n',
  );
  const localMcp = path.join(activeSlot, 'local-mcp');
  if (fs.existsSync(localMcp)) copyTree(localMcp, path.join(candidateSlot, 'local-mcp'));
  const npmCli = backend.npmCli(root);
  if (!npmCli) throw new Error('便携 Node 中缺少 npm-cli.js');
  log(`从官方 npm 精确安装 @deepseek-ai/dsh@${release.version} 到非活动槽...`);
  await runCommand(backend.nodeBinary(root), [npmCli, 'install', '--no-audit', '--no-fund', '--save-exact'], {
    cwd: candidateSlot,
    env: backend.sanitizedEnv(root, {
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_save_exact: 'true',
      npm_config_package_lock: 'true',
    }),
    timeoutMs: options.installTimeoutMs || 20 * 60 * 1000,
    onLog: options.onLog,
  });
  const family = verifyExactFamily(candidateSlot, release);
  const installed = installedPackage(path.join(candidateSlot, 'node_modules'), '@deepseek-ai/dsh');
  if (!installed || installed.version !== release.version) throw new Error('候选根包版本验证失败');
  const manifest = {
    schema: 1,
    version: release.version,
    installedAt: new Date().toISOString(),
    npmSource: release.source,
    npmIntegrity: release.integrity,
    npmShasum: release.shasum,
    familyCount: family.length,
  };
  fs.writeFileSync(path.join(candidateSlot, 'SLOT-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function resolvePluginRoot(root, name) {
  const candidates = [
    path.join(root, 'plugins', name),
    path.join(root, 'data', 'profiles', 'node_modules', name),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) || null;
}

async function checkPlugins(root, candidateSlot, options = {}) {
  const log = logger(options);
  const nodeModules = path.join(candidateSlot, 'node_modules');
  const reports = [];
  const checkHome = path.join(root, 'temp', `updater-plugin-check-${process.pid}-${Date.now()}`);
  fs.mkdirSync(checkHome, { recursive: true });
  try {
    for (const name of PLUGINS) {
      const pluginRoot = resolvePluginRoot(root, name);
      if (!pluginRoot) throw new Error(`缺少本地插件：${name}`);
      const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
      const peers = [];
      for (const [peerName, range] of Object.entries(plugin.peerDependencies || {})) {
        const installed = installedPackage(nodeModules, peerName);
        const optional = plugin.peerDependenciesMeta?.[peerName]?.optional;
        if (!installed && !optional) throw new Error(`${name}: 缺少 peer ${peerName}@${range}`);
        if (installed && !semver.satisfies(installed.version, range, { includePrerelease: true })) {
          throw new Error(`${name}: peer ${peerName} 需要 ${range}，候选为 ${installed.version}`);
        }
        if (installed) peers.push(`${peerName}@${installed.version}`);
      }
      for (const injected of plugin.dsh?.client?.inject || []) {
        if (!installedPackage(nodeModules, injected)) throw new Error(`${name}: 缺少客户端注入点 ${injected}`);
      }
      const staged = path.join(nodeModules, name);
      fs.rmSync(staged, { recursive: true, force: true });
      copyTree(pluginRoot, staged, ['node_modules']);
      const entry = path.join(staged, plugin.main || 'lib/index.js');
      const client = path.join(staged, 'lib', 'client.js');
      for (const file of [entry, ...(fs.existsSync(client) ? [client] : [])]) {
        await runCommand(backend.nodeBinary(root), ['--check', file], {
          cwd: candidateSlot,
          env: backend.sanitizedEnv(root, { DSH_HOME: checkHome }),
          timeoutMs: 30000,
          onLog: options.onLog,
        });
      }
      const script = `import(${JSON.stringify(pathToFileURL(entry).href)}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})`;
      await runCommand(backend.nodeBinary(root), ['--input-type=module', '--eval', script], {
        cwd: candidateSlot,
        env: backend.sanitizedEnv(root, { DSH_HOME: checkHome }),
        timeoutMs: 30000,
        onLog: options.onLog,
      });
      reports.push({ name, version: plugin.version || null, peers, passed: true });
      log(`${name}: peer、注入点、语法与服务端导入检查通过`);
    }
    return reports;
  } finally {
    fs.rmSync(checkHome, { recursive: true, force: true });
  }
}

function stageProbeHome(root, candidateSlot) {
  const stageRoot = path.join(root, 'temp', `updater-probe-${process.pid}-${Date.now()}`);
  const stageData = path.join(stageRoot, 'data');
  fs.mkdirSync(stageData, { recursive: true });
  copyTree(path.join(root, 'data', 'profiles'), path.join(stageData, 'profiles'), {
    exclusions: ['node_modules', 'sessions', 'storage', '.cache'],
    excludeSensitiveNames: true,
  });
  const profileModules = path.join(stageData, 'profiles', 'node_modules');
  fs.mkdirSync(profileModules, { recursive: true });
  for (const name of PLUGINS) {
    const target = path.join(candidateSlot, 'node_modules', name);
    if (!fs.existsSync(target)) throw new Error(`候选槽缺少插件：${name}`);
    fs.symlinkSync(target, path.join(profileModules, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { stageRoot, stageData };
}

async function healthProbe(root, candidateSlot, options = {}) {
  const log = logger(options);
  const staged = options.live ? null : stageProbeHome(root, candidateSlot);
  const port = options.port || await backend.availablePort();
  const env = options.live
    ? { ...backend.baseEnv(root), DSH_HOME: path.join(root, 'data') }
    : backend.sanitizedEnv(root, { DSH_HOME: staged.stageData });
  const child = backend.startBackend(root, { appDir: candidateSlot, port, env });
  let output = '';
  const capture = (buffer) => {
    const text = buffer.toString('utf8');
    output = (output + text).slice(-16000);
    for (const line of text.split(/\r?\n/)) if (line.trim()) log(`[probe] ${line.trim()}`);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    await backend.waitForHttpReady(child, port, { timeoutMs: options.healthTimeoutMs || 150000 });
    log(`${options.live ? '真实配置' : '隔离配置'}启动探活通过：http://127.0.0.1:${port}`);
    return { port };
  } catch (error) {
    throw new Error(`${error.message}\n${output.slice(-5000)}`);
  } finally {
    backend.killTree(child);
    if (staged) fs.rmSync(staged.stageRoot, { recursive: true, force: true });
  }
}

async function checkForUpdate(root, options = {}) {
  const release = await registry.latestOfficialRc(options);
  const current = layout.currentVersion(root);
  if (!current) throw new Error('无法读取当前 DSH 版本');
  return {
    current,
    latest: release.version,
    updateAvailable: semver.gt(release.version, current),
    release,
  };
}

async function applyUpdate(root, requestedVersion, options = {}) {
  const log = logger(options);
  const target = requireRc(requestedVersion);
  const release = options.release || await registry.latestOfficialRc(options);
  if (release.version !== target) throw new Error(`目标 ${target} 不是当前官方最新 RC ${release.version}`);
  const current = layout.currentVersion(root);
  if (!current) throw new Error('无法读取当前 DSH 版本');
  if (current === target && !options.force) return { changed: false, current, target };

  const initialState = layout.copyLegacyApp(root);
  const activeName = initialState.activeSlot;
  const inactiveName = activeName === 'a' ? 'b' : 'a';
  const activeSlot = layout.slotPath(root, activeName);
  const candidateSlot = layout.slotPath(root, inactiveName);
  const install = options.installCandidate || installCandidate;
  const pluginCheck = options.checkPlugins || checkPlugins;
  const probe = options.healthProbe || healthProbe;
  let switched = false;
  let backupRoot = null;

  try {
    const slotManifest = await install(root, activeSlot, candidateSlot, release, options);
    const plugins = await pluginCheck(root, candidateSlot, options);
    await probe(root, candidateSlot, { ...options, live: false });
    if (options.failAt === 'before-backup') throw new Error('测试注入：备份前失败');
    backupRoot = createBackup(root, target, options);
    if (typeof options.beforeSwitch === 'function') await options.beforeSwitch();
    layout.updateLaunchScript(root);
    log(`切换运行槽：slot-${activeName} -> slot-${inactiveName}`);
    layout.switchActiveSlot(root, inactiveName);
    switched = true;
    if (options.failAt === 'after-switch') throw new Error('测试注入：切槽后失败');
    await probe(root, candidateSlot, { ...options, live: true, port: backend.PORT });
    const state = layout.recordActive(root, inactiveName, target, {
      previousSlot: activeName,
      previousVersion: current,
      backup: backupRoot,
      npmIntegrity: release.integrity,
    });
    return { changed: true, current, target, activeSlot: inactiveName, backup: backupRoot, slotManifest, plugins, state };
  } catch (error) {
    const rollbackErrors = [];
    if (switched) {
      try {
        log(`自动切回 slot-${activeName}...`);
        layout.switchActiveSlot(root, activeName);
      } catch (rollbackError) {
        rollbackErrors.push(`切回旧槽失败：${rollbackError.message}`);
      }
    }
    if (backupRoot) {
      try { restoreBackup(root, backupRoot, options); }
      catch (rollbackError) { rollbackErrors.push(`恢复配置失败：${rollbackError.message}`); }
    }
    if (switched && !rollbackErrors.length) {
      try { await probe(root, activeSlot, { ...options, live: true, port: backend.PORT, rollback: true }); }
      catch (probeError) { rollbackErrors.push(`旧槽回滚探活失败：${probeError.message}`); }
    }
    layout.recordActive(root, activeName, current, {
      rollbackAt: new Date().toISOString(),
      failedTarget: target,
      backup: backupRoot || undefined,
    });
    const suffix = rollbackErrors.length
      ? `\n回滚异常：${rollbackErrors.join(' | ')}`
      : switched ? '\n已恢复旧槽与更新前配置。' : '\n活动槽未切换，当前 Harness 未受影响。';
    throw new Error(`更新 ${target} 失败：${error.message}${suffix}`);
  }
}

module.exports = {
  PLUGINS,
  SENSITIVE_FILE,
  timestamp,
  requireRc,
  copyTree,
  inventory,
  createBackup,
  restoreBackup,
  runCommand,
  dshFamilyFromLock,
  verifyExactFamily,
  buildCandidatePackage,
  installCandidate,
  resolvePluginRoot,
  checkPlugins,
  stageProbeHome,
  healthProbe,
  checkForUpdate,
  applyUpdate,
};
