/* Re-analysis must not strip designed voices (bug #518). When a manuscript is
   re-analysed, the pipeline builds a FRESH roster from the analyzer (no voice
   fields) and overwrites cast.json — dropping each character's designed-voice
   link (`overrideTtsVoices`, `voiceId`, `voiceState`, `matchedFrom`, …). The
   2026-06-05 incident: navigating to the analysing URL re-ran analysis and
   stripped the Qwen voices from 10 The Drowning Bell characters.

   `mergeAnalysisResultWithExistingCast` overlays the existing cast's
   voice-design fields onto the fresh roster (by id), so re-attribution updates
   lines/scenes/evidence/attributes while the designed voices survive. */

import { describe, it, expect } from 'vitest';
import {
  mergeAnalysisResultWithExistingCast,
  overlayInterimCastForLiveView,
  seedReuseGuardsFromPriorCast,
  voicedSurvivorsDropped,
  applyRewriteToPriorCast,
  dropReuseContinuityKeepDesignedVoice,
  dedupePriorCastByName,
} from './merge-analysis-cast.js';

type C = Record<string, unknown> & { id: string };

describe('mergeAnalysisResultWithExistingCast', () => {
  it('preserves a designed Qwen voice when the character survives re-analysis', () => {
    const existing: C[] = [
      {
        id: 'berrin',
        name: 'Berrin',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
        lines: 58,
      },
    ];
    const fresh: C[] = [{ id: 'berrin', name: 'Berrin', lines: 61 }]; // re-attributed, no voice
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(merged[0].voiceState).toBe('generated');
    expect(merged[0].lines).toBe(61); // fresh attribution wins
  });

  it('preserves a reused-voice link (voiceId/voiceState/matchedFrom)', () => {
    const existing: C[] = [
      {
        id: 'wisp',
        name: 'Wisp',
        voiceId: 'wisp',
        voiceState: 'reused',
        matchedFrom: { bookId: 'unlocked', characterId: 'wisp', confidence: 0.94 },
        overrideTtsVoices: { qwen: { name: 'qwen-wisp' } },
      },
    ];
    const fresh: C[] = [{ id: 'wisp', name: 'Wisp' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('wisp');
    expect(merged[0].voiceState).toBe('reused');
    expect(merged[0].matchedFrom).toEqual({ bookId: 'unlocked', characterId: 'wisp', confidence: 0.94 });
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wisp' } });
  });

  it('preserves voiceUuid across a reparse/merge (srv-43)', () => {
    const existing: C[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'generated',
        voiceUuid: 'U1',
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        lines: 20,
      },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren', lines: 25 }]; // re-attributed, no voice fields
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].voiceUuid).toBe('U1');
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wren' } });
    expect(merged[0].lines).toBe(25); // fresh attribution wins
  });

  it('keeps a brand-new character (not in the old cast) as-is', () => {
    const existing: C[] = [{ id: 'wren', voiceId: 'wren' }];
    const fresh: C[] = [
      { id: 'wren' },
      { id: 'newbie', name: 'Newbie' }, // first detected this run
    ];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren', 'newbie']);
    expect(merged[1].voiceId).toBeUndefined();
  });

  it('carries forward a voiced/reused character the re-analysis dropped (srv-13)', () => {
    const existing: C[] = [
      { id: 'wren', voiceId: 'wren' },
      {
        id: 'gone',
        name: 'Gone',
        voiceState: 'reused',
        voiceId: 'gone',
        overrideTtsVoices: { qwen: { name: 'qwen-gone' } },
      },
    ];
    const fresh: C[] = [{ id: 'wren' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren', 'gone']);
    const gone = merged.find((c) => c.id === 'gone')!;
    expect(gone.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-gone' } });
  });

  it('does NOT re-add a dropped character that carries no voice/reuse fields', () => {
    const existing: C[] = [
      { id: 'wren', voiceId: 'wren' },
      { id: 'extra', name: 'Extra', voiceState: 'generated' }, // nothing to rescue
    ];
    const fresh: C[] = [{ id: 'wren' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren']);
  });

  it('preserves notLinkedTo (analyzer never emits it)', () => {
    const existing: C[] = [
      { id: 'wren', notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }] },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'wren-teen' }]);
  });

  it('UNIONS aliases (old ∪ fresh) instead of replacing', () => {
    const existing: C[] = [{ id: 'marlow', aliases: ['Marlow', 'Sir Singe'] }];
    const fresh: C[] = [{ id: 'marlow', name: 'Marlow Halden', aliases: ['Marlow', 'Mr. Halden'] }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].aliases).toEqual(['Marlow', 'Sir Singe', 'Mr. Halden']);
  });

  it('id drift: a relabelled character carries its voice onto the same-name fresh row (no duplicate)', () => {
    // The analyzer relabelled the dragon `coalfall` -> `coalfall-dragon` between
    // runs. The old voiced row was dropped by id; without the name fallback the
    // fresh `coalfall-dragon` would be voiceless AND old `coalfall` re-added as a
    // 0-line orphan.
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        voiceId: 'coalfall',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    const fresh: C[] = [{ id: 'coalfall-dragon', name: 'Coalfall', lines: 33 } as C];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    // The descriptive, library-unique fresh id wins; no orphan.
    expect(merged.map((c) => c.id)).toEqual(['coalfall-dragon']);
    const dragon = merged[0];
    expect(dragon.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-coalfall' } });
    expect(dragon.ttsEngine).toBe('qwen');
    expect(dragon.voiceState).toBe('tuned');
    expect((dragon as C).lines).toBe(33); // analyzer-owned fields stay from the fresh row
  });

  it('id drift: the name-fallback reports the superseded old.id as a retirement (#2040 Task 8)', () => {
    // Same scenario as the relabelling test above (coalfall -> coalfall-dragon),
    // but pinning the RETIREMENT the caller must record through
    // retireCharacterId — the whole point of the choke point (§4.4 call site 3):
    // without it, a frozen segments.json still tagged 'coalfall' has no path
    // back to the live row now called 'coalfall-dragon'.
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    const fresh: C[] = [{ id: 'coalfall-dragon', name: 'Coalfall', lines: 33 } as C];
    const { retirements } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(retirements).toEqual([{ from: 'coalfall', to: 'coalfall-dragon' }]);
  });

  it('id drift: an ambiguous name (two fresh rows) falls back to id-only + re-adds the orphan', () => {
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    // Two fresh rows share the name → too risky to guess; don't merge by name.
    const fresh: C[] = [
      { id: 'coalfall-dragon', name: 'Coalfall' } as C,
      { id: 'coalfall-other', name: 'Coalfall' } as C,
    ];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['coalfall-dragon', 'coalfall-other', 'coalfall']);
    // The orphan keeps its voice; neither fresh row got it.
    expect(merged.find((c) => c.id === 'coalfall')!.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-coalfall' },
    });
    expect(merged.find((c) => c.id === 'coalfall-dragon')!.overrideTtsVoices).toBeUndefined();
  });

  it('id drift: an UNVOICED prior character whose analyzer id drifted is matched by name (RC1, #2040 Task 12)', () => {
    // Alden carries no voice/reuse field at all. Before Task 12,
    // isVoicedOrReused(old) excluded it from the candidate set entirely, so a
    // drifted analyzer id silently orphaned it — no retirement recorded, no
    // alias carried, nothing to distinguish it from a genuinely-new fresh row.
    const existing: C[] = [{ id: 'alden-old', name: 'Alden', aliases: ['Al'] }];
    const fresh: C[] = [{ id: 'alden-new', name: 'Alden' } as C];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['alden-new']); // no orphan re-added (unvoiced)
    expect(merged[0].aliases).toEqual(['Al']); // only rides over if the name-fallback matched
    expect(retirements).toEqual([{ from: 'alden-old', to: 'alden-new' }]);
  });

  it('id drift: two unvoiced prior rows sharing a name still refuse to match, neither welded (guard, #2040 Task 12)', () => {
    const existing: C[] = [
      { id: 'alden-old-1', name: 'Alden', aliases: ['Al'] },
      { id: 'alden-old-2', name: 'Alden', aliases: ['Aldo'] },
    ];
    const fresh: C[] = [{ id: 'alden-new', name: 'Alden' } as C];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['alden-new']); // neither re-added (both unvoiced)
    expect(merged[0].aliases).toBeUndefined(); // neither row's aliases rode onto it — no weld
    expect(retirements).toEqual([]);
  });

  it('id drift + surname token: a character that gained a trailing surname token maps to its prior roster row (#2536)', () => {
    // #2536's exact shape: the prior roster held "Бранн"/"Беррин" (given name
    // only); the fresh re-analysis names the same characters "Бранн Уир" /
    // "Беррин Уир" (surname token added). `nameOf` is exact-equality, so
    // without the tolerant comparator the fresh rows would mint `brann-wire` /
    // `berrin-wire` as near-duplicate ids. The surname-tolerant pass must
    // resolve both to their existing voiced rows instead.
    const existing: C[] = [
      {
        id: 'brann-weir',
        name: 'Бранн',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-brann' } },
      },
      {
        id: 'berrin-weir',
        name: 'Беррин',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
      },
    ];
    const fresh: C[] = [
      { id: 'brann-wire', name: 'Бранн Уир', lines: 41 } as C,
      { id: 'berrin-wire', name: 'Беррин Уир', lines: 44 } as C,
    ];
    const { characters: merged, retirements } =
      mergeAnalysisResultWithExistingCast(existing, fresh);
    // No near-duplicate id minted and no voiced orphan re-added — both prior
    // rows matched onto their fresh name-tolerant rows.
    expect(merged.map((c) => c.id)).toEqual(['brann-wire', 'berrin-wire']);
    const brann = merged[0];
    expect(brann.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-brann' } });
    expect(brann.voiceState).toBe('tuned');
    expect(brann.lines).toBe(41); // analyzer-owned fields stay from the fresh row
    const berrin = merged[1];
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(berrin.lines).toBe(44);
    // The superseded ids are reported so the caller can retire them.
    expect(retirements).toEqual([
      { from: 'brann-weir', to: 'brann-wire' },
      { from: 'berrin-weir', to: 'berrin-wire' },
    ]);
  });

  it('id drift + surname tolerance: names differing by MORE than one trailing token are NOT merged (#2536)', () => {
    // The longer name is two trailing tokens past the shorter, not one — no
    // strict one-token-superset, so the tolerant comparator must refuse and the
    // fresh row stays on the id-only path (no weld, no retirement).
    const existing: C[] = [
      {
        id: 'aeren',
        name: 'Aeren',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-aeren' } },
      },
    ];
    const fresh: C[] = [{ id: 'aeren-wind-rider', name: 'Aeren Wind Rider', lines: 9 } as C];
    const { characters: merged, retirements } =
      mergeAnalysisResultWithExistingCast(existing, fresh);
    // Voiced orphan kept (fresh id never got a match); fresh row stays voiceless.
    expect(merged.map((c) => c.id)).toEqual(['aeren-wind-rider', 'aeren']);
    expect(merged.find((c) => c.id === 'aeren')!.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-aeren' },
    });
    expect(merged.find((c) => c.id === 'aeren-wind-rider')!.overrideTtsVoices).toBeUndefined();
    expect(retirements).toEqual([]);
  });

  it('id drift + surname tolerance: a reordered/shuffled multi-token name is NOT merged (#2536)', () => {
    // Same token count, different order — not a strict leading-prefix one-token
    // superset, so it must not weld two distinct characters (id-only path).
    const existing: C[] = [
      {
        id: 'udir-bran',
        name: 'Удир Бран',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-ub' } },
      },
    ];
    const fresh: C[] = [{ id: 'bran-udir', name: 'Бран Удир', lines: 5 } as C];
    const { characters: merged, retirements } =
      mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['bran-udir', 'udir-bran']);
    expect(merged.find((c) => c.id === 'udir-bran')!.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-ub' },
    });
    expect(merged.find((c) => c.id === 'bran-udir')!.overrideTtsVoices).toBeUndefined();
    expect(retirements).toEqual([]);
  });

  it('id drift + surname tolerance: a surname-name shared by >1 fresh row still routes to the id-only path (#2536)', () => {
    // The ambiguous-fresh rule is untouched by the widening: a normalised name
    // shared by more than one fresh row is always left to the id-only path, so
    // the tolerant pass must not guess which one gets the prior voiced row.
    const existing: C[] = [
      {
        id: 'brann-weir',
        name: 'Бранн',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-brann' } },
      },
    ];
    const fresh: C[] = [
      { id: 'brann-wire-a', name: 'Бранн Уир' } as C,
      { id: 'brann-wire-b', name: 'Бранн Уир' } as C,
    ];
    const { characters: merged, retirements } =
      mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['brann-wire-a', 'brann-wire-b', 'brann-weir']);
    expect(merged.find((c) => c.id === 'brann-weir')!.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-brann' },
    });
    expect(merged.find((c) => c.id === 'brann-wire-a')!.overrideTtsVoices).toBeUndefined();
    expect(merged.find((c) => c.id === 'brann-wire-b')!.overrideTtsVoices).toBeUndefined();
    expect(retirements).toEqual([]);
  });

  it('id drift: a voiced prior row wins the match over a same-name unvoiced sibling — no regression (#2040 Task 12)', () => {
    // Two dropped prior rows share the name "Alden": one carries a designed
    // voice, one carries none. Widening the candidate set past
    // isVoicedOrReused must NOT turn this into an ambiguous case — spec §9's
    // named hazard is exactly this stranding a designed voice as a 0-line
    // duplicate. The voiced row must still be the candidate, exactly as
    // before the widening.
    const existing: C[] = [
      {
        id: 'alden-voiced',
        name: 'Alden',
        voiceState: 'tuned',
        voiceUuid: 'U-alden',
        overrideTtsVoices: { qwen: { name: 'qwen-alden' } },
      },
      { id: 'alden-plain', name: 'Alden' },
    ];
    const fresh: C[] = [{ id: 'alden-new', name: 'Alden' } as C];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['alden-new']);
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-alden' } });
    expect(merged[0].voiceState).toBe('tuned');
    expect(retirements).toEqual([{ from: 'alden-voiced', to: 'alden-new' }]);
  });

  it('id drift: a notLinkedTo edge on the PRIOR row blocks the name-fallback match (#2040 Task 12 follow-up)', () => {
    // Real on-disk shape written by POST /not-linked-to (cast-not-linked-to.ts:238).
    // Without this guard, widening past isVoicedOrReused (this same task) lets
    // the fallback silently override a user's explicit "not the same person"
    // decision — and durably, since the match now also calls
    // retireCharacterId (spec §9's "durability" hazard).
    const existing: C[] = [
      {
        id: 'alden-old',
        name: 'Alden',
        aliases: ['Al'],
        notLinkedTo: [{ bookId: 'book-1', characterId: 'alden-new' }],
      },
    ];
    const fresh: C[] = [{ id: 'alden-new', name: 'Alden' } as C];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['alden-new']); // no orphan (unvoiced), no weld
    expect(merged[0].aliases).toBeUndefined(); // the edge blocks the weld
    expect(retirements).toEqual([]);
  });

  it('id drift: a notLinkedTo edge on the FRESH row also blocks the match (symmetry, #2040 Task 12 follow-up)', () => {
    // Same scenario, but the edge is recorded on the fresh side (e.g. seeded
    // by seedReuseGuardsFromPriorCast earlier in the same run) rather than
    // the prior side. Isolates the second half of the OR check.
    const existing: C[] = [{ id: 'alden-old', name: 'Alden', aliases: ['Al'] }];
    const fresh: C[] = [
      {
        id: 'alden-new',
        name: 'Alden',
        notLinkedTo: [{ bookId: 'book-1', characterId: 'alden-old' }],
      } as C,
    ];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['alden-new']);
    expect(merged[0].aliases).toBeUndefined();
    expect(retirements).toEqual([]);
  });

  it('id drift: a dropped narrator row never becomes a name-fallback candidate (#2040 Task 12 follow-up, L1)', () => {
    // The prior narrator (id 'narrator') carries only voiceStyle — which
    // isVoicedOrReused does NOT test, so before this task's widening the
    // narrator was never voiced/reused enough to be a candidate at all. The
    // widening newly admits it via the lone-unvoiced-row branch. If the fresh
    // roster has no narrator row this run but happens to contain a REAL
    // character whose normalised name collides with the prior narrator's
    // localized default name (an English book's character actually named
    // "Narrator"), the dropped narrator row would otherwise be the sole
    // candidate for that name and weld its voiceStyle onto the real
    // character while durably retiring the reserved 'narrator' id onto it.
    const existing: C[] = [{ id: 'narrator', name: 'Narrator', voiceStyle: 'crisp herald' }];
    const fresh: C[] = [{ id: 'sasha', name: 'Narrator' } as C];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    expect(merged.map((c) => c.id)).toEqual(['sasha']);
    expect(merged[0].voiceStyle).toBeUndefined(); // the narrator's voiceStyle must not weld on
    expect(retirements).toEqual([]); // the reserved 'narrator' id must not be retired away
  });

  it('id drift: a fresh narrator-id row never adopts a dropped real character via the name-fallback (#2040 Task 12 follow-up, L1 fresh side)', () => {
    // This direction PRE-DATES Task 12 — a voiced real character already
    // satisfied the pre-Task-12 isVoicedOrReused precondition, so nothing
    // ever excluded narrator on the fresh side; the widening did not create
    // this exposure. Closed here anyway because it's the exact mirror of
    // the candidate-side fix just landed, in the same block: a real
    // character named "Erzähler" matched onto the fresh 'narrator' row
    // would retire the REAL character's id to 'narrator' — every frozen
    // segment that character ever rendered would then resolve to the
    // narrator, precisely #2040's original bug. The reserved narrator id
    // is code-seeded (NARRATOR_CHARACTER_IDS), never analyzer-minted, so
    // there is no legitimate id-drift case here for the fallback to rescue.
    const existing: C[] = [
      {
        id: 'erzahler-char',
        name: 'Erzähler',
        voiceState: 'tuned',
        voiceUuid: 'U-erzahler',
        overrideTtsVoices: { qwen: { name: 'qwen-erzahler' } },
      },
    ];
    const fresh: C[] = [
      { id: 'narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' } as C,
    ];
    const { characters: merged, retirements } = mergeAnalysisResultWithExistingCast(
      existing,
      fresh,
    );
    // Blocked match, voiced row -> carried forward as its own orphan under
    // its OWN id, same as any other blocked-match voiced row (mirrors the
    // pre-existing "ambiguous name ... re-adds the orphan" test above) —
    // not lost, and critically not welded onto the reserved narrator id.
    expect(merged.map((c) => c.id).sort()).toEqual(['erzahler-char', 'narrator']);
    expect(merged.find((c) => c.id === 'narrator')!.voiceUuid).toBeUndefined();
    expect(merged.find((c) => c.id === 'erzahler-char')!.voiceUuid).toBe('U-erzahler');
    expect(retirements).toEqual([]); // the real character's id must not be retired onto 'narrator'
  });
});

