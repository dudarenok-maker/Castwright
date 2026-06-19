/* srv-13 / plan 126 Facet A — analysis-time cross-book reuse linking.

   Unit-level: drives linkSeriesReuseAtAnalysis with injected scanners so the
   matcher + guards are exercised without a real workspace. Asserts:
     - a later book whose new character recurs by name against a prior
       (earlier-position) confirmed character gets matchedFrom + a unified
       voiceId + voiceState:'reused' + the denormalised bespoke qwen voice;
     - a notLinkedTo pair is never auto-linked;
     - the earliest (origin) book gets no links;
     - unknown-male/female buckets and already-linked / tuned characters are
       left alone. */

import { describe, it, expect } from 'vitest';
import {
  linkSeriesReuseAtAnalysis,
  pruneStaleReuseLinks,
  type LinkableCharacter,
  type LinkSeriesReuseOptions,
} from './series-reuse-link.js';
import {
  seedReuseGuardsFromPriorCast,
  mergeAnalysisResultWithExistingCast,
} from '../store/merge-analysis-cast.js';
import type { LibraryCharacterRecord } from './library-cast-scan.js';

const AUTHOR = 'A';
const SERIES = 'S';
const BOOK1 = 'book-1';
const BOOK2 = 'book-2';

/* Prior confirmed cast living in book-1 (seriesPosition 1). Wren carries the
   designed qwen voice; Marlow is plain. */
const PRIOR_LIBRARY: LibraryCharacterRecord[] = [
  {
    bookId: BOOK1,
    bookTitle: 'Book One',
    character: {
      id: 'wren',
      name: 'Wren',
      gender: 'female',
      ageRange: 'teen',
      voiceId: 'wren',
    },
  },
  {
    bookId: BOOK1,
    bookTitle: 'Book One',
    character: { id: 'marlow', name: 'Marlow', gender: 'male', ageRange: 'teen' },
  },
];

function baseOptions(overrides: Partial<LinkSeriesReuseOptions> = {}): LinkSeriesReuseOptions {
  return {
    scanLibrary: async () => PRIOR_LIBRARY,
    resolveAuthorSeries: async () => ({ author: AUTHOR, series: SERIES }),
    positions: async () =>
      new Map<string, number | null>([
        [BOOK1, 1],
        [BOOK2, 2],
      ]),
    /* Source cast loader for the bespoke-voice denormalisation: book-1's Wren
       owns the qwen voice. */
    castLoader: async (bookId: string) =>
      bookId === BOOK1
        ? [
            {
              id: 'wren',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'voice_wren' } },
              voiceStyle: 'a poised, confident teenage girl',
            },
          ]
        : null,
    ...overrides,
  };
}

