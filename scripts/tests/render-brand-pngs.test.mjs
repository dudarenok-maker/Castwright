import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOBS } from '../render-brand-pngs.mjs';
// Namespace import for the symbol added in Task 3: before it's exported,
// `brandPngs.IOS_JOBS` is `undefined` (a clean assertion failure) rather than an
// ESM module-load error that would crash the whole file.
import * as brandPngs from '../render-brand-pngs.mjs';

// fe-37: the small-size favicons are hand-designed and committed in public/.
// The render script must NOT regenerate them, or a re-run would clobber the
// designer's files. These tests pin that invariant.

test('render-brand-pngs does not render the hand-designed favicons (no clobber)', () => {
  const outs = JOBS.map((j) => j[0]);
  assert.ok(!outs.includes('public/favicon-16.png'), 'favicon-16.png must stay hand-designed');
  assert.ok(!outs.includes('public/favicon-32.png'), 'favicon-32.png must stay hand-designed');
  assert.ok(!outs.includes('public/favicon.svg'), 'favicon.svg must stay hand-designed');
});

test('render-brand-pngs still renders og.png and the full-mark icons', () => {
  const outs = JOBS.map((j) => j[0]);
  assert.ok(outs.includes('public/og.png'), 'og.png is still script-rendered from the OG master');
  assert.ok(outs.includes('public/icon-512.png'));
  assert.ok(outs.includes('public/apple-touch-icon.png'));
});

// app-15: the iOS AppIcon set is rendered square + opaque (no alpha, no rounded
// corners — iOS applies its own mask) from the same brand icon master.
const IOS_DIR = 'apps/android/ios/Runner/Assets.xcassets/AppIcon.appiconset';
const EXPECTED_IOS = [
  ['Icon-App-20x20@1x.png', 20],
  ['Icon-App-20x20@2x.png', 40],
  ['Icon-App-20x20@3x.png', 60],
  ['Icon-App-29x29@1x.png', 29],
  ['Icon-App-29x29@2x.png', 58],
  ['Icon-App-29x29@3x.png', 87],
  ['Icon-App-40x40@1x.png', 40],
  ['Icon-App-40x40@2x.png', 80],
  ['Icon-App-40x40@3x.png', 120],
  ['Icon-App-60x60@2x.png', 120],
  ['Icon-App-60x60@3x.png', 180],
  ['Icon-App-76x76@1x.png', 76],
  ['Icon-App-76x76@2x.png', 152],
  ['Icon-App-83.5x83.5@2x.png', 167],
  ['Icon-App-1024x1024@1x.png', 1024],
];

test('IOS_JOBS covers every AppIcon size, each square + opaque', () => {
  assert.ok(Array.isArray(brandPngs.IOS_JOBS), 'IOS_JOBS must be exported');
  assert.equal(brandPngs.IOS_JOBS.length, EXPECTED_IOS.length, 'one job per AppIcon file');
  for (const [file, px] of EXPECTED_IOS) {
    const job = brandPngs.IOS_JOBS.find((j) => j[0] === `${IOS_DIR}/${file}`);
    assert.ok(job, `missing iOS job for ${file}`);
    const [, , w, h, omit, transform] = job;
    assert.equal(w, px, `${file} width`);
    assert.equal(h, px, `${file} height`);
    assert.equal(omit, false, `${file} must be opaque — iOS rejects an alpha channel`);
    assert.equal(typeof transform, 'function', `${file} needs the square-corner transform`);
    assert.ok(transform('<rect rx="118"/>').includes('rx="0"'), 'transform squares the corners');
  }
});

test('iOS jobs never clobber the hand-designed favicons', () => {
  const ios = brandPngs.IOS_JOBS ?? [];
  const outs = [...JOBS, ...ios].map((j) => j[0]);
  for (const f of ['public/favicon-16.png', 'public/favicon-32.png', 'public/favicon.svg']) {
    assert.ok(!outs.includes(f), `${f} must stay hand-designed`);
  }
});
