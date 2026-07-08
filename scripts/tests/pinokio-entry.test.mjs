import { test } from 'node:test';
import assert from 'node:assert/strict';

// pinokio.js sits at the repo root, so it is loaded under the root
// package.json's "type": "module". Pinokio's own runtime dynamically
// imports it in-process (not spawned as a subprocess), so it must be valid
// ESM — CommonJS globals (require/__dirname/module) throw a ReferenceError
// at import time under type:module. See docs/features/218-pinokio-installer.md.
test('pinokio.js loads as ESM without a CommonJS-global ReferenceError', async () => {
  const mod = await import('../../pinokio.js');
  assert.equal(typeof mod.default, 'object');
  assert.equal(mod.default.title, 'Castwright');
  assert.equal(typeof mod.default.menu, 'function');
});

test('pinokio.js menu() delegates to buildMenu with derived state', async () => {
  const mod = await import('../../pinokio.js');
  const info = {
    exists: () => true,
    running: () => false,
    local: () => null,
  };
  const items = await mod.default.menu({}, info);
  assert.deepEqual(
    items.map((i) => i.text),
    ['Start', 'Update', 'Reset'],
  );
});