describe('linkSeriesReuseAtAnalysis (plan 126 Facet A)', () => {
  it('links a recurring same-name character and unifies voiceId + denormalises voice', async () => {
    const characters: LinkableCharacter[] = [
      { id: 'wren-new', name: 'Wren', gender: 'female', ageRange: 'teen' },
      { id: 'newbie', name: 'Pell', gender: 'male' }, // no prior match
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, baseOptions());
    expect(linked).toBe(1);

    const wren = characters[0];
    expect(wren.matchedFrom?.bookId).toBe(BOOK1);
    expect(wren.matchedFrom?.characterId).toBe('wren');
    expect(wren.voiceId).toBe('wren');
    expect(wren.voiceState).toBe('reused');
    /* Bespoke voice + persona denormalised from the source book (srv-18). */
    expect(wren.ttsEngine).toBe('qwen');
    expect(wren.overrideTtsVoices?.qwen?.name).toBe('voice_wren');
    expect(wren.voiceStyle).toBe('a poised, confident teenage girl');
    /* Prior name unioned into aliases (already same name → dropped as self). */
    expect(wren.aliases).toBeUndefined();

    /* Non-matching character untouched. */
    expect(characters[1].matchedFrom).toBeUndefined();
  });

  it('never auto-links a notLinkedTo pair', async () => {
    const characters: LinkableCharacter[] = [
      {
        id: 'wren-adult',
        name: 'Wren',
        gender: 'female',
        ageRange: 'adult',
        notLinkedTo: [{ bookId: BOOK1, characterId: 'wren' }],
      },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, baseOptions());
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
    expect(characters[0].voiceState).toBeUndefined();
  });

  it('produces no links for the earliest (origin) book', async () => {
    /* book-1 IS the earliest — there is no lower-positioned prior to match
       against, so the pass is a no-op even though the library is non-empty. */
    const characters: LinkableCharacter[] = [
      { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen' },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK1, characters, baseOptions());
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
  });

  it('skips unknown-male/female buckets and already-linked characters', async () => {
    const characters: LinkableCharacter[] = [
      { id: 'unknown-female', name: 'Wren' }, // bucket — never reused
      {
        id: 'wren-prelinked',
        name: 'Wren',
        matchedFrom: { bookId: 'other', characterId: 'x', confidence: 1 },
      },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, baseOptions());
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
    /* Existing link preserved, not overwritten. */
    expect(characters[1].matchedFrom?.bookId).toBe('other');
  });

  it('does not demote a tuned voice to reused but still stamps the link', async () => {
    const characters: LinkableCharacter[] = [
      { id: 'wren-tuned', name: 'Wren', gender: 'female', ageRange: 'teen', voiceState: 'tuned' },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, baseOptions());
    expect(linked).toBe(1);
    expect(characters[0].matchedFrom?.bookId).toBe(BOOK1);
    expect(characters[0].voiceState).toBe('tuned');
  });

  it('returns 0 for a standalone / out-of-library book', async () => {
    const characters: LinkableCharacter[] = [{ id: 'x', name: 'Wren' }];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, {
      ...baseOptions(),
      resolveAuthorSeries: async () => null,
    });
    expect(linked).toBe(0);
  });

  /* Stable-key continuity — the narrator (and any character that keeps its
     deterministic voiceId/id across books) must link even when the analyzer
     renames it to something with ZERO name-token overlap with the prior. This
     is the The Riptide narrator regression: prior books call it "Narrator", this
     book's analysis named it "Author" → the name scorer's 0.34 floor drops it,
     so the bespoke qwen voice silently fails to carry over. */
  it('links by stable voiceId even when the name has no token overlap (narrator rename)', async () => {
    const NARRATOR_LIBRARY: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'narrator', name: 'Narrator', voiceId: 'narrator' },
      },
    ];
    const options: LinkSeriesReuseOptions = {
      scanLibrary: async () => NARRATOR_LIBRARY,
      resolveAuthorSeries: async () => ({ author: AUTHOR, series: SERIES }),
      positions: async () =>
        new Map<string, number | null>([
          [BOOK1, 1],
          [BOOK2, 2],
        ]),
      castLoader: async (bookId: string) =>
        bookId === BOOK1
          ? [
              {
                id: 'narrator',
                ttsEngine: 'qwen',
                overrideTtsVoices: { qwen: { name: 'qwen-narrator' } },
                voiceStyle: 'a warm, articulate British narrator',
              },
            ]
          : null,
    };

    /* Analyzer renamed the narrator to "Author" but kept the stable id/voiceId. */
    const characters: LinkableCharacter[] = [
      { id: 'narrator', name: 'Author', voiceId: 'narrator', voiceState: 'tuned' },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, options);

    expect(linked).toBe(1);
    const narrator = characters[0];
    expect(narrator.matchedFrom?.bookId).toBe(BOOK1);
    expect(narrator.matchedFrom?.characterId).toBe('narrator');
    expect(narrator.ttsEngine).toBe('qwen');
    expect(narrator.overrideTtsVoices?.qwen?.name).toBe('qwen-narrator');
    expect(narrator.voiceStyle).toBe('a warm, articulate British narrator');
    /* A user-tuned voiceState is not demoted, but the link still stamps. */
    expect(narrator.voiceState).toBe('tuned');
  });

  /* A stable-key match must still respect an explicit notLinkedTo decision —
     the user's "not the same person" marker overrides even an id match. */
  it('does not stable-key link a notLinkedTo pair', async () => {
    const NARRATOR_LIBRARY: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'narrator', name: 'Narrator', voiceId: 'narrator' },
      },
    ];
    const options: LinkSeriesReuseOptions = {
      scanLibrary: async () => NARRATOR_LIBRARY,
      resolveAuthorSeries: async () => ({ author: AUTHOR, series: SERIES }),
      positions: async () =>
        new Map<string, number | null>([
          [BOOK1, 1],
          [BOOK2, 2],
        ]),
      castLoader: async () => null,
    };
    const characters: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Author',
        voiceId: 'narrator',
        notLinkedTo: [{ bookId: BOOK1, characterId: 'narrator' }],
      },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, options);
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
  });

  /* srv-13 — the fresh analyzer roster carries NO notLinkedTo, so without the
     pre-seed the link pass re-links a pair the user separated on a prior run.
     Seeding the guard fields from the prior cast first must prevent that. */
  it('respects a prior-run notLinkedTo once the guards are seeded from prior cast', async () => {
    // Fresh roster as the analyzer produces it: id matches a prior cast entry
    // that carries the user's "not the same person" decision, but the fresh
    // row itself has none.
    const fresh: LinkableCharacter[] = [
      { id: 'wren-adult', name: 'Wren', gender: 'female', ageRange: 'adult' },
    ];
    const priorCast = [
      {
        id: 'wren-adult',
        notLinkedTo: [{ bookId: BOOK1, characterId: 'wren' }],
      },
    ];

    // Without seeding: the pass wrongly links (regression we're guarding).
    const unguarded = [...fresh.map((c) => ({ ...c }))];
    expect(await linkSeriesReuseAtAnalysis(BOOK2, unguarded, baseOptions())).toBe(1);

    // With seeding: the decision is honoured, no link.
    seedReuseGuardsFromPriorCast(priorCast, fresh);
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, fresh, baseOptions());
    expect(linked).toBe(0);
    expect(fresh[0].matchedFrom).toBeUndefined();
  });
});

