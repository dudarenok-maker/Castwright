// Structural / activation invariants for the Pinokio launcher — the defense-in-depth
// net for the silent-activation bug class the pure-logic specs can't see.
//
// menu.test.js / resolve-release.test.js / write-env.test.js exercise pure
// functions; they never load the REAL root pinokio.js and never touch the
// on-disk layout. So the failures that got Castwright delisted twice all
// shipped green: the reserved 'pinokio' folder name and the stale '1.0' schema
// version (2026-07-11), and any future drift between a menu href and the script
// it points at. These tests load pinokio.js for real and assert the layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');

const LAUNCHER_DIR = path.resolve(__dirname, '..'); //         .../pinokio-scripts
const REPO_ROOT = path.resolve(__dirname, '..', '..'); //      repo root (holds pinokio.js)
const LAUNCHER_NAME = path.basename(LAUNCHER_DIR);

// Folder names the current Pinokio runtime reserves internally. A launcher
// subtree named one of these renders the Install screen but silently fails to
// auto-fire the default menu item on first activation (confirmed on-box
// 2026-07-11). Keep this list in sync if Pinokio frees 'pinokio' in a later release.
const RESERVED_DIR_NAMES = ['pinokio'];

// The script schema version every shipping Pinokio app declares (comfy /
// flux-webui / dia / forge). NOT the app release version — that lives in
// package.json. Bump deliberately here if Pinokio advances the schema.
const EXPECTED_SCHEMA_VERSION = '7.0';

const LIFECYCLE_SCRIPTS = ['install', 'start', 'stop', 'update', 'reset'];

// Every state pinokio.js's menu() branches on. stubInfo mirrors the three
// runtime accessors it reads (exists / running / local).
const STATES = [
  { installed: false, running: false, url: null },
  { installed: true, running: false, url: null },
  { installed: true, running: true, url: null }, // startup window: running, URL not captured yet
  { installed: true, running: true, url: 'http://localhost:8080' },
];
const stubInfo = (s) => ({
  exists: () => s.installed, // pinokio.js ANDs node_modules + server/.env
  running: () => s.running,
  local: () => (s.running ? { url: s.url } : null),
});

const app = require(path.join(REPO_ROOT, 'pinokio.js')); // also proves the require('./<launcher>/lib/menu.js') resolves

test('launcher folder is not a name Pinokio reserves internally', () => {
  assert.ok(
    !RESERVED_DIR_NAMES.includes(LAUNCHER_NAME),
    `launcher dir "${LAUNCHER_NAME}" is reserved by Pinokio — rename it (broke the Install button, 2026-07-11)`,
  );
});

test('pinokio.js declares the current Pinokio script schema version', () => {
  assert.equal(app.version, EXPECTED_SCHEMA_VERSION);
});

test('pinokio.js exposes the metadata + async menu Pinokio activates', () => {
  assert.equal(typeof app.title, 'string');
  assert.equal(typeof app.description, 'string');
  assert.equal(typeof app.icon, 'string');
  assert.equal(typeof app.menu, 'function');
});

test('every state yields a default item so the Install/Start auto-fires', async () => {
  for (const state of STATES) {
    const items = await app.menu({}, stubInfo(state));
    assert.ok(Array.isArray(items) && items.length > 0, `empty menu for ${JSON.stringify(state)}`);
    assert.ok(
      items.some((i) => i.default === true),
      `no default item for ${JSON.stringify(state)} — nothing auto-fires`,
    );
  }
});

test('every menu href pointing at a launcher script resolves to a real file', async () => {
  const scriptHrefs = new Set();
  for (const state of STATES) {
    for (const item of await app.menu({}, stubInfo(state))) {
      // skip the captured web-UI URL href; keep only local .js script paths
      if (typeof item.href === 'string' && item.href.endsWith('.js')) scriptHrefs.add(item.href);
    }
  }
  assert.ok(scriptHrefs.size > 0, 'expected at least one script href across states');
  for (const href of scriptHrefs) {
    assert.ok(
      href.startsWith(`${LAUNCHER_NAME}/`),
      `href "${href}" must live under the launcher dir "${LAUNCHER_NAME}/"`,
    );
    assert.ok(existsSync(path.join(REPO_ROOT, href)), `menu href points at a missing file: ${href}`);
  }
});

test('all five lifecycle scripts exist in the launcher dir', () => {
  for (const s of LIFECYCLE_SCRIPTS) {
    assert.ok(existsSync(path.join(LAUNCHER_DIR, `${s}.js`)), `missing ${LAUNCHER_NAME}/${s}.js`);
  }
});

test('icon path declared in pinokio.js resolves to a committed asset', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, app.icon)), `pinokio.js icon missing on disk: ${app.icon}`);
});
