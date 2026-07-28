// Runs under `npm run test:hooks` (node --test over scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve relative to THIS file, not the process cwd — `node --test` can be
// invoked from a different working directory than the repo root (e.g. a
// worktree helper, or an editor's test runner), and a bare relative path
// would then silently read the wrong file or throw ENOENT.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'run-golden-audio.mjs');
const src = readFileSync(SRC_PATH, 'utf8');

// The exact non-leaking shape both Suite calls must use: `undefined` (not
// `{}`) on the non-bless arm, so `run()`'s `{ ...process.env, ...env }`
// spread actually clears an ambient GOLDEN_BLESS instead of leaving it to
// leak through. Anchored on the `'1'` / `undefined` ORDER, so an inverted
// ternary (`bless ? undefined : '1'`) fails this regex — it would silently
// bless on every non-bless run and assert on every bless run.
const BLESS_ENV_SHAPE = /GOLDEN_BLESS:\s*bless\s*\?\s*'1'\s*:\s*undefined/;

test('Suite B clears GOLDEN_BLESS (not leaves it ambient) on the non-bless path', () => {
  const suiteB = src.slice(src.indexOf("run('assembly (Suite B)'"));
  const call = suiteB.slice(0, suiteB.indexOf('\n}'));
  assert.match(
    call,
    BLESS_ENV_SHAPE,
    'Suite B run() must set GOLDEN_BLESS to exactly `1` when blessing and ' +
      '`undefined` (which clears an ambient value) otherwise — an inverted ' +
      'ternary must fail this test',
  );
});

test('Suite A clears GOLDEN_BLESS (not leaves it ambient) on the non-bless path', () => {
  const suiteA = src.slice(src.indexOf("run(\n    'sidecar (Suite A)'"));
  assert.match(
    suiteA,
    BLESS_ENV_SHAPE,
    'Suite A run() must set GOLDEN_BLESS to exactly `1` when blessing and ' +
      '`undefined` (which clears an ambient value) otherwise — an inverted ' +
      'ternary must fail this test',
  );
});

test('the header documents that --bless follows suite selection', () => {
  assert.match(src, /--bless[\s\S]{0,400}suite selection/i);
});