/* pruneStaleReuseLinks — a preserved matchedFrom (carried across re-analysis by
   seedReuseGuardsFromPriorCast) whose target is no longer a same-author /
   same-series EARLIER book is stale. It happens when a book is re-homed to
   another series or made standalone after the link was stamped (the Coalfall /
   narrator regression, 2026-06-09): the narrator stayed linked to a
   Shannon-Messenger book after the book moved to Castwright/Standalones, and
   neither re-analysis (preserves links by design) nor the UI unmatch (rejects
   non-series-mates) could clear it. */
describe('pruneStaleReuseLinks', () => {
  const COALFALL = 'castwright__standalones__coalfall';
  const BONUS = 'shannon__keeper__bonus';
  const KEEPER1 = 'shannon__keeper__book1';
  const KEEPER2 = 'shannon__keeper__book2';
  const META: Record<string, { author: string; series: string } | null> = {
    [COALFALL]: { author: 'Castwright', series: 'Standalones' },
    [BONUS]: { author: 'Della Renwick', series: 'The Hollow Tide' },
    [KEEPER1]: { author: 'Della Renwick', series: 'The Hollow Tide' },
    [KEEPER2]: { author: 'Della Renwick', series: 'The Hollow Tide' },
  };
  const opts = (): LinkSeriesReuseOptions => ({
    resolveAuthorSeries: async (id) => META[id] ?? null,
    positions: async () =>
      new Map<string, number | null>([
        [BONUS, 1],
        [KEEPER1, 1],
        [KEEPER2, 2],
        [COALFALL, null],
      ]),
  });

  it('drops a cross-series stale link and reverts a pure-reuse voice to fresh', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        voiceId: 'narrator',
        voiceState: 'reused',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-narrator' } },
        voiceStyle: 'British female',
        matchedFrom: { bookId: BONUS, characterId: 'narrator', bookTitle: 'Bonus', confidence: 0.92 },
      },
    ];
    const dropped = await pruneStaleReuseLinks(COALFALL, chars, opts());
    expect(dropped).toBe(1);
    const n = chars[0];
    expect(n.matchedFrom).toBeFalsy();
    expect(n.voiceState).toBe('generated');
    expect(n.voiceId).toBe('narrator');
    expect(n.overrideTtsVoices).toBeFalsy();
    expect(n.voiceStyle).toBeFalsy();
  });

  /* The fix: analysis prunes the PRIOR cast before merging it into cast.json.
     Without it, mergeAnalysisResultWithExistingCast re-overlays the stale
     `matchedFrom` (+ its denormalised voice) straight from the prior, undoing
     the roster-side prune — the real "Pell Hollis (standalone) keeps Saltgrave's
     Pell voice across every re-analysis" bug. */
  const stalePellPrior = (): LinkableCharacter[] => [
    {
      id: 'pell-hollis',
      name: 'Pell Hollis',
      voiceId: 'pell',
      voiceState: 'reused',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-pell' } },
      voiceStyle: 'teen male',
      matchedFrom: { bookId: BONUS, characterId: 'pell', bookTitle: 'Bonus', confidence: 0.48 },
    },
  ];
  const freshPell = () => [
    { id: 'pell-hollis', name: 'Pell Hollis', voiceState: 'generated' as const },
  ];
  type MergeExisting = Parameters<typeof mergeAnalysisResultWithExistingCast>[0];

  it('prune-then-merge: a cross-series link does NOT resurrect via the cast.json merge', async () => {
    const prior = stalePellPrior();
    await pruneStaleReuseLinks(COALFALL, prior, opts());
    const merged = mergeAnalysisResultWithExistingCast(prior as unknown as MergeExisting, freshPell());
    const t = merged[0] as Record<string, unknown>;
    expect(t.matchedFrom).toBeFalsy();
    expect(t.overrideTtsVoices).toBeFalsy();
  });

  it('sanity: WITHOUT the prune, the merge would have carried the stale link', async () => {
    const merged = mergeAnalysisResultWithExistingCast(
      stalePellPrior() as unknown as MergeExisting,
      freshPell(),
    );
    const t = merged[0] as Record<string, unknown>;
    expect(t.matchedFrom).toBeTruthy();
    expect((t.overrideTtsVoices as { qwen?: { name?: string } })?.qwen?.name).toBe('qwen-pell');
  });

  it('keeps a valid same-series earlier-book link', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'reused',
        matchedFrom: { bookId: KEEPER1, characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
      },
    ];
    const dropped = await pruneStaleReuseLinks(KEEPER2, chars, opts());
    expect(dropped).toBe(0);
    expect(chars[0].matchedFrom?.bookId).toBe(KEEPER1);
    expect(chars[0].voiceState).toBe('reused');
  });

  it('drops a forward/sideways same-series link (target not strictly earlier)', async () => {
    /* book-1 wrongly linked to book-2 (later) — the linker only makes
       earlier-only links, so a preserved forward link is stale. */
    const chars: LinkableCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'reused',
        matchedFrom: { bookId: KEEPER2, characterId: 'wren', bookTitle: 'Book Two', confidence: 1 },
      },
    ];
    const dropped = await pruneStaleReuseLinks(KEEPER1, chars, opts());
    expect(dropped).toBe(1);
    expect(chars[0].matchedFrom).toBeFalsy();
  });

  it('drops the stale badge but preserves a user-tuned voice', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'my-custom-voice' } },
        matchedFrom: { bookId: BONUS, characterId: 'narrator', bookTitle: 'Bonus', confidence: 0.9 },
      },
    ];
    const dropped = await pruneStaleReuseLinks(COALFALL, chars, opts());
    expect(dropped).toBe(1);
    expect(chars[0].matchedFrom).toBeFalsy();
    /* User's own voice is untouched — only the stale link badge is removed. */
    expect(chars[0].voiceState).toBe('tuned');
    expect(chars[0].overrideTtsVoices?.qwen?.name).toBe('my-custom-voice');
  });

  it('is a no-op when there are no links to check', async () => {
    const chars: LinkableCharacter[] = [{ id: 'oduvan', name: 'Oduvan', voiceState: 'generated' }];
    expect(await pruneStaleReuseLinks(COALFALL, chars, opts())).toBe(0);
  });
});

