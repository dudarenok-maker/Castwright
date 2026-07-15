const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEnvContents,
  defaultLibraryDir,
  chooseFreshWorkspaceDir,
} = require('./write-env.js');

const EXAMPLE = ['# comment', 'PORT=8080', 'WORKSPACE_DIR=../audiobook-workspace', 'OTHER=keep-me'].join('\n');

test('defaultLibraryDir: absolute homedir -> <home>/Castwright', () => {
  assert.equal(defaultLibraryDir('/home/me'), require('node:path').join('/home/me', 'Castwright'));
});
test('defaultLibraryDir: empty/relative homedir -> null', () => {
  assert.equal(defaultLibraryDir(''), null);
  assert.equal(defaultLibraryDir('relative/dir'), null);
});

test('chooseFreshWorkspaceDir: fresh install, usable home -> <home>/Castwright', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '/home/me', workspaceExists: false });
  assert.equal(out, require('node:path').join('/home/me', 'Castwright'));
});
test('chooseFreshWorkspaceDir: existing <appDir>/workspace -> keep it (migration guard)', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '/home/me', workspaceExists: true });
  assert.equal(out, '/app/workspace');
});
test('chooseFreshWorkspaceDir: unusable home -> install-local fallback', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '', workspaceExists: false });
  assert.equal(out, '/app/workspace');
});

test('buildEnvContents: returns null when .env exists (idempotent)', () => {
  assert.equal(buildEnvContents({ exampleText: EXAMPLE, workspaceDir: '/x', envExists: true }), null);
});
test('buildEnvContents: rewrites only the WORKSPACE_DIR line', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, workspaceDir: '/home/me/Castwright', envExists: false });
  assert.match(out, /^WORKSPACE_DIR=\/home\/me\/Castwright$/m);
  assert.match(out, /^PORT=8080$/m);
  assert.match(out, /^OTHER=keep-me$/m);
  assert.equal((out.match(/^WORKSPACE_DIR=/gm) || []).length, 1);
});
