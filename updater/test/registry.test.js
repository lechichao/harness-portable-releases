'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../lib/registry');

function manifest(version, integrity = `sha512-${version}`) {
  return {
    name: registry.PACKAGE_NAME,
    version,
    dist: { integrity, tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz` },
  };
}

test('selectLatestRc chooses the highest published RC and ignores dist-tags', () => {
  const packument = {
    name: registry.PACKAGE_NAME,
    'dist-tags': { latest: '0.1.0-rc.1' },
    versions: {
      '0.1.0-rc.1': manifest('0.1.0-rc.1'),
      '0.1.1-rc.2': manifest('0.1.1-rc.2'),
      '0.2.0-rc.1': manifest('0.2.0-rc.1'),
      '1.0.0': manifest('1.0.0'),
      '9.0.0-rc.9': manifest('9.0.0-rc.9'),
    },
    time: {
      '0.1.0-rc.1': '2026-01-01T00:00:00Z',
      '0.1.1-rc.2': '2026-02-01T00:00:00Z',
      '0.2.0-rc.1': '2026-03-01T00:00:00Z',
      '1.0.0': '2026-04-01T00:00:00Z',
    },
  };
  assert.equal(registry.selectLatestRc(packument).version, '0.2.0-rc.1');
});

test('selectLatestRc requires an official integrity digest and tarball', () => {
  const packument = {
    name: registry.PACKAGE_NAME,
    versions: { '0.1.1-rc.2': { name: registry.PACKAGE_NAME, version: '0.1.1-rc.2', dist: {} } },
    time: { '0.1.1-rc.2': '2026-02-01T00:00:00Z' },
  };
  assert.throws(() => registry.selectLatestRc(packument), /完整性摘要/);
});
