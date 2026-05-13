// Pairs with docs/features/24-voice-library.md

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
    expect(voicesSlice.getInitialState()).toEqual({ loaded: false, voices: [] });
  });
});

describe('voicesSlice — hydrate', () => {
  it('replaces voices and marks loaded', () => {
    const next = voicesSlice.reducer(undefined, voicesActions.hydrate({
      voices: [voice('v1'), voice('v2')],
    }));
    expect(next.loaded).toBe(true);
    expect(next.voices.map(v => v.id)).toEqual(['v1', 'v2']);
  });

  it('replaces prior voices on rehydrate', () => {
    let s = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('old')] }));
    s = voicesSlice.reducer(s, voicesActions.hydrate({ voices: [voice('new')] }));
    expect(s.voices.map(v => v.id)).toEqual(['new']);
  });
});

describe('voicesSlice — setPinned', () => {
  it('flips pinned to true on the matching voice', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1'), voice('v2')] }));
    const next = voicesSlice.reducer(start, voicesActions.setPinned({ voiceId: 'v1', pinned: true }));
    expect(next.voices.find(v => v.id === 'v1')!.pinned).toBe(true);
    // unrelated voice untouched
    expect(next.voices.find(v => v.id === 'v2')!.pinned).toBeUndefined();
  });

  it('clears the pinned flag (stores undefined, not false) when pinned=false', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1', { pinned: true })] }));
    const next = voicesSlice.reducer(start, voicesActions.setPinned({ voiceId: 'v1', pinned: false }));
    // The reducer assigns `pinned || undefined` so false becomes undefined.
    expect(next.voices[0].pinned).toBeUndefined();
  });

  it('is a no-op for an unknown voiceId', () => {
    const start = voicesSlice.reducer(undefined, voicesActions.hydrate({ voices: [voice('v1')] }));
    const next = voicesSlice.reducer(start, voicesActions.setPinned({ voiceId: 'missing', pinned: true }));
    expect(next.voices).toEqual(start.voices);
  });
});