/* srv-43 — voiceUuid propagation through series reuse and clearStaleLink. */
describe('srv-43: voiceUuid propagation', () => {
  /* A prior confirmed character in book-1 carries voiceUuid 'U1'. After
     linkSeriesReuseAtAnalysis runs on book-2, the matched character should
     inherit that same uuid so both books resolve to ONE .pt file. */
  it('reused character inherits the source voiceUuid via projectVoice', async () => {
    const PRIOR_WITH_UUID: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: {
          id: 'wren',
          name: 'Wren',
          gender: 'female',
          ageRange: 'teen',
          voiceId: 'wren',
          voiceUuid: 'U1',
        },
      },
    ];
    const options: LinkSeriesReuseOptions = {
      ...baseOptions(),
      scanLibrary: async () => PRIOR_WITH_UUID,
      castLoader: async (bookId: string) =>
        bookId === BOOK1
          ? [
              {
                id: 'wren',
                ttsEngine: 'qwen' as const,
                voiceUuid: 'U1',
                overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
                voiceStyle: 'a poised, confident teenage girl',
              },
            ]
          : null,
    };

    const characters: LinkableCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen' }];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, options);
    expect(linked).toBe(1);
    expect(characters[0].voiceUuid).toBe('U1');
  });

  /* clearStaleLink on a 'reused' character must drop voiceUuid so the next
     ensureCharacterVoiceUuid call mints a FRESH one, not the old shared value. */
  it('clearStaleLink on a reused character drops voiceUuid', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        voiceId: 'narrator',
        voiceUuid: 'OLD-UUID',
        voiceState: 'reused',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-narrator' } },
        voiceStyle: 'British female',
        matchedFrom: { bookId: BOOK1, characterId: 'narrator', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];

    /* pruneStaleReuseLinks calls clearStaleLink — drive it through the public API. */
    const droppedCount = await pruneStaleReuseLinks(BOOK2, chars, {
      resolveAuthorSeries: async (id) => (id === BOOK2 ? { author: AUTHOR, series: SERIES } : null),
      positions: async () =>
        new Map<string, number | null>([
          [BOOK1, 1],
          [BOOK2, 2],
        ]),
    });
    expect(droppedCount).toBe(1);
    expect(chars[0].voiceUuid).toBeUndefined();
    expect(chars[0].voiceState).toBe('generated');
  });

  /* A tuned/locked character keeps its voiceUuid when clearStaleLink is called —
     only the stale badge is stripped, not the user-owned voice identity. */
  it('clearStaleLink on a tuned character preserves voiceUuid', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        voiceUuid: 'TUNED-UUID',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'my-custom-voice' } },
        matchedFrom: { bookId: BOOK1, characterId: 'narrator', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];

    const droppedCount = await pruneStaleReuseLinks(BOOK2, chars, {
      resolveAuthorSeries: async (id) => (id === BOOK2 ? { author: AUTHOR, series: SERIES } : null),
      positions: async () =>
        new Map<string, number | null>([
          [BOOK1, 1],
          [BOOK2, 2],
        ]),
    });
    expect(droppedCount).toBe(1);
    /* tuned voice keeps its uuid */
    expect(chars[0].voiceUuid).toBe('TUNED-UUID');
    expect(chars[0].voiceState).toBe('tuned');
  });
});
