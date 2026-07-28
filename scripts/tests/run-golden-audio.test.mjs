// Runs under `npm run test:hooks` (node --test over scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/run-golden-audio.mjs', 'utf8');

test('Suite B receives GOLDEN_BLESS when --bless is passed', () => {
  // The Suite B run(...) call must pass a bless-conditional env object.
  const suiteB = src.slice(src.indexOf("run('assembly (Suite B)'"));
  const call = suiteB.slice(0, suiteB.indexOf('\n}'));
  assert.match(call, /GOLDEN_BLESS/, 'Suite B run() must forward GOLDEN_BLESS');
  assert.match(call, /bless \?/, 'forwarding must be conditional on the bless flag');
});

test('Suite A still receives GOLDEN_BLESS — existing behaviour is preserved', () => {
  const suiteA = src.slice(src.indexOf("run(\n    'sidecar (Suite A)'"));
  assert.match(suiteA, /bless \? \{ GOLDEN_BLESS: '1' \}/);
});

test('the header documents that --bless follows suite selection', () => {
  assert.match(src, /--bless[\s\S]{0,400}suite selection/i);
});
