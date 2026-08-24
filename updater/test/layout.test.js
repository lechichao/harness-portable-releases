'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const layout = require('../lib/layout');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test('legacy app is copied without switching, then runtime switches atomically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appModules = path.join(root, 'app', 'node_modules');
  writeJson(path.join(appModules, '@deepseek-ai', 'dsh', 'package.json'), { version: '0.1.1-rc.2' });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.symlinkSync(appModules, path.join(root, 'runtime', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  const state = layout.copyLegacyApp(root);
  assert.equal(state.activeSlot, 'a');
  assert.equal(fs.realpathSync(path.join(root, 'runtime', 'node_modules')), fs.realpathSync(appModules));

  const slotBModules = path.join(layout.slotPath(root, 'b'), 'node_modules');
  writeJson(path.join(slotBModules, '@deepseek-ai', 'dsh', 'package.json'), { version: '0.1.2-rc.1' });
  layout.switchActiveSlot(root, 'b');
  assert.equal(fs.realpathSync(path.join(root, 'runtime', 'node_modules')), fs.realpathSync(slotBModules));
});

test('removeManagedSlot refuses paths outside updater slots', () => {
  assert.throws(() => layout.removeManagedSlot('C:\\fixture', 'C:\\fixture'), /拒绝操作非托管槽位/);
});
