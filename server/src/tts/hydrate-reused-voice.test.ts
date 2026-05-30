import { describe, it, expect } from 'vitest';
import {
  resolveReusedVoiceFields,
  hydrateCharacterVoice,
  type ReuseHydratable,
  type CastLoader,
} from './hydrate-reused-voice.js';

/* Build a cast loader from an in-memory { bookId: characters[] } map. */
function loaderFrom(books: Record<string, ReuseHydratable[]>): CastLoader {
  return async (bookId: string) => books[bookId] ?? null;
}

const designed = (id: string, name: string): ReuseHydratable => ({
  id,
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name } },
});

describe('resolveReusedVoiceFields', () => {
  it('returns null when the character already owns a qwen voice', async () => {
    const c = designed('Garrow', 'qwen-Garrow');
    const r = await resolveReusedVoiceFields(c, loaderFrom({}));
    expect(r).toBeNull();
  });

  it('returns null when there is no matchedFrom to follow', async () => {
    const c: ReuseHydratable = { id: 'Vane' };
    expect(await resolveReusedVoiceFields(c, loaderFrom({}))).toBeNull();
  });

  it('hydrates from the source book when the reused char has no override', async () => {
    const reused: ReuseHydratable = {
      id: 'Garrow',
      matchedFrom: { bookId: 'the Hollow Tide', characterId: 'Garrow' },
    };
    const r = await resolveReusedVoiceFields(
      reused,
      loaderFrom({ the Hollow Tide: [designed('Garrow', 'qwen-Garrow')] }),
    );
    expect(r).toEqual({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-Garrow' } } });
  });

  it('follows a multi-hop matchedFrom chain to the book that holds the override', async () => {
    /* C → B (reused, no override) → A (holds the designed voice). */
    const inC: ReuseHydratable = { id: 'Garrow', matchedFrom: { bookId: 'B', characterId: 'Garrow' } };
    const inB: ReuseHydratable = { id: 'Garrow', matchedFrom: { bookId: 'A', characterId: 'Garrow' } };
    const r = await resolveReusedVoiceFields(
      inC,
      loaderFrom({ B: [inB], A: [designed('Garrow', 'qwen-Garrow')] }),
    );
    expect(r?.overrideTtsVoices.qwen?.name).toBe('qwen-Garrow');
  });

  it('returns null when the source book is missing', async () => {
    const reused: ReuseHydratable = {
      id: 'Garrow',
      matchedFrom: { bookId: 'gone', characterId: 'Garrow' },
    };
    expect(await resolveReusedVoiceFields(reused, loaderFrom({}))).toBeNull();
  });

  it('returns null when no book in the chain carries an override (the Lord Vane case)', async () => {
    /* Every book reuses but none holds the override — runtime resolution can't
       recover it (only the data-recovery migration's on-disk fallback can). */
    const stell: ReuseHydratable = { id: 'lord-Vane', matchedFrom: { bookId: 'The Tidewatcher's Oath', characterId: 'lord-Vane' } };
    const The Tidewatcher's Oath: ReuseHydratable = { id: 'lord-Vane' }; // origin, override lost
    expect(
      await resolveReusedVoiceFields(stell, loaderFrom({ The Tidewatcher's Oath: [The Tidewatcher's Oath] })),
    ).toBeNull();
  });

  it('carries the source persona (voiceStyle) alongside the resolved voice (srv-18)', async () => {
    const reused: ReuseHydratable = { id: 'x', matchedFrom: { bookId: 'src', characterId: 'x' } };
    const source: ReuseHydratable = {
      ...designed('x', 'qwen-x'),
      voiceStyle: 'a bright, confident teenage girl',
    };
    const r = await resolveReusedVoiceFields(reused, loaderFrom({ src: [source] }));
    expect(r?.voiceStyle).toBe('a bright, confident teenage girl');
  });

  it('defaults ttsEngine to qwen when the source has an override but no engine field', async () => {
    const reused: ReuseHydratable = { id: 'x', matchedFrom: { bookId: 'src', characterId: 'x' } };
    const source: ReuseHydratable = { id: 'x', overrideTtsVoices: { qwen: { name: 'qwen-x' } } };
    const r = await resolveReusedVoiceFields(reused, loaderFrom({ src: [source] }));
    expect(r?.ttsEngine).toBe('qwen');
  });

  it('does not loop forever on a cyclic matchedFrom chain', async () => {
    const a: ReuseHydratable = { id: 'x', matchedFrom: { bookId: 'B', characterId: 'x' } };
    const b: ReuseHydratable = { id: 'x', matchedFrom: { bookId: 'A', characterId: 'x' } };
    const r = await resolveReusedVoiceFields(a, loaderFrom({ A: [a], B: [b] }));
    expect(r).toBeNull();
  });
});

describe('hydrateCharacterVoice', () => {
  it('returns the character enriched with the source override', async () => {
    const reused = {
      id: 'Garrow',
      name: 'Garrow',
      matchedFrom: { bookId: 'the Hollow Tide', characterId: 'Garrow' },
    };
    const out = await hydrateCharacterVoice(
      reused,
      loaderFrom({ the Hollow Tide: [designed('Garrow', 'qwen-Garrow')] }),
    );
    expect(out.ttsEngine).toBe('qwen');
    expect(out.overrideTtsVoices?.qwen?.name).toBe('qwen-Garrow');
    expect((out as { name: string }).name).toBe('Garrow'); // other fields preserved
  });

  it('returns the character unchanged when nothing resolves', async () => {
    const c = { id: 'Vane', name: 'Lord Vane' };
    const out = await hydrateCharacterVoice(c, loaderFrom({}));
    expect(out).toBe(c);
  });

  it('does not clobber the character own override slots', async () => {
    const reused: ReuseHydratable = {
      id: 'x',
      overrideTtsVoices: { kokoro: { name: 'af_bella' } },
      matchedFrom: { bookId: 'src', characterId: 'x' },
    };
    const out = await hydrateCharacterVoice(
      reused,
      loaderFrom({ src: [designed('x', 'qwen-x')] }),
    );
    expect(out.overrideTtsVoices?.kokoro?.name).toBe('af_bella'); // own slot kept
    expect(out.overrideTtsVoices?.qwen?.name).toBe('qwen-x'); // source slot added
  });

  it('copies the source persona onto a reused char that lacks one (srv-18)', async () => {
    const reused = { id: 'x', name: 'X', matchedFrom: { bookId: 'src', characterId: 'x' } };
    const source: ReuseHydratable = { ...designed('x', 'qwen-x'), voiceStyle: 'sardonic charmer' };
    const out = await hydrateCharacterVoice(reused, loaderFrom({ src: [source] }));
    expect(out.voiceStyle).toBe('sardonic charmer');
  });

  it('keeps the character own persona, never clobbering it with the source (srv-18)', async () => {
    const reused: ReuseHydratable = {
      id: 'x',
      voiceStyle: 'hand-edited persona',
      matchedFrom: { bookId: 'src', characterId: 'x' },
    };
    const source: ReuseHydratable = { ...designed('x', 'qwen-x'), voiceStyle: 'source persona' };
    const out = await hydrateCharacterVoice(reused, loaderFrom({ src: [source] }));
    expect(out.voiceStyle).toBe('hand-edited persona');
  });
});
