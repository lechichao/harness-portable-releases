'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const layout = require('../lib/layout');
const update = require('../lib/update');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const modules = path.join(app, 'node_modules');
  writeJson(path.join(app, 'package.json'), { name: 'app', private: true, dependencies: { '@deepseek-ai/dsh': '0.1.1-rc.2' } });
  writeJson(path.join(app, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      'node_modules/@deepseek-ai/dsh': { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', integrity: 'sha512-old' },
      'node_modules/@deepseek-ai/dsh-fs': { name: '@deepseek-ai/dsh-fs', version: '0.1.1-rc.2', integrity: 'sha512-old-fs' },
    },
  });
  writeJson(path.join(modules, '@deepseek-ai', 'dsh', 'package.json'), { version: '0.1.1-rc.2' });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.symlinkSync(modules, path.join(root, 'runtime', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'data', 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), 'provider: placeholder');
  fs.writeFileSync(path.join(root, 'data', 'profiles', 'web', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'data', 'profiles', 'settings.yaml'), 'excluded: true');
  fs.writeFileSync(path.join(root, 'data', 'profiles', '.credentials.yaml'), 'excluded: true');
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desktop', 'main.js'), 'module.exports = {}');
  return root;
}

test('requireRc rejects stable and malformed targets', () => {
  assert.equal(update.requireRc('0.1.1-rc.2'), '0.1.1-rc.2');
  assert.throws(() => update.requireRc('0.1.1'), /不是官方 RC/);
  assert.throws(() => update.requireRc('latest'), /非法目标版本/);
});

test('exact family verification rejects a mismatched family and integrity', (t) => {
  const root = fixture(t);
  assert.throws(
    () => update.verifyExactFamily(path.join(root, 'app'), { version: '0.1.1-rc.3', integrity: 'sha512-new' }),
    /混入非目标/,
  );
  assert.throws(
    () => update.verifyExactFamily(path.join(root, 'app'), { version: '0.1.1-rc.2', integrity: 'sha512-wrong' }),
    /完整性摘要/,
  );
});

test('candidate package pins direct and transitive DSH family packages', (t) => {
  const root = fixture(t);
  const candidate = update.buildCandidatePackage(path.join(root, 'app'), '0.1.1-rc.3');
  assert.equal(candidate.dependencies['@deepseek-ai/dsh'], '0.1.1-rc.3');
  assert.equal(candidate.overrides['@deepseek-ai/dsh'], '0.1.1-rc.3');
  assert.equal(candidate.overrides['@deepseek-ai/dsh-fs'], '0.1.1-rc.3');
});

test('isolated probe home excludes settings and credential files', (t) => {
  const root = fixture(t);
  const candidate = path.join(root, 'candidate');
  for (const name of update.PLUGINS) fs.mkdirSync(path.join(candidate, 'node_modules', name), { recursive: true });
  const staged = update.stageProbeHome(root, candidate);
  t.after(() => fs.rmSync(staged.stageRoot, { recursive: true, force: true }));
  assert.ok(fs.existsSync(path.join(staged.stageData, 'profiles', 'web', 'package.json')));
  assert.ok(!fs.existsSync(path.join(staged.stageData, 'profiles', 'settings.yaml')));
  assert.ok(!fs.existsSync(path.join(staged.stageData, 'profiles', '.credentials.yaml')));
  assert.ok(!fs.existsSync(path.join(staged.stageData, 'settings.yaml')));
});

test('all three local plugins pass peer, injection, syntax, and import checks', async (t) => {
  const root = fixture(t);
  const candidate = path.join(root, 'candidate');
  for (const [name, version] of [['peer-x', '1.2.0'], ['inject-x', '3.0.0']]) {
    writeJson(path.join(candidate, 'node_modules', name, 'package.json'), { name, version });
  }
  for (const name of update.PLUGINS) {
    const pluginRoot = path.join(root, 'plugins', name);
    writeJson(path.join(pluginRoot, 'package.json'), {
      name,
      version: '1.0.0',
      type: 'module',
      main: 'lib/index.js',
      peerDependencies: { 'peer-x': '^1.0.0' },
      dsh: { client: { inject: ['inject-x'] } },
    });
    fs.mkdirSync(path.join(pluginRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'export default {};\n');
    fs.writeFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'export const client = true;\n');
  }
  const reports = await update.checkPlugins(root, candidate);
  assert.deepEqual(reports.map((item) => item.name), update.PLUGINS);
  assert.ok(reports.every((item) => item.passed));
});

test('failure after switching restores the old slot and local configuration', async (t) => {
  const root = fixture(t);
  const release = {
    version: '0.1.1-rc.3',
    integrity: 'sha512-new',
    shasum: null,
    source: 'official-test',
  };
  const installCandidate = async (_root, _active, candidate) => {
    writeJson(path.join(candidate, 'package.json'), { name: 'candidate' });
    writeJson(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), { version: release.version });
    return { version: release.version };
  };
  await assert.rejects(
    update.applyUpdate(root, release.version, {
      release,
      installCandidate,
      checkPlugins: async () => update.PLUGINS.map((name) => ({ name, passed: true })),
      healthProbe: async () => ({ port: 12345 }),
      beforeSwitch: async () => fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), 'changed: true'),
      failAt: 'after-switch',
    }),
    /已恢复旧槽与更新前配置/,
  );
  const activeModules = path.join(root, 'runtime', 'node_modules');
  assert.equal(fs.realpathSync(activeModules), fs.realpathSync(path.join(layout.slotPath(root, 'a'), 'node_modules')));
  assert.equal(fs.readFileSync(path.join(root, 'data', 'settings.yaml'), 'utf8'), 'provider: placeholder');
  assert.equal(layout.readState(root).activeSlot, 'a');
});
