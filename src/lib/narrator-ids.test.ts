/* #1895 — NARRATOR_CHARACTER_IDS is the single frontend home for "which
   character ids mean the narrator". Guards two things:
     1. The constant's own (real, unmocked) contents.
     2. That principal-cast.ts and tts-voice-mapping.ts both consult the
        SAME imported binding rather than each carrying its own inline
        copy of the pair — proven by swapping the constant via vi.mock and
        checking both consumers react in lockstep.
   vi.mock is file-scoped and hoisted, so every other `NARRATOR_CHARACTER_IDS`
   import in this file below resolves to the sentinel mock, not the real
   module — guard 1 uses vi.importActual specifically to read past that. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./narrator-ids', () => ({
  NARRATOR_CHARACTER_IDS: ['story-teller'],
}));

import { NARRATOR_CHARACTER_IDS } from './narrator-ids';
import { selectPrincipalCast } from './principal-cast';
import { inferProfile } from './tts-voice-mapping';

describe('NARRATOR_CHARACTER_IDS', () => {
  it('the real constant (bypassing the file-scoped mock via importActual) is the narrator / char-narrator pair', async () => {
    const real =
      await vi.importActual<typeof import('./narrator-ids')>('./narrator-ids');
    expect(real.NARRATOR_CHARACTER_IDS).toEqual(['narrator', 'char-narrator']);
  });

  it('the mocked import above resolves to the sentinel id, not the real pair (sanity-checks the mock wiring the next test depends on)', () => {
    expect(NARRATOR_CHARACTER_IDS).toEqual(['story-teller']);
  });

  it('principal-cast.ts and tts-voice-mapping.ts both consult the shared import, not an independent inline copy', () => {
    // The mocked list no longer contains 'narrator' — a real copy of the
    // pair inline in either module would still treat it as the narrator,
    // and would NOT treat the swapped id 'story-teller' as one. If either
    // consumer diverges from the mocked binding, one of the four
    // assertions below fails.
    const swappedResult = selectPrincipalCast(
      [
        { id: 'story-teller', name: 'Someone' },
        { id: 'a' },
      ],
      { 'story-teller': 1000, a: 10 },
    );
    expect(swappedResult.has('story-teller')).toBe(false); // now the narrator

    const oldLiteralResult = selectPrincipalCast(
      [
        { id: 'narrator' },
        { id: 'a' },
      ],
      { narrator: 1000, a: 10 },
    );
    expect(oldLiteralResult.has('narrator')).toBe(true); // no longer special-cased

    // warmth 56 is deliberately BELOW the non-narrator fallback's own
    // warm/cool split (>= 60, tts-voice-mapping.ts:302) but still within the
    // narrator branch's (>= 55, :283) — so the two branches disagree unless
    // `isNarrator` itself is what the mocked constant is deciding.
    const tone = { warmth: 56, pace: 50, authority: 50, emotion: 50 };
    expect(inferProfile({ id: 'story-teller', tone })).toBe('narrator-warm');
    expect(inferProfile({ id: 'narrator', tone })).toBe('narrator-cool');
  });
});
