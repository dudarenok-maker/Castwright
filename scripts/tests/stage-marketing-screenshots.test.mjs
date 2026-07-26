import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MANIFEST, stagingPlan } from '../stage-marketing-screenshots.mjs';

test('stagingPlan produces one file per theme per manifest entry (a pair by default)', () => {
  const plan = stagingPlan(MANIFEST, '/src', '/dest');
  const expected = MANIFEST.reduce((n, e) => n + (e.themes?.length ?? 2), 0);
  assert.equal(plan.length, expected);
});

test('stagingPlan maps a scene id + viewport to the correct source path and output filename', () => {
  const plan = stagingPlan(
    [{ output: 'library', scene: 'library-shelf', viewport: 'desktop' }],
    '/src',
    '/dest',
  );
  assert.deepEqual(plan, [
    {
      src: path.join('/src', 'library-shelf.desktop.light.png'),
      dest: path.join('/dest', 'library.webp'),
    },
    {
      src: path.join('/src', 'library-shelf.desktop.dark.png'),
      dest: path.join('/dest', 'library-dark.webp'),
    },
  ]);
});

test('the manifest has an entry for every scene this pass captures for the four approved stories (3 pre-existing, re-captured only + 5 brand-new from Task 4 + 2 language scenes, re-captured only)', () => {
  const storySceneIds = [
    'chapter-suspect',
    'voice-drift-report',
    'preview-flagged',
    'qa-report-card',
    'language-detect-russian',
    'language-cast-confirm-german',
    'manuscript-emotion-direction',
    'cast-pin-higher-quality',
    'series-memory-reveal',
    'series-share-card',
  ];
  for (const id of storySceneIds) {
    assert.ok(
      MANIFEST.some((e) => e.scene === id),
      `manifest is missing an entry for scene "${id}"`,
    );
  }
});

test('the manifest has no duplicate output names', () => {
  const outputs = MANIFEST.map((e) => e.output);
  assert.equal(new Set(outputs).size, outputs.length);
});

test('a single-theme entry stages one file and drops the -dark suffix', () => {
  const plan = stagingPlan(
    [{ output: 'series-cast-card', scene: 'series-cast-card-export', viewport: 'desktop', themes: ['dark'] }],
    '/src',
    '/dest',
  );
  // The file is the only variant, not the dark half of a pair, so it must not be
  // named `-dark` — a consumer embedding it shouldn't need to know which theme
  // produced it.
  assert.deepEqual(plan, [
    {
      src: path.join('/src', 'series-cast-card-export.desktop.dark.png'),
      dest: path.join('/dest', 'series-cast-card.webp'),
    },
  ]);
});

test('a single-theme entry does not make main() count a permanently missing source', () => {
  // main() sets a non-zero exit code on ANY missing source, so a dark-only entry
  // that still planned a light file would leave `stage:marketing-screenshots` red
  // forever. Planning exactly the themes that exist is what prevents that.
  const plan = stagingPlan(
    [{ output: 'x', scene: 's', viewport: 'desktop', themes: ['dark'] }],
    '/src',
    '/dest',
  );
  assert.equal(
    plan.filter((p) => p.src.includes('.light.')).length,
    0,
    'a dark-only entry must not plan a light source it can never find',
  );
});

test('no two manifest entries stage to the same destination file', () => {
  // Dropping the theme suffix for single-theme entries opens a collision the
  // output-name check above can't see: a dark-only `foo` and a paired `foo`
  // would both claim foo.webp. Assert on the resolved plan, not the manifest.
  const dests = stagingPlan(MANIFEST, '/src', '/dest').map((p) => p.dest);
  assert.equal(new Set(dests).size, dests.length);
});

test('the manifest stages the exported series cast card, dark-only', () => {
  const entry = MANIFEST.find((e) => e.scene === 'series-cast-card-export');
  assert.ok(entry, 'manifest is missing the series-cast-card-export entry');
  assert.deepEqual(entry.themes, ['dark']);
  assert.equal(entry.output, 'series-cast-card');
});
