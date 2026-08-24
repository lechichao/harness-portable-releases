'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const backend = require('../lib/backend');

test('sanitizedEnv removes secret-like environment variable names', () => {
  const previous = process.env.MY_TEST_API_KEY;
  process.env.MY_TEST_API_KEY = 'placeholder-value';
  try {
    const env = backend.sanitizedEnv('C:\\fixture', { DSH_HOME: 'C:\\probe' });
    assert.equal(env.MY_TEST_API_KEY, undefined);
    assert.equal(env.DSH_HOME, 'C:\\probe');
  } finally {
    if (previous === undefined) delete process.env.MY_TEST_API_KEY;
    else process.env.MY_TEST_API_KEY = previous;
  }
});
