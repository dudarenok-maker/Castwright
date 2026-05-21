/* Pin selectEnginesInUse — the wedge the top bar reads to decide which
   pills to render. The selector intentionally returns a Set (not a
   discriminated union) so a future per-character engine override extension
   widens the result transparently. */

import { describe, expect, it } from 'vitest';
import { selectEnginesInUse } from './engines-in-use-selector';
import type { RootState } from './index';

function makeState(modelKey: string): RootState {
  /* Cast — the selector only reads `account.defaultTtsModelKey`. We don't
     need a full store. */
  return { account: { defaultTtsModelKey: modelKey } } as unknown as RootState;
}

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
});
