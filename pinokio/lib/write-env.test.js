const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEnvContents } = require('./write-env.js');

const EXAMPLE = [
  '# comment',
  'PORT=8080',
  'WORKSPACE_DIR=../audiobook-workspace',
  'OTHER=keep-me',
].join('\n');

test('returns null when .env already exists (idempotent)', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, appDir: '/app', envExists: true });
  assert.equal(out, null);
});

test('rewrites only the WORKSPACE_DIR line, preserves the rest', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, appDir: '/app', envExists: false });
  assert.match(out, /^WORKSPACE_DIR=\/app\/workspace$/m);
  assert.match(out, /^PORT=8080$/m);
  assert.match(out, /^OTHER=keep-me$/m);
  assert.equal((out.match(/^WORKSPACE_DIR=/gm) || []).length, 1);
});
