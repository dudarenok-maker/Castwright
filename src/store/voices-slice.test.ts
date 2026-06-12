// Pairs with docs/features/archive/22-voice-library.md

import { describe, expect, it } from 'vitest';
import { voicesSlice, voicesActions } from './voices-slice';
import type { Voice } from '../lib/types';

const voice = (id: string, overrides: Partial<Voice> = {}): Voice => ({
  id,
  character: id,
  bookTitle: '',
  bookId: '',
  attributes: [],
  gradient: ['#000', '#fff'],
  usedIn: 1,
  source: 'library',
  ttsVoice: { provider: 'coqui', name: id, description: '' },
  ...overrides,
});

describe('voicesSlice — initial state', () => {
  it('starts empty and not loaded', () => {
    expect(voicesSlice.getInitialState()).toEqual({
      loaded: false,
      voices: [],
      baseVoices: [],
      baseVoicesLoaded: false,
    });
  });
});

describe('voicesSlice — hydrate', () => {
  it('replaces voices and marks loaded', () => {
    const next = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({
        voices: [voice('v1'), voice('v2')],
      }),
    );
    expect(next.loaded).toBe(true);
    expect(next.voices.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('replaces prior voices on rehydrate', () => {
    let s = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('old')] }));
    s = voicesSlice.reducer(s, voicesActions.hydrate({ voices: [voice('new')] }));
    expect(s.voices.map((v) => v.id)).toEqual(['new']);
  });
});

describe('voicesSlice — setPinned', () => {
  it('flips pinned to true on the matching voice', () => {
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({ voices: [voice('v1'), voice('v2')] }),
    );
    const next = voicesSlice.reducer(
      start,
      voicesActions.setPinned({ voiceId: 'v1', pinned: true }),
    );
    expect(next.voices.find((v) => v.id === 'v1')!.pinned).toBe(true);
    // unrelated voice untouched
    expect(next.voices.find((v) => v.id === 'v2')!.pinned).toBeUndefined();
  });

  it('clears the pinned flag (stores undefined, not false) when pinned=false', () => {
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({ voices: [voice('v1', { pinned: true })] }),
    );
    const next = voicesSlice.reducer(
      start,
      voicesActions.setPinned({ voiceId: 'v1', pinned: false }),
    );
    // The reducer assigns `pinned || undefined` so false becomes undefined.
    expect(next.voices[0].pinned).toBeUndefined();
  });

  it('is a no-op for an unknown voiceId', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1')] }));
    const next = voicesSlice.reducer(
      start,
      voicesActions.setPinned({ voiceId: 'missing', pinned: true }),
    );
    expect(next.voices).toEqual(start.voices);
  });
});

describe('voicesSlice — markSampled', () => {
  it('sets sampled=true on the matching voice and leaves others untouched', () => {
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({ voices: [voice('v1'), voice('v2')] }),
    );
    const next = voicesSlice.reducer(start, voicesActions.markSampled({ voiceId: 'v1' }));
    expect(next.voices.find((v) => v.id === 'v1')!.sampled).toBe(true);
    expect(next.voices.find((v) => v.id === 'v2')!.sampled).toBeUndefined();
  });

  it('is a no-op for an unknown voiceId', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1')] }));
    const next = voicesSlice.reducer(start, voicesActions.markSampled({ voiceId: 'missing' }));
    expect(next.voices).toEqual(start.voices);
  });
});

describe('voicesSlice — setOverride', () => {
  it('writes the override into overrideTtsVoices[engine] and projects it onto the legacy field', () => {
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({ voices: [voice('v_brann'), voice('v_other')] }),
    );
    const next = voicesSlice.reducer(
      start,
      voicesActions.setOverride({
        voiceId: 'v_brann',
        override: { engine: 'coqui', name: 'Asya Anara' },
      }),
    );
    const brann = next.voices.find((v) => v.id === 'v_brann')!;
    expect(brann.overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    /* Legacy field still reflects the active engine's slot for callers
       that haven't migrated yet. */
    expect(brann.overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
    /* Unrelated voice is untouched. */
    expect(next.voices.find((v) => v.id === 'v_other')!.overrideTtsVoices).toBeUndefined();
  });

  it('preserves an existing engine slot when setting a different engine', () => {
    /* The whole point of pluralization — Coqui and Kokoro slots must
       coexist so engine switches don't force a re-cast. */
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({
        voices: [voice('v_brann', { overrideTtsVoices: { kokoro: { name: 'am_onyx' } } })],
      }),
    );
    const next = voicesSlice.reducer(
      start,
      voicesActions.setOverride({
        voiceId: 'v_brann',
        override: { engine: 'coqui', name: 'Asya Anara' },
      }),
    );
    expect(next.voices[0].overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });
  });

  it('clears EVERY engine slot when given null', () => {
    const start = voicesSlice.reducer(
      undefined,
      voicesActions.hydrate({
        voices: [
          voice('v_brann', {
            overrideTtsVoices: { coqui: { name: 'Asya Anara' }, kokoro: { name: 'am_onyx' } },
          }),
        ],
      }),
    );
    const next = voicesSlice.reducer(
      start,
      voicesActions.setOverride({ voiceId: 'v_brann', override: null }),
    );
    expect(next.voices[0].overrideTtsVoices).toBeNull();
    expect(next.voices[0].overrideTtsVoice).toBeNull();
  });

  it('is a no-op for an unknown voiceId', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1')] }));
    const next = voicesSlice.reducer(
      start,
      voicesActions.setOverride({
        voiceId: 'missing',
        override: { engine: 'coqui', name: 'X' },
      }),
    );
    expect(next.voices).toEqual(start.voices);
  });
});

describe('voicesSlice — hydrateBaseVoices', () => {
  it('replaces baseVoices and marks the catalog loaded', () => {
    const next = voicesSlice.reducer(
      undefined,
      voicesActions.hydrateBaseVoices([
        { engine: 'coqui', name: 'Asya Anara' },
        { engine: 'gemini', name: 'Charon' },
      ]),
    );
    expect(next.baseVoicesLoaded).toBe(true);
    expect(next.baseVoices.map((v) => v.name)).toEqual(['Asya Anara', 'Charon']);
  });

  it('a subsequent re-hydrate replaces the catalog', () => {
    let s = voicesSlice.reducer(
      undefined,
      voicesActions.hydrateBaseVoices([{ engine: 'coqui', name: 'A' }]),
    );
    s = voicesSlice.reducer(s, voicesActions.hydrateBaseVoices([{ engine: 'gemini', name: 'B' }]));
    expect(s.baseVoices.map((v) => v.name)).toEqual(['B']);
  });
});
