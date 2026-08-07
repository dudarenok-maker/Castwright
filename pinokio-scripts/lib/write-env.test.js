const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  buildEnvContents,
  defaultLibraryDir,
  chooseFreshWorkspaceDir,
} = require('./write-env.js');

const REAL_ENV_EXAMPLE_PATH = resolve(__dirname, '..', '..', 'server', '.env.example');

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

/* #2179 — the generated config-knob block now ships every line COMMENTED
   (`# KEY=default`), but buildEnvContents' WORKSPACE_DIR replace regex
   (`/^WORKSPACE_DIR=.*$/m`) only matches an ACTIVE line — `^` anchors to
   line-start, so `# WORKSPACE_DIR=...` can never match. WORKSPACE_DIR is
   hand-authored ABOVE the generated block specifically so it stays outside
   the emitter's sweep. These two tests pin that against the REAL shipped
   file (not the synthetic EXAMPLE fixture above) so a future emitter change
   that widened its sweep to include WORKSPACE_DIR would fail loudly here
   instead of silently shipping every Pinokio install the literal
   placeholder `../audiobook-workspace` path. */
test('server/.env.example: WORKSPACE_DIR ships as an ACTIVE assignment, not swept into the generated commented block', () => {
  const real = readFileSync(REAL_ENV_EXAMPLE_PATH, 'utf8');
  assert.match(real, /^WORKSPACE_DIR=/m);
  assert.doesNotMatch(real, /^# WORKSPACE_DIR=/m);
});

test('buildEnvContents against the REAL server/.env.example still rewrites WORKSPACE_DIR', () => {
  const real = readFileSync(REAL_ENV_EXAMPLE_PATH, 'utf8');
  const out = buildEnvContents({ exampleText: real, workspaceDir: '/home/me/Castwright', envExists: false });
  assert.match(out, /^WORKSPACE_DIR=\/home\/me\/Castwright$/m);
  assert.equal((out.match(/^WORKSPACE_DIR=/gm) || []).length, 1);
});
