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
    const c = designed('sandor', 'qwen-sandor');
    const r = await resolveReusedVoiceFields(c, loaderFrom({}));
    expect(r).toBeNull();
  });

  it('returns null when there is no matchedFrom to follow', async () => {
    const c: ReuseHydratable = { id: 'cassius' };
    expect(await resolveReusedVoiceFields(c, loaderFrom({}))).toBeNull();
  });

  it('hydrates from the source book when the reused char has no override', async () => {
    const reused: ReuseHydratable = {
      id: 'sandor',
      matchedFrom: { bookId: 'kotlc', characterId: 'sandor' },
    };
    const r = await resolveReusedVoiceFields(
      reused,
      loaderFrom({ kotlc: [designed('sandor', 'qwen-sandor')] }),
    );
    expect(r).toEqual({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-sandor' } } });
  });

  it('follows a multi-hop matchedFrom chain to the book that holds the override', async () => {
    /* C → B (reused, no override) → A (holds the designed voice). */
    const inC: ReuseHydratable = { id: 'sandor', matchedFrom: { bookId: 'B', characterId: 'sandor' } };
    const inB: ReuseHydratable = { id: 'sandor', matchedFrom: { bookId: 'A', characterId: 'sandor' } };
    const r = await resolveReusedVoiceFields(
      inC,
      loaderFrom({ B: [inB], A: [designed('sandor', 'qwen-sandor')] }),
    );
    expect(r?.overrideTtsVoices.qwen?.name).toBe('qwen-sandor');
  });

  it('returns null when the source book is missing', async () => {
    const reused: ReuseHydratable = {
      id: 'sandor',
      matchedFrom: { bookId: 'gone', characterId: 'sandor' },
    };
    expect(await resolveReusedVoiceFields(reused, loaderFrom({}))).toBeNull();
  });

  it('returns null when no book in the chain carries an override (the Lord Cassius case)', async () => {
    /* Every book reuses but none holds the override — runtime resolution can't
       recover it (only the data-recovery migration's on-disk fallback can). */
    const stell: ReuseHydratable = { id: 'lord-cassius', matchedFrom: { bookId: 'everblaze', characterId: 'lord-cassius' } };
    const everblaze: ReuseHydratable = { id: 'lord-cassius' }; // origin, override lost
    expect(
      await resolveReusedVoiceFields(stell, loaderFrom({ everblaze: [everblaze] })),
    ).toBeNull();
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
      id: 'sandor',
      name: 'Sandor',
      matchedFrom: { bookId: 'kotlc', characterId: 'sandor' },
    };
    const out = await hydrateCharacterVoice(
      reused,
      loaderFrom({ kotlc: [designed('sandor', 'qwen-sandor')] }),
    );
    expect(out.ttsEngine).toBe('qwen');
    expect(out.overrideTtsVoices?.qwen?.name).toBe('qwen-sandor');
    expect((out as { name: string }).name).toBe('Sandor'); // other fields preserved
  });

  it('returns the character unchanged when nothing resolves', async () => {
    const c = { id: 'cassius', name: 'Lord Cassius' };
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
});