describe('overlayInterimCastForLiveView (srv-87, #2086)', () => {
  it('keeps BOTH the prior voiced row and the drifted fresh row — no id-drift name-fallback', () => {
    // Same coalfall/coalfall-dragon shape as the authoritative-merge id-drift
    // test above, but the interim overlay must NOT weld the two together —
    // an interim roster is partial by construction, so a "dropped" prior row
    // may simply not have been reached yet.
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        voiceId: 'coalfall',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    const fresh: C[] = [{ id: 'coalfall-dragon', name: 'Coalfall', lines: 0 } as C];
    const merged = overlayInterimCastForLiveView(existing, fresh);
    expect(merged.map((c) => c.id).sort()).toEqual(['coalfall', 'coalfall-dragon']);
    // The prior row keeps its own voice under its own id — nothing rode onto
    // the fresh row.
    const prior = merged.find((c) => c.id === 'coalfall')!;
    expect(prior.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-coalfall' } });
    const drifted = merged.find((c) => c.id === 'coalfall-dragon')!;
    expect(drifted.overrideTtsVoices).toBeUndefined();
  });

  it('returns the fresh roster unchanged when existing is empty', () => {
    const fresh: C[] = [{ id: 'wren', name: 'Wren' }];
    expect(overlayInterimCastForLiveView([], fresh)).toBe(fresh);
  });

  it('still drops an UNVOICED prior row the fresh roster omitted — no fallback rescue', () => {
    // Without the name-fallback, an unvoiced dropped row is simply absent —
    // same as the authoritative merge's own "does NOT re-add" behaviour for
    // unvoiced rows, but here even a same-name fresh row must not rescue it.
    const existing: C[] = [{ id: 'alden-old', name: 'Alden', aliases: ['Al'] }];
    const fresh: C[] = [{ id: 'alden-new', name: 'Alden' } as C];
    const merged = overlayInterimCastForLiveView(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['alden-new']);
    expect(merged[0].aliases).toBeUndefined(); // no name-fallback match => no alias ride-over
  });

  it('parity: on a no-drift fixture, matches mergeAnalysisResultWithExistingCast(...).characters exactly', () => {
    // The anti-drift guard for the two code paths not silently diverging
    // later — with no id drift there is nothing for the name-fallback to
    // do, so both entry points must produce byte-identical output. Covers
    // alias union and the narrator-name carry-forward too — not just the
    // exact-id overlay + preserved-voice-fields path — so a future change to
    // either of those branches inside mergeCore can't silently diverge the
    // two entry points without this test noticing.
    const existing: C[] = [
      {
        id: 'berrin',
        name: 'Berrin',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
        lines: 58,
        aliases: ['B'],
      },
      { id: 'wisp', name: 'Wisp', voiceId: 'wisp', voiceState: 'reused' },
      { id: 'narrator', name: 'The Bard', voiceStyle: 'crisp herald' },
    ];
    const fresh: C[] = [
      { id: 'berrin', name: 'Berrin', lines: 61, aliases: ['Berrin B.'] },
      { id: 'wisp', name: 'Wisp', lines: 12 },
      { id: 'new-char', name: 'New Char', lines: 3 },
      { id: 'narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' },
    ];
    const interim = overlayInterimCastForLiveView(existing, fresh);
    const authoritative = mergeAnalysisResultWithExistingCast(existing, fresh).characters;
    expect(interim).toEqual(authoritative);
    // Sanity: confirm the widened fixture actually exercises what it claims to
    // — a vacuous parity check (e.g. both sides silently ignoring aliases)
    // would still pass the equality assertion above.
    const berrin = interim.find((c) => c.id === 'berrin')!;
    expect(berrin.aliases).toEqual(expect.arrayContaining(['B', 'Berrin B.']));
    const narrator = interim.find((c) => c.id === 'narrator')!;
    expect(narrator.name).toBe('The Bard'); // non-default prior name carried forward
  });
});

describe('mergeAnalysisResultWithExistingCast — narrator name', () => {
  it('carries forward a user-renamed narrator across reparse', () => {
    const existing = [{ id: 'narrator', name: 'The Bard', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    const n = merged.find((c) => c.id === 'narrator')!;
    expect(n.name).toBe('The Bard');
    expect((n as { voiceStyle?: string }).voiceStyle).toBe('crisp herald');
  });

  it('takes the fresh name when the prior narrator name was a language default (re-localizes)', () => {
    const existing = [{ id: 'narrator', name: 'Erzähler', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Narrateur', role: 'narrator', color: 'narrator' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'narrator')!.name).toBe('Narrateur');
  });

  it('does NOT carry forward a non-narrator character name (still recomputed from fresh)', () => {
    const existing = [{ id: 'wren', name: 'Old Wren', voiceId: 'v1' }];
    const fresh = [{ id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'wren')!.name).toBe('Wren');
  });

  it('carries forward a user-renamed narrator across reparse — char-narrator id (#1895)', () => {
    const existing = [{ id: 'char-narrator', name: 'The Bard', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'char-narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'char-narrator')!.name).toBe('The Bard');
  });
});

describe('seedReuseGuardsFromPriorCast', () => {
  it('seeds notLinkedTo and matchedFrom onto the fresh roster in place', () => {
    const existing: C[] = [
      {
        id: 'wren',
        notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }],
        matchedFrom: { bookId: 'b0', characterId: 'wren', confidence: 0.9 },
      },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'wren-teen' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'wren', confidence: 0.9 });
  });

  it('does not overwrite a guard field the fresh roster already carries', () => {
    const existing: C[] = [{ id: 'a', matchedFrom: { bookId: 'old', characterId: 'a' } }];
    const fresh: C[] = [{ id: 'a', matchedFrom: { bookId: 'new', characterId: 'a' } }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('new');
  });

  it('seeds onto a same-name survivor when the id was remapped by dedup (collapsed-source)', () => {
    const existing: C[] = [
      {
        id: 'olga',
        name: 'Ольга',
        notLinkedTo: [{ bookId: 'b1', characterId: 'other' }],
        matchedFrom: { bookId: 'b0', characterId: 'olga', confidence: 0.8 },
      },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'other' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga', confidence: 0.8 });
  });

  it('does NOT use the name-fallback when two fresh rows share a name (ambiguous — pre-dedup main route)', () => {
    const existing: C[] = [{ id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } }];
    const fresh: C[] = [
      { id: 'olga', name: 'Ольга' },
      { id: 'ольга', name: 'Ольга' },
    ];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga' }); // id match still works
    expect(fresh[1].matchedFrom).toBeUndefined(); // ambiguous fresh name → not seeded
  });

  it('does NOT use the name-fallback when two prior rows share a name (ambiguous source)', () => {
    const existing: C[] = [
      { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } },
      { id: 'olga2', name: 'Ольга', matchedFrom: { bookId: 'b9', characterId: 'olga2' } },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].matchedFrom).toBeUndefined();
  });

  it('id match takes precedence over the name-fallback', () => {
    const existing: C[] = [
      { id: 'ольга', name: 'Ольга', matchedFrom: { bookId: 'right', characterId: 'ольга' } },
      { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'wrong', characterId: 'olga' } },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('right');
  });
});

describe('voicedSurvivorsDropped', () => {
  it('lists only voiced/reused characters the fresh roster omitted', () => {
    const existing: C[] = [
      { id: 'wren', name: 'Wren', voiceId: 'wren' }, // survives
      { id: 'wisp', name: 'Wisp', voiceState: 'reused', voiceId: 'wisp' }, // dropped + voiced
      { id: 'extra', name: 'Extra' }, // dropped but no voice
    ];
    const fresh: C[] = [{ id: 'wren' }];
    expect(voicedSurvivorsDropped(existing, fresh)).toEqual([{ id: 'wisp', name: 'Wisp' }]);
  });

  it("lets a fresh reuse-link stand when the old character had no voice", () => {
    // linkSeriesReuseAtAnalysis may have stamped a NEW reuse on the fresh roster
    // for a character that previously had no voice — don't clobber it with the
    // (absent) old value.
    const existing: C[] = [{ id: 'hart', name: 'Hart' }]; // no voice
    const fresh: C[] = [{ id: 'hart', name: 'Hart', voiceId: 'hart', voiceState: 'reused' }];
    const { characters: merged } = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('hart');
    expect(merged[0].voiceState).toBe('reused');
  });

  it('returns the fresh roster unchanged when there is no existing cast', () => {
    const fresh: C[] = [{ id: 'a' }, { id: 'b' }];
    expect(mergeAnalysisResultWithExistingCast([], fresh).characters).toEqual(fresh);
  });
});

describe('applyRewriteToPriorCast', () => {
  it('plain rename reports a retirement (#2040 Task 8)', () => {
    const prior = [{ id: 'mairin', name: 'Mairin', voiceState: 'tuned' }];
    const { retirements } = applyRewriteToPriorCast(prior, { mairin: 'mayrin' });
    expect(retirements).toEqual([{ from: 'mairin', to: 'mayrin' }]);
  });

  it('its collision path reports the LOSER\'s id rather than silently dropping it at :274 (#2040 Task 8)', () => {
    // The winner already sits at the canonical id (no rewrite entry of its
    // own); only the loser is remapped onto it. Without recording this, the
    // loser's original id — still referenced by a frozen segments.json or the
    // analysis cache — would have no path back to the surviving character.
    const prior = [
      { id: 'mairin', name: 'Mairin', voiceState: 'generated' }, // loses (weaker)
      { id: 'mayrin', name: 'Mayrin', voiceState: 'locked' }, // wins (stronger), already canonical
    ];
    const { priorCast, droppedVoices, retirements } = applyRewriteToPriorCast(prior, {
      mairin: 'mayrin',
    });
    expect(priorCast.map((c) => c.id)).toEqual(['mayrin']);
    expect(droppedVoices).toEqual([{ id: 'mairin', voiceState: 'generated' }]);
    expect(retirements).toEqual([{ from: 'mairin', to: 'mayrin' }]);
  });

  it('remaps prior ids and keeps the strongest voiceState on collision', () => {
    const prior = [
      { id: 'olga', name: 'Ольга', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'qwen-gen' } } },
      { id: 'ольга', name: 'Ольга', voiceState: 'tuned', overrideTtsVoices: { qwen: { name: 'qwen-tuned' } } },
    ];
    const { priorCast, droppedVoices } = applyRewriteToPriorCast(prior, { olga: 'ольга' });
    const survivor = priorCast.find((c) => c.id === 'ольга');
    expect(survivor?.overrideTtsVoices?.qwen?.name).toBe('qwen-tuned'); // tuned beats generated
    expect(priorCast.filter((c) => c.id === 'ольга')).toHaveLength(1); // no duplicate id
    expect(droppedVoices).toEqual([{ id: 'olga', voiceState: 'generated' }]);
  });
});

describe('dropReuseContinuityKeepDesignedVoice (fresh re-analysis prior)', () => {
  it('keeps the designed voice but drops reuse continuity + reused state', () => {
    const prior: C[] = [
      {
        id: 'anton',
        name: 'Anton',
        voiceUuid: 'U1',
        ttsEngine: 'qwen',
        voiceStyle: 'a persona',
        overrideTtsVoices: { qwen: { name: 'qwen-U1', variants: { excited: { name: 'qwen-U1__excited' } } } },
        voiceId: 'library-voice',
        voiceState: 'reused',
        matchedFrom: { bookId: 'prior', characterId: 'anton', confidence: 0.9 },
        notLinkedTo: ['someone'],
      },
    ];
    const [out] = dropReuseContinuityKeepDesignedVoice(prior);
    // designed voice kept
    expect(out.voiceUuid).toBe('U1');
    expect(out.ttsEngine).toBe('qwen');
    expect(out.voiceStyle).toBe('a persona');
    expect(out.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-U1', variants: { excited: { name: 'qwen-U1__excited' } } },
    });
    // reuse continuity dropped
    expect(out.voiceId).toBeUndefined();
    expect(out.matchedFrom).toBeUndefined();
    expect(out.notLinkedTo).toBeUndefined();
    expect(out.voiceState).toBeUndefined(); // 'reused' cleared
  });

  it("keeps a bespoke 'locked'/'tuned' voiceState (not reuse-derived)", () => {
    const prior: C[] = [
      { id: 'a', name: 'A', voiceState: 'locked', overrideTtsVoices: { qwen: { name: 'q-a' } } },
      { id: 'b', name: 'B', voiceState: 'tuned', voiceUuid: 'Ub' },
    ];
    const out = dropReuseContinuityKeepDesignedVoice(prior);
    expect(out[0].voiceState).toBe('locked');
    expect(out[1].voiceState).toBe('tuned');
  });

  it('does not mutate the input', () => {
    const prior: C[] = [
      { id: 'a', name: 'A', voiceId: 'v', matchedFrom: { bookId: 'x' }, voiceUuid: 'U' },
    ];
    dropReuseContinuityKeepDesignedVoice(prior);
    expect(prior[0].voiceId).toBe('v');
    expect(prior[0].matchedFrom).toEqual({ bookId: 'x' });
  });
});

