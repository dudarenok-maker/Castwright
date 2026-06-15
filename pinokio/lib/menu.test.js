const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildMenu = require('./menu.js');

const hrefs = (items) => items.map((i) => i.href);
const texts = (items) => items.map((i) => i.text);

test('not installed → only Install (primary, with icon)', () => {
  const items = buildMenu({ installed: false, running: false, url: null });
  assert.deepEqual(hrefs(items), ['pinokio/install.js']);
  assert.equal(items[0].text, 'Install');
  assert.equal(items[0].default, true);
  assert.match(items[0].icon, /^fa-/);
});

test('installed + stopped → Start (primary), Update, Reset (in order)', () => {
  const items = buildMenu({ installed: true, running: false, url: null });
  assert.deepEqual(texts(items), ['Start', 'Update', 'Reset']);
  assert.deepEqual(hrefs(items), ['pinokio/start.js', 'pinokio/update.js', 'pinokio/reset.js']);
  assert.equal(items[0].default, true);
});

test('installed + running → Open Web UI (primary, url), Stop, Update, Reset', () => {
  const items = buildMenu({ installed: true, running: true, url: 'http://localhost:8080' });
  assert.deepEqual(texts(items), ['Open Web UI', 'Stop', 'Update', 'Reset']);
  assert.equal(items[0].href, 'http://localhost:8080');
  assert.equal(items[0].default, true);
  assert.equal(items[1].href, 'pinokio/stop.js');
});
