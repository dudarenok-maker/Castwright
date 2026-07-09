import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// pinokio.js sits at the repo root and MUST be genuine CommonJS: Pinokio's
// own kernel loads app scripts via a plain synchronous `require(filepath)`
// (pinokiocomputer/pinokiod kernel/loader.js `requireJS`) — it cannot load an
// ES module. This test uses require(), via createRequire, to reproduce
// Pinokio's actual loading mechanism rather than dynamic import() (which
// would mask a "genuine ESM under require()" regression). See
// docs/features/218-pinokio-installer.md.
const require = createRequire(import.meta.url);

test('pinokio.js require()s cleanly and matches Pinokio\'s expected shape', () => {
  delete require.cache[require.resolve('../../pinokio.js')];
  const config = require('../../pinokio.js');
  assert.equal(typeof config, 'object');
  assert.equal(config.title, 'Castwright');
  assert.equal(typeof config.menu, 'function');
});

test('pinokio.js menu() delegates to buildMenu with derived state', async () => {
  delete require.cache[require.resolve('../../pinokio.js')];
  const config = require('../../pinokio.js');
  const info = {
    exists: () => true,
    running: () => false,
    local: () => null,
  };
  const items = await config.menu({}, info);
  assert.deepEqual(
    items.map((i) => i.text),
    ['Start', 'Update', 'Reset'],
  );
});
