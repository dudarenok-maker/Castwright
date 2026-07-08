import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MANIFEST, stagingPlan } from '../stage-marketing-screenshots.mjs';

test('stagingPlan produces one light + one dark pair per manifest entry', () => {
  const plan = stagingPlan(MANIFEST, '/src', '/dest');
  assert.equal(plan.length, MANIFEST.length * 2);
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
