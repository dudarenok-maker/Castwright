/* Guards the single-source-of-truth invariant for the dialogue-tag verb list.

   The canonical list lives in server/src/analyzer/dialogue-verbs.ts (imported by
   the TS roster-coverage guard). scripts/recover-missing-character.mjs carries a
   literal copy because it runs under plain `node` and can't import the `.ts`.
   This test fails if the two ever diverge — edit both together. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIALOGUE_VERBS as MJS_VERBS } from '../recover-missing-character.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/** Extract the quoted string literals from the `DIALOGUE_VERBS` array in the
    canonical TS module, without importing TypeScript. */
function readCanonicalVerbs() {
  const src = readFileSync(
    join(repoRoot, 'server', 'src', 'analyzer', 'dialogue-verbs.ts'),
    'utf8',
  );
  const m = src.match(/DIALOGUE_VERBS[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'could not locate DIALOGUE_VERBS array in dialogue-verbs.ts');
  const withoutComments = m[1].replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('the .mjs verb list matches the canonical TS list (no drift)', () => {
  const canonical = readCanonicalVerbs();
  const mjs = [...MJS_VERBS];
  assert.deepEqual(
    [...new Set(mjs)].sort(),
    [...new Set(canonical)].sort(),
    'recover-missing-character.mjs DIALOGUE_VERBS drifted from server/src/analyzer/dialogue-verbs.ts — edit both.',
  );
});

test('the verb list has no accidental duplicates', () => {
  const mjs = [...MJS_VERBS];
  assert.equal(mjs.length, new Set(mjs).size, 'duplicate verb in .mjs list');
  const canonical = readCanonicalVerbs();
  assert.equal(canonical.length, new Set(canonical).size, 'duplicate verb in TS list');
});

test('Lessom/ch19 regression: the tags that were dropped are now covered', () => {
  // The The Drowning Bell ch19 bug: these tags existed in the prose but the verbs
  // weren't all in the list, contributing to Lessom being missed.
  for (const v of ['repeated', 'agreed', 'asked', 'said', 'reminded']) {
    assert.ok(MJS_VERBS.includes(v), `expected dialogue verb "${v}" in the list`);
  }
});
