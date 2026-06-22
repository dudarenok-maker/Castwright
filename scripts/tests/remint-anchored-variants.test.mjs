/* Tests for scripts/remint-anchored-variants.mjs
   Run via: node --test scripts/tests/remint-anchored-variants.test.mjs

   Covers planRemints: the pure function that identifies legacy (non-anchored)
   emotion variant voices that need to be re-minted through the anchored pipeline. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planRemints } from '../remint-anchored-variants.mjs';

// ---------------------------------------------------------------------------
// planRemints — pure function tests
// ---------------------------------------------------------------------------

test('selects only legacy (non-anchored) variants', () => {
  assert.deepEqual(
    planRemints([
      { voiceId: 'q-a' },
      { voiceId: 'q-a__angry' },
      { voiceId: 'q-b__sad', mintMethod: 'anchored-icl-instruct' },
    ]),
    ['q-a__angry'],
  );
});

test('base voices (no __ suffix) are never selected', () => {
  assert.deepEqual(
    planRemints([
      { voiceId: 'qwen-v_marlow' },
      { voiceId: 'qwen-v_maerin' },
    ]),
    [],
  );
});

test('already-anchored variants are excluded', () => {
  assert.deepEqual(
    planRemints([
      { voiceId: 'qwen-v_marlow__angry', mintMethod: 'anchored-icl-instruct' },
      { voiceId: 'qwen-v_marlow__sad', mintMethod: 'anchored-icl-instruct' },
    ]),
    [],
  );
});

test('legacy variant with no mintMethod is selected', () => {
  assert.deepEqual(
    planRemints([{ voiceId: 'qwen-v_marlow__excited' }]),
    ['qwen-v_marlow__excited'],
  );
});

test('legacy variant with wrong mintMethod is selected', () => {
  assert.deepEqual(
    planRemints([{ voiceId: 'qwen-v_marlow__whisper', mintMethod: 'old-method' }]),
    ['qwen-v_marlow__whisper'],
  );
});

test('empty array → empty result', () => {
  assert.deepEqual(planRemints([]), []);
});

test('mixed: only the legacy variants are returned, in input order', () => {
  assert.deepEqual(
    planRemints([
      { voiceId: 'qwen-v_a' },
      { voiceId: 'qwen-v_a__angry' },
      { voiceId: 'qwen-v_b__sad', mintMethod: 'anchored-icl-instruct' },
      { voiceId: 'qwen-v_c__excited' },
      { voiceId: 'qwen-v_d__whisper', mintMethod: 'anchored-icl-instruct' },
      { voiceId: 'qwen-v_e__angry', mintMethod: 'anchored-icl-instruct' },
      { voiceId: 'qwen-v_f__sad' },
    ]),
    ['qwen-v_a__angry', 'qwen-v_c__excited', 'qwen-v_f__sad'],
  );
});

test('undefined mintMethod is treated as legacy', () => {
  assert.deepEqual(
    planRemints([{ voiceId: 'qwen-v_x__sad', mintMethod: undefined }]),
    ['qwen-v_x__sad'],
  );
});
