import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MANIFEST, stagingPlan, mirrorPlan } from '../stage-marketing-screenshots.mjs';

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

test('mirrorPlan converts every capture under its own raw name, no renaming', () => {
  const plan = mirrorPlan(
    ['cast-reuse.desktop.dark.png', 'listen.phone.light.png', 'listen.tablet.dark.png'],
    '/src',
    '/dest',
  );
  assert.deepEqual(plan, [
    { src: path.join('/src', 'cast-reuse.desktop.dark.png'), dest: path.join('/dest', 'cast-reuse.desktop.dark.webp') },
    { src: path.join('/src', 'listen.phone.light.png'), dest: path.join('/dest', 'listen.phone.light.webp') },
    { src: path.join('/src', 'listen.tablet.dark.png'), dest: path.join('/dest', 'listen.tablet.dark.webp') },
  ]);
});

test('mirrorPlan ignores anything that is not a <scene>.<viewport>.<theme>.png capture', () => {
  // The source dir also accumulates subfolders, non-captures and stray files;
  // feeding those to ffmpeg would produce garbage webp or a red run.
  const plan = mirrorPlan(
    [
      'README.md',
      'companion', // a directory
      'cast-reuse.desktop.dark.png.bak',
      'cast-reuse.desktop.png', // no theme segment
      'cast-reuse.watch.dark.png', // unknown viewport
      'cast-reuse.desktop.sepia.png', // unknown theme
      'cast-reuse.desktop.dark.webp', // already converted
      'cast-reuse.desktop.dark.png', // the only real capture here
    ],
    '/src',
    '/dest',
  );
  assert.deepEqual(
    plan.map((p) => path.basename(p.dest)),
    ['cast-reuse.desktop.dark.webp'],
  );
});

test('the mirror never collides with a curated destination name', () => {
  /* The curated set writes `<output>.webp`; the mirror writes
     `<scene>.<viewport>.<theme>.webp`. If a manifest entry were ever named so
     its output equalled a raw capture stem, both would claim one path and the
     encodes would race. main() dedupes, but the two naming schemes should not
     overlap in the first place — assert that on the real manifest. */
  const curated = new Set(stagingPlan(MANIFEST, '/src', '/dest').map((p) => p.dest));
  const mirrored = mirrorPlan(
    MANIFEST.flatMap((e) =>
      (e.themes ?? ['light', 'dark']).map((t) => `${e.scene}.${e.viewport}.${t}.png`),
    ),
    '/src',
    '/dest',
  ).map((p) => p.dest);
  for (const dest of mirrored) {
    assert.ok(!curated.has(dest), `mirror name ${path.basename(dest)} collides with a curated output`);
  }
});

test('the manifest stages the exported series cast card, dark-only', () => {
  const entry = MANIFEST.find((e) => e.scene === 'series-cast-card-export');
  assert.ok(entry, 'manifest is missing the series-cast-card-export entry');
  assert.deepEqual(entry.themes, ['dark']);
  assert.equal(entry.output, 'series-cast-card');
});