describe('dedupePriorCastByName', () => {
  it('reports the loser\'s id as a retirement, not merely a `dropped` log entry (#2040 Task 8)', () => {
    // Round 3's finding: the fourth collapse site pushed the loser's id into
    // `dropped` (a log array nothing else reads) and `continue`d past the
    // row — no path from the loser's id back to the survivor. Pin that the
    // retirement is now reported so the caller can record it.
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, retirements } = dedupePriorCastByName(prior);
    expect(cast.map((c) => c.id)).toEqual(['anton']); // stronger voiceState survives
    expect(retirements).toEqual([{ from: 'антон', to: 'anton' }]);
  });

  it('collapses two same-name voiced rows to one survivor', () => {
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('anton'); // stronger voiceState survives
    expect(cast[0].voiceUuid).toBe('U1');
    expect(dropped.map((d) => d.id)).toEqual(['антон']);
  });

  it('prefers a bespoke designed voice over a reuse link (Coalfall guard)', () => {
    const prior: C[] = [
      { id: 'a-reused', name: 'Света', voiceState: 'reused', voiceId: 'lib-1' },
      {
        id: 'a-bespoke',
        name: 'Света',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'q-sveta' } },
      },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('a-bespoke'); // bespoke beats reuse despite weaker voiceState
    expect(cast[0].overrideTtsVoices).toEqual({ qwen: { name: 'q-sveta' } });
  });

  it('folds the dropped row name into the survivor aliases', () => {
    const prior: C[] = [
      { id: 'boris', name: 'Борис Игнатьевич', voiceState: 'tuned', lines: 30, aliases: ['шеф'] },
      { id: 'boris-2', name: 'Борис Игнатьевич', voiceState: 'generated', lines: 1, aliases: ['Гесер'] },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].aliases).toEqual(expect.arrayContaining(['шеф', 'Гесер']));
    // survivor's own name is NOT folded in as a redundant alias
    expect(cast[0].aliases).not.toContain('Борис Игнатьевич');
  });

  it('does NOT collapse a notLinkedTo-separated same-name pair', () => {
    const prior: C[] = [
      { id: 'john-a', name: 'John', voiceState: 'tuned', notLinkedTo: [{ bookId: 'b', characterId: 'john-b' }] },
      { id: 'john-b', name: 'John', voiceState: 'tuned' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('never collapses narrator rows sharing a name', () => {
    const prior: C[] = [
      { id: 'narrator', name: 'Narrator', voiceState: 'tuned' },
      { id: 'char-narrator', name: 'Narrator', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('excludes a char-narrator row from grouping even when a REAL character shares its name (#1895)', () => {
    /* Discriminating fixture: unlike the narrator-vs-narrator pair above (a
       size-1 group either way, so it can't tell isNarrator's id-check apart
       from a no-op), this narrator shares its name with an UNRELATED real
       character. If 'char-narrator' were ever NOT recognised as a narrator
       id, it would fall into the same name-group as 'sasha-2' (group size
       2) and get collapsed away — losing the narrator row entirely. */
    const prior: C[] = [
      { id: 'char-narrator', name: 'Sasha', voiceState: 'tuned' },
      { id: 'sasha-2', name: 'Sasha', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast.map((c) => c.id).sort()).toEqual(['char-narrator', 'sasha-2']);
  });

  it('leaves distinct names untouched and preserves order', () => {
    const prior: C[] = [
      { id: 'a', name: 'Alice', voiceState: 'tuned' },
      { id: 'b', name: 'Bob', voiceState: 'tuned' },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
    expect(cast.map((c) => c.id)).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('collapses accent-variant spellings (normaliseNameKey deburrs Latin)', () => {
    const prior: C[] = [
      { id: 'cafe', name: 'Cafe', voiceState: 'generated', voiceUuid: 'U2' },
      { id: 'café', name: 'Café', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
  });

  it('composition: collapsed prior + merge yields no 0-line duplicate, voice on fresh survivor', () => {
    // Prior cast has the legacy duplicate (both voiced); fresh roster has one
    // canonical Антон (post-dedup). Today merge re-adds the extra as a 0-line dup.
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'q2' } }, lines: 2 },
    ];
    const fresh: C[] = [{ id: 'антон', name: 'Антон', lines: 55 }]; // fresh survivor id
    const collapsed = dedupePriorCastByName(prior).cast;
    const { characters: merged } = mergeAnalysisResultWithExistingCast(collapsed, fresh);
    expect(merged.filter((c) => c.name === 'Антон')).toHaveLength(1);
    expect(merged[0].voiceUuid).toBe('U1'); // strongest bespoke voice rode onto the fresh survivor
    expect(merged[0].lines).toBe(55); // fresh attribution wins
  });

  it('composition: a voiceUuid-only (generated) survivor whose id differs from fresh still bridges its voice', () => {
    // Regression guard: hasBespokeVoice ranks a voiceUuid-only row as bespoke, so
    // it can win the collapse; the merge's name-fallback must recognise voiceUuid
    // (isVoicedOrReused fix) or the fresh row is written voiceless.
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'generated', voiceUuid: 'U9', lines: 40 },
      { id: 'антон-old', name: 'Антон', voiceState: 'reused', voiceId: 'lib-1', lines: 1 },
    ];
    const fresh: C[] = [{ id: 'антон', name: 'Антон', lines: 50 }]; // id differs from both prior rows
    const collapsed = dedupePriorCastByName(prior).cast;
    expect(collapsed[0].id).toBe('anton'); // voiceUuid (rank 3) beats reused (rank 2)
    const { characters: merged } = mergeAnalysisResultWithExistingCast(collapsed, fresh);
    expect(merged.filter((c) => c.name === 'Антон')).toHaveLength(1);
    expect(merged[0].voiceUuid).toBe('U9'); // bridged despite voiceState generated + id drift
  });
});
