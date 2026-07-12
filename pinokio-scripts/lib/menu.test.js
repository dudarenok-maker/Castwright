const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildMenu = require('./menu.js');

const hrefs = (items) => items.map((i) => i.href);
const texts = (items) => items.map((i) => i.text);

test('not installed → only Install (primary, with icon)', () => {
  const items = buildMenu({ installed: false, running: false, url: null });
  assert.deepEqual(hrefs(items), ['pinokio-scripts/install.js']);
  assert.equal(items[0].text, 'Install');
  assert.equal(items[0].default, true);
  assert.match(items[0].icon, /^fa-/);
});

test('installed + stopped → Start (primary), Update, Reset (in order)', () => {
  const items = buildMenu({ installed: true, running: false, url: null });
  assert.deepEqual(texts(items), ['Start', 'Update', 'Reset']);
  assert.deepEqual(hrefs(items), ['pinokio-scripts/start.js', 'pinokio-scripts/update.js', 'pinokio-scripts/reset.js']);
  assert.equal(items[0].default, true);
  // Reset is destructive (wipes node_modules/venv/dist) — must confirm, like every shipping app.
  const reset = items.find((i) => i.text === 'Reset');
  assert.equal(typeof reset.confirm, 'string');
  assert.ok(reset.confirm.length > 0);
});

test('installed + running + url → Open Web UI (primary, url), Terminal, Stop', () => {
  const items = buildMenu({ installed: true, running: true, url: 'http://localhost:8080' });
  assert.deepEqual(texts(items), ['Open Web UI', 'Terminal', 'Stop']);
  assert.equal(items[0].href, 'http://localhost:8080');
  assert.equal(items[0].default, true);
  assert.equal(items[1].href, 'pinokio-scripts/start.js'); // Terminal = the running daemon
  assert.equal(items[2].href, 'pinokio-scripts/stop.js');
});

test('installed + running, url not captured yet → Terminal (primary), Stop — never a null-href Open Web UI', () => {
  const items = buildMenu({ installed: true, running: true, url: null });
  assert.deepEqual(texts(items), ['Terminal', 'Stop']);
  assert.equal(items[0].default, true);
  assert.equal(items[0].href, 'pinokio-scripts/start.js');
  // The regression guard: no dead Open Web UI tab during the 1-2 min startup window.
  assert.ok(!items.some((i) => i.text === 'Open Web UI'), 'must not show Open Web UI before url is captured');
  assert.ok(!items.some((i) => i.href == null), 'no menu item may have a null href');
});
