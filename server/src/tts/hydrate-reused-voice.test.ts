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
    const c = designed('garrow', 'qwen-garrow');
    const r = await resolveReusedVoiceFields(c, loaderFrom({}));
    expect(r).toBeNull();
  });

  it('returns null when there is no matchedFrom to follow', async () => {
    const c: ReuseHydratable = { id: 'vane' };
    expect(await resolveReusedVoiceFields(c, loaderFrom({}))).toBeNull();
  });

  it('hydrates from the source book when the reused char has no override', async () => {
    const reused: ReuseHydratable = {
      id: 'garrow',
      matchedFrom: { bookId: 'the Hollow Tide', characterId: 'garrow' },
    };
    const r = await resolveReusedVoiceFields(
      reused,
      loaderFrom({ 'the Hollow Tide': [designed('garrow', 'qwen-garrow')] }),
    );
    expect(r).toEqual({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-garrow' } } });
  });

  it('fs-25 — carries the source book\'s emotion variants onto the reused character', async () => {
    const reused: ReuseHydratable = {
      id: 'wren',
      matchedFrom: { bookId: 'book1', characterId: 'wren' },
    };
    const source: ReuseHydratable = {
      id: 'wren',
      ttsEngine: 'qwen',
      overrideTtsVoices: {
        qwen: { name: 'qwen-wren', variants: { angry: { name: 'qwen-wren__angry' } } },
      },
    };
    const hydrated = await hydrateCharacterVoice(reused, loaderFrom({ book1: [source] }));
    // the variant travels with the base voice into the reused book (Wave 6a).
    expect(hydrated.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-wren',
      variants: { angry: { name: 'qwen-wren__angry' } },
    });
  });

  it('follows a multi-hop matchedFrom chain to the book that holds the override', async () => {
    /* C → B (reused, no override) → A (holds the designed voice). */
    const inC: ReuseHydratable = { id: 'garrow', matchedFrom: { bookId: 'B', characterId: 'garrow' } };
    const inB: ReuseHydratable = { id: 'garrow', matchedFrom: { bookId: 'A', characterId: 'garrow' } };
    const r = await resolveReusedVoiceFields(
      inC,
      loaderFrom({ B: [inB], A: [designed('garrow', 'qwen-garrow')] }),
    );
    expect(r?.overrideTtsVoices.qwen?.name).toBe('qwen-garrow');
  });

  it('returns null when the source book is missing', async () => {
    const reused: ReuseHydratable = {
      id: 'garrow',
      matchedFrom: { bookId: 'gone', characterId: 'garrow' },
    };
    expect(await resolveReusedVoiceFields(reused, loaderFrom({}))).toBeNull();
  });

  it('returns null when no book in the chain carries an override (the Lord Vane case)', async () => {
    /* Every book reuses but none holds the override — runtime resolution can't
       recover it (only the data-recovery migration's on-disk fallback can). */
    const stell: ReuseHydratable = { id: 'lord-vane', matchedFrom: { bookId: 'the tidewatcher’s oath', characterId: 'lord-vane' } };
    const tidewatcherOath: ReuseHydratable = { id: 'lord-vane' }; // origin, override lost
    expect(
      await resolveReusedVoiceFields(stell, loaderFrom({ 'the tidewatcher’s oath': [tidewatcherOath] })),
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

  it('[ADV-C3][EX-10] refuses to resolve a coqui-cloned character onto the source book\'s qwen voice', async () => {
    /* A coqui clone (a real person's likeness) with matchedFrom pointing at a
       book whose matched character carries a qwen-DESIGNED voice, and no
       explicit ttsEngine of its own. resolveReusedVoiceFields must not
       reroute this character onto qwen and hand it the source's designed
       voice — the [ADV-C3] laundering bug. */
    const clonedCoqui: ReuseHydratable = {
      id: 'x',
      overrideTtsVoices: {
        coqui: { name: 'Real Person', libraryUuid: 'uuid-real-person', provenance: 'cloned' },
      },
      matchedFrom: { bookId: 'src', characterId: 'x' },
    };
    const source: ReuseHydratable = designed('x', 'qwen-someone-else');
    const r = await resolveReusedVoiceFields(clonedCoqui, loaderFrom({ src: [source] }));
    expect(r).toBeNull();
  });
});

describe('hydrateCharacterVoice', () => {
  it('returns the character enriched with the source override', async () => {
    const reused = {
      id: 'garrow',
      name: 'Garrow',
      matchedFrom: { bookId: 'the Hollow Tide', characterId: 'garrow' },
    };
    const out = await hydrateCharacterVoice(
      reused,
      loaderFrom({ 'the Hollow Tide': [designed('garrow', 'qwen-garrow')] }),
    );
    expect(out.ttsEngine).toBe('qwen');
    expect(out.overrideTtsVoices?.qwen?.name).toBe('qwen-garrow');
    expect((out as { name: string }).name).toBe('Garrow'); // other fields preserved
  });

  it('returns the character unchanged when nothing resolves', async () => {
    const c = { id: 'vane', name: 'Lord Vane' };
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

  it('[ADV-C3][EX-10] never reroutes a coqui-cloned character onto qwen or merges the source\'s foreign qwen slot', async () => {
    /* Same laundering bug, exercised through the public hydrateCharacterVoice
       entry point (the hot-path caller, generation.ts:775) rather than the
       resolver directly — a fix that only touches resolveReusedVoiceFields
       could still leave this merge step defaulting ttsEngine to the
       resolved value. */
    const clonedCoqui: ReuseHydratable = {
      id: 'x',
      overrideTtsVoices: {
        coqui: { name: 'Real Person', libraryUuid: 'uuid-real-person', provenance: 'cloned' },
      },
      matchedFrom: { bookId: 'src', characterId: 'x' },
    };
    const source: ReuseHydratable = designed('x', 'qwen-someone-else');
    const out = await hydrateCharacterVoice(clonedCoqui, loaderFrom({ src: [source] }));

    expect(out.ttsEngine).not.toBe('qwen');
    expect(out.overrideTtsVoices?.qwen).toBeUndefined();
    expect(out.overrideTtsVoices?.coqui?.name).toBe('Real Person'); // own clone kept
  });
});
