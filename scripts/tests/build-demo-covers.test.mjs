import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { coverTargets, COVER_WIDTH } from '../build-demo-covers.mjs';

test('coverTargets maps the four bookIds to matching src/out basenames', () => {
  const targets = coverTargets('/src', '/out');
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((t) => t.id).sort(),
    ['coalfall-commission', 'hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3'],
  );
  for (const t of targets) {
    assert.equal(basename(t.src), `${t.id}.png`);
    assert.equal(basename(t.out), `${t.id}.png`);
  }
});

test('COVER_WIDTH is a small display size', () => {
  assert.ok(COVER_WIDTH > 0 && COVER_WIDTH <= 600);
});
