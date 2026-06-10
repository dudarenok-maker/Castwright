import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOBS } from '../render-brand-pngs.mjs';

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
