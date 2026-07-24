import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { coverTargets, COVER_WIDTH } from '../build-demo-covers.mjs';

const DEMO_COVERS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/android/assets/demo-covers',
);

const sha256 = (relPath) =>
  createHash('sha256').update(readFileSync(resolve(DEMO_COVERS_DIR, relPath))).digest('hex');

// Regression guard for issue #1792: the committed hollow-tide-2 / hollow-tide-3
// demo covers were SWAPPED — hollow-tide-2.png (mapped to "The Tidewatcher's
// Oath" in demo_data.dart) held the Saltgrave artwork and vice versa. Filenames
// were correct, so the existing filename-mapping test could not see it; only the
// image *bytes* were wrong. These blessed digests pin the corrected art so a
// re-swap fails here instead of shipping to the demo library. If you ever
// intentionally re-render these two covers, re-bless the digests below AND
// eyeball the art against the titles.
const BLESSED = {
  // The Tidewatcher's Oath
  'hollow-tide-2.png': '3844b53265221ca267eeb5347793a2b9757c0f81e7860318c84332a4a02e3892',
  // Saltgrave
  'hollow-tide-3.png': '727fe6472d8b255ecb5d75dfc8dde9c4872c1799060f0e718b38e74384898f2a',
};

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

test('committed Hollow Tide covers are not swapped (regression: #1792)', () => {
  for (const [file, digest] of Object.entries(BLESSED)) {
    assert.equal(
      sha256(file),
      digest,
      `${file} content changed — if this was a re-swap it must be reverted; ` +
        `if it was an intentional re-render, re-bless the digest and check the art matches the title`,
    );
  }
});
