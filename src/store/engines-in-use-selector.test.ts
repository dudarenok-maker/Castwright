/* Pin selectEnginesInUse — the wedge the top bar reads to decide which
   pills to render. The selector intentionally returns a Set (not a
   discriminated union) so a future per-character engine override extension
   widens the result transparently. */

import { describe, expect, it } from 'vitest';
import { selectEnginesInUse, selectDefaultTtsEngine } from './engines-in-use-selector';
import type { RootState } from './index';
import type { Character } from '../lib/types';

function makeState(modelKey: string, characters: Character[] = []): RootState {
  /* Cast — the selector reads `account.defaultTtsModelKey` plus the cast
     slice's characters (for per-character engine overrides). We don't need
     a full store. */
  return {
    account: { defaultTtsModelKey: modelKey },
    cast: { characters },
  } as unknown as RootState;
}

const charWithEngine = (id: string, ttsEngine?: Character['ttsEngine']): Character =>
  ({ id, name: id, role: '', color: 'narrator', lines: 0, scenes: 0, ttsEngine }) as Character;

describe('selectEnginesInUse', () => {
  it('returns {kokoro} when the default is kokoro-v1', () => {
    expect(selectEnginesInUse(makeState('kokoro-v1'))).toEqual(new Set(['kokoro']));
  });

  it('returns {coqui} when the default is coqui-xtts-v2', () => {
    expect(selectEnginesInUse(makeState('coqui-xtts-v2'))).toEqual(new Set(['coqui']));
  });

  it('returns {gemini} when the default is a Gemini model', () => {
    expect(selectEnginesInUse(makeState('gemini-2.5-flash'))).toEqual(new Set(['gemini']));
  });

  it('folds piper into the coqui pill family (shared sidecar lifecycle)', () => {
    /* Piper rides the Coqui sidecar's Load/Stop — it doesn't have its own
       pill. The selector must collapse piper into 'coqui' so the Coqui
       pill renders if any piper voice is in use. */
    expect(selectEnginesInUse(makeState('piper-en-amy'))).toEqual(new Set(['coqui']));
  });

  it('returns an empty set when defaultTtsModelKey is missing', () => {
    /* Defensive: an unhydrated account slice should not crash the top bar
       — it just yields no pills. */
    const empty = { account: { defaultTtsModelKey: undefined } } as unknown as RootState;
    expect(selectEnginesInUse(empty)).toEqual(new Set());
  });

  it('includes "qwen" when any cast character has ttsEngine="qwen" (plan 108)', () => {
    /* Per-character engine override: Qwen is bespoke-per-character, so it's
       almost never the book default. A single character pinned to Qwen must
       still surface the Qwen pill alongside the default Kokoro pill. */
    const state = makeState('kokoro-v1', [
      charWithEngine('narrator'),
      charWithEngine('halloran', 'qwen'),
    ]);
    expect(selectEnginesInUse(state)).toEqual(new Set(['kokoro', 'qwen']));
  });

  it('includes "qwen" when a character carries an overrideTtsVoices.qwen slot', () => {
    /* Even without ttsEngine set, a designed Qwen voice slot means the
       character can synthesise with Qwen — surface the pill. */
    const char = {
      id: 'halloran',
      name: 'Halloran',
      role: '',
      color: 'narrator',
      lines: 0,
      scenes: 0,
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
    } as unknown as Character;
    const state = makeState('kokoro-v1', [char]);
    expect(selectEnginesInUse(state)).toEqual(new Set(['kokoro', 'qwen']));
  });

  it('does NOT include "qwen" when no character uses it', () => {
    const state = makeState('kokoro-v1', [
      charWithEngine('narrator'),
      charWithEngine('halloran', 'kokoro'),
    ]);
    expect(selectEnginesInUse(state)).toEqual(new Set(['kokoro']));
  });
});

describe('selectDefaultTtsEngine', () => {
  /* The default/primary engine, independent of any loaded book's cast — the
     top bar keeps this engine's pill reachable on book-less views. */
  it('maps kokoro-v1 → kokoro', () => {
    expect(selectDefaultTtsEngine(makeState('kokoro-v1'))).toBe('kokoro');
  });

  it('maps a Qwen key → qwen', () => {
    expect(selectDefaultTtsEngine(makeState('qwen3-tts-0.6b'))).toBe('qwen');
  });

  it('maps coqui-xtts-v2 → coqui (and folds piper into coqui)', () => {
    expect(selectDefaultTtsEngine(makeState('coqui-xtts-v2'))).toBe('coqui');
    expect(selectDefaultTtsEngine(makeState('piper-en-amy'))).toBe('coqui');
  });

  it('maps a Gemini key → gemini (cloud, no pill)', () => {
    expect(selectDefaultTtsEngine(makeState('gemini-2.5-flash'))).toBe('gemini');
  });

  it('returns null when defaultTtsModelKey has not hydrated yet', () => {
    const empty = { account: { defaultTtsModelKey: undefined } } as unknown as RootState;
    expect(selectDefaultTtsEngine(empty)).toBeNull();
  });
});
