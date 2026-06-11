import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickKokoroPreset, KOKORO_BUCKETS } from '../lib/kokoro-fallback.mjs';

test('maps a child female to a light female preset', () => {
  const p = pickKokoroPreset({ gender: 'female', ageRange: 'child', id: 'sela' });
  assert.ok(KOKORO_BUCKETS['female-light'].includes(p), `${p} not in female-light`);
});

test('maps an elderly neutral (dragon) to a deep male preset, deterministically', () => {
  const a = pickKokoroPreset({ gender: 'neutral', ageRange: 'elderly', id: 'coalfall-dragon' });
  const b = pickKokoroPreset({ gender: 'neutral', ageRange: 'elderly', id: 'coalfall-dragon' });
  assert.equal(a, b);
  assert.ok(KOKORO_BUCKETS['male-deep'].includes(a), `${a} not in male-deep`);
});

test('preset is stable per id (twin separation relies on distinct ids)', () => {
  assert.equal(
    pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'brann-weir' }),
    pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'brann-weir' }),
  );
  assert.equal(
    pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'berrin-weir' }),
    pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'berrin-weir' }),
  );
});
