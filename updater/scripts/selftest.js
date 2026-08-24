'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const registry = require('../lib/registry');
const update = require('../lib/update');

const version = '0.1.1-rc.2';
const selected = registry.selectLatestRc({
  name: registry.PACKAGE_NAME,
  versions: {
    [version]: {
      name: registry.PACKAGE_NAME,
      version,
      dist: { integrity: 'sha512-placeholder', tarball: 'https://registry.npmjs.org/example.tgz' },
    },
  },
  time: { [version]: new Date().toISOString() },
});
assert.equal(selected.version, version);
assert.equal(update.requireRc(version), version);
assert.equal(path.basename(require.resolve('../lib/update')), 'update.js');
console.log('safe updater self-test passed');
