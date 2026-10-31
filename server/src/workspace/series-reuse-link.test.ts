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
  applyRewriteToPriorCast,
  dropReuseContinuityKeepDesignedVoice,
} from '../store/merge-analysis-cast.js';
import { remapFreshToPriorIds } from '../store/remap-fresh-to-prior.js';
import {
  composeRewrites,
  dedupeRosterByName,
  stripEstablishedAsciiRewrites,
} from '../analyzer/roster-dedup.js';
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

  /* fs-61 regression (2026-07-07): the per-language Coalfall demo books all
     share `author: "Castwright"` + the synthetic `series: "Standalones"`
     folder name, so an (author, series) match alone treated them as series-
     mates — auto-linking a Spanish/Russian character to the English book's
     Qwen voice. Qwen bakes its design language into the .pt, so the reused
     voice read the wrong language (garbled audio). isStandaloneBookId must
     veto the link even when author+series otherwise match. */
  it('never links between two standalones sharing the synthetic "Standalones" series', async () => {
    const characters: LinkableCharacter[] = [
      { id: 'wren-new', name: 'Wren', gender: 'female', ageRange: 'teen' },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, {
      ...baseOptions(),
      isStandaloneBookId: async () => true,
    });
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
  });

  /* fs-61 defense-in-depth: a language mismatch vetoes a link even between
     two REAL (non-standalone) series-mates — Qwen bakes its design language
     into the .pt, so this must never depend solely on the standalone check. */
  it('never links across a language boundary, even within a real series', async () => {
    const characters: LinkableCharacter[] = [
      { id: 'wren-new', name: 'Wren', gender: 'female', ageRange: 'teen' },
    ];
    const linked = await linkSeriesReuseAtAnalysis(BOOK2, characters, {
      ...baseOptions(),
      resolveBookLanguage: async (id) => (id === BOOK1 ? 'en' : 'es'),
    });
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
    const { characters: merged } = mergeAnalysisResultWithExistingCast(
      prior as unknown as MergeExisting,
      freshPell(),
    );
    const t = merged[0] as Record<string, unknown>;
    expect(t.matchedFrom).toBeFalsy();
    expect(t.overrideTtsVoices).toBeFalsy();
  });

  it('sanity: WITHOUT the prune, the merge would have carried the stale link', async () => {
    const { characters: merged } = mergeAnalysisResultWithExistingCast(
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

  /* fs-61 regression (2026-07-07): two DIFFERENT standalone books (e.g. the
     English and Spanish Coalfall demo books) both resolve to the same
     (author: "Castwright", series: "Standalones") pair — that placeholder
     match must never count as "same series" continuity. Without the
     isStandaloneBookId veto, this stale link would be KEPT (sameSeries
     would be true) instead of dropped. */
  it('drops a stale link between two standalones sharing the synthetic series', async () => {
    const SIBLING = 'castwright__standalones__el-encargo-de-coalfall';
    const chars: LinkableCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrador',
        voiceState: 'reused',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-narrator' } },
        matchedFrom: {
          bookId: SIBLING,
          characterId: 'narrator',
          bookTitle: 'El Encargo de Coalfall',
          confidence: 1,
        },
      },
    ];
    const dropped = await pruneStaleReuseLinks(COALFALL, chars, {
      ...opts(),
      resolveAuthorSeries: async (id) =>
        id === SIBLING ? { author: 'Castwright', series: 'Standalones' } : (META[id] ?? null),
      isStandaloneBookId: async (id) => id === COALFALL || id === SIBLING,
    });
    expect(dropped).toBe(1);
    expect(chars[0].matchedFrom).toBeFalsy();
    expect(chars[0].voiceState).toBe('generated');
  });

  /* fs-61 defense-in-depth: a stale link across a language boundary must be
     dropped even between two real (non-standalone) same-series books — the
     language veto is independent of the standalone/author/series checks. */
  it('drops a stale link across a language boundary within a real series', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'reused',
        matchedFrom: { bookId: KEEPER1, characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
      },
    ];
    const dropped = await pruneStaleReuseLinks(KEEPER2, chars, {
      ...opts(),
      resolveBookLanguage: async (id) => (id === KEEPER1 ? 'fr' : 'en'),
    });
    expect(dropped).toBe(1);
    expect(chars[0].matchedFrom).toBeFalsy();
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

/* GATE 2 D-2 — clearStaleLink was the last unguarded destructive write on the
   consent surface. A `voiceState: 'reused'` character whose link went stale
   had its voice fields wiped unconditionally, cloned slot included, silently
   and at analysis time: a real person's consented voice simply gone from the
   book after a re-analysis, with the next render reading their lines in a
   catalogue voice.

   The sibling half of this same file's reuse machinery already refuses the
   symmetric operation — `resolveReusedVoiceFields` declines to hydrate a
   character carrying a cloned slot — so this closes the destructive half with
   the same FAIL-SAFE predicate. */
describe('GATE 2 D-2: clearStaleLink never erases a cloned voice', () => {
  const stalePrune = (chars: LinkableCharacter[]) =>
    pruneStaleReuseLinks(BOOK2, chars, {
      resolveAuthorSeries: async (id) => (id === BOOK2 ? { author: AUTHOR, series: SERIES } : null),
      positions: async () =>
        new Map<string, number | null>([
          [BOOK1, 1],
          [BOOK2, 2],
        ]),
    });

  it('[D-2] a reused character carrying a CLONED slot keeps its voice when the link goes stale', async () => {
    const chars: LinkableCharacter[] = [
      {
        id: 'gran',
        name: 'Gran',
        voiceId: 'gran',
        voiceUuid: 'CLONE-UUID',
        voiceState: 'reused',
        ttsEngine: 'coqui',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
        },
        voiceStyle: 'a warm, unhurried woman',
        matchedFrom: { bookId: BOOK1, characterId: 'gran', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];

    const droppedCount = await stalePrune(chars);
    expect(droppedCount).toBe(1);

    /* The dead link IS cleared — the row stops advertising a source that no
       longer qualifies. */
    expect(chars[0].matchedFrom).toBeFalsy();
    expect(chars[0].voiceState).toBe('generated');
    /* …but every field the clone needs to keep rendering survives. */
    expect(chars[0].overrideTtsVoices?.coqui?.provenance).toBe('cloned');
    expect(chars[0].overrideTtsVoices?.coqui?.libraryUuid).toBe('lib-1');
    expect(chars[0].ttsEngine).toBe('coqui');
    expect(chars[0].voiceUuid).toBe('CLONE-UUID');
    expect(chars[0].voiceStyle).toBe('a warm, unhurried woman');
  });

  it('[D-2] protects a MALFORMED cloned slot too (fail-safe: provenance only)', async () => {
    /* The discriminating case for the predicate choice: with a
       uuid-validating resolution test here, a cloned slot carrying no usable
       libraryUuid would read as "not cloned" and be erased — the exact
       silent-deletion shape the fail-safe pair exists to prevent. */
    const chars: LinkableCharacter[] = [
      {
        id: 'gran',
        name: 'Gran',
        voiceState: 'reused',
        overrideTtsVoices: { coqui: { name: 'xtts-lib-1', provenance: 'cloned' } },
        matchedFrom: { bookId: BOOK1, characterId: 'gran', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];

    expect(await stalePrune(chars)).toBe(1);
    expect(chars[0].overrideTtsVoices?.coqui?.provenance).toBe('cloned');
  });

  it('[D-2] a reused character with a DESIGNED slot still reverts (the guard is cloned-only)', async () => {
    /* The control: without this, "the fields survived" could just mean the
       revert stopped working for everyone. */
    const chars: LinkableCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceUuid: 'DESIGNED-UUID',
        voiceState: 'reused',
        ttsEngine: 'qwen',
        overrideTtsVoices: {
          qwen: { name: 'qwen-wren', libraryUuid: 'lib-2', provenance: 'designed' },
        },
        matchedFrom: { bookId: BOOK1, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];

    expect(await stalePrune(chars)).toBe(1);
    expect(chars[0].overrideTtsVoices).toBeUndefined();
    expect(chars[0].voiceUuid).toBeUndefined();
    expect(chars[0].ttsEngine).toBeUndefined();
  });
});

/* #3920 child 3 — compose the analysis route's re-analysis steps end to end,
   seed → prune → link → (dedup) → remap → merge. Steps run, by symbol, in the
   route's main-job order:

     seedReuseGuardsFromPriorCast(priorCastForMerge, characters)
     pruneStaleReuseLinks(bookId, characters)
     linkSeriesReuseAtAnalysis(bookId, characters)
     dedupeRosterByName(...)            (only when `sentences` is passed)
     stripEstablishedAsciiRewrites(composeRewrites(dd.rewrites, {}), ...)
     remapFreshToPriorIds(...)
     applyRewriteToPriorCast(priorCastForMerge, cumulative)
     mergeAnalysisResultWithExistingCast(remapped.priorCast, ...)

   Steps the harness OMITS, so it is a composition of the pure functions and
   not the route: foldMinorCast (folded.rewrites is {} and folded.sentences
   is []), applyNarratorIdentity, the prior-side pruneStaleReuseLinks /
   dedupePriorCastByName, and the requestedFresh strip (the Start fresh test
   calls dropReuseContinuityKeepDesignedVoice itself). The `sentences` option
   runs dedupeRosterByName; without it dedup is skipped and the journal is
   empty (composeRewrites({}, {}) === {}), which only a fixture that cannot
   collapse can honestly use. The route feeds the default workspace scanners;
   here baseOptions() injects scanners instead. */
describe('re-analysis keeps locked/tuned voices — seed → link → remap → merge (#3920)', () => {
  type PriorRow = { id: string } & Record<string, unknown>;

  /* Drive the SAME call sequence the route drives, on (prior, fresh), and
     return the merged roster plus a snapshot of the roster right after the
     link pass (so a test can prove the linker really stamped a link before
     asserting that the merge stripped it). */
  const runReAnalysis = async (
    prior: PriorRow[],
    fresh: LinkableCharacter[],
    options: LinkSeriesReuseOptions,
    /* When given, the route's roster dedup (dedupAndPrepare ->
       dedupeRosterByName) runs on the linked stage-1 roster over these
       sentences, and its rewrites + deduped roster feed the remap and the
       merge, exactly as the route does. Omitted: no dedup, an empty journal. */
    sentences?: Array<{ characterId: string }>,
  ): Promise<{ merged: LinkableCharacter[]; postLink: LinkableCharacter[] }> => {
    seedReuseGuardsFromPriorCast(prior, fresh);
    await pruneStaleReuseLinks(BOOK2, fresh, options);
    await linkSeriesReuseAtAnalysis(BOOK2, fresh, options);
    const postLink = fresh.map((c) => ({ ...c }));
    const dd = sentences
      ? dedupeRosterByName(fresh as never, sentences)
      : { characters: fresh as never as LinkableCharacter[], rewrites: {} };
    const roster = dd.characters as unknown as LinkableCharacter[];
    const cumulative = stripEstablishedAsciiRewrites(
      composeRewrites(dd.rewrites, {}),
      prior,
      roster as unknown as Array<{ id: string } & Record<string, unknown>>,
    );
    const remappedToPrior = remapFreshToPriorIds(
      roster,
      [] as Array<{ characterId: string }>,
      prior,
      cumulative,
    );
    const remapped = applyRewriteToPriorCast(prior, cumulative);
    const { characters: merged } = mergeAnalysisResultWithExistingCast(
      remapped.priorCast,
      remappedToPrior.characters,
    );
    return { merged, postLink };
  };

  /* baseOptions()'s library/positions plus the language/standalone vetoes
     pinned in-test instead of the route's default disk-walking resolvers, and
     an extended Book One library per fixture. */
  const routeOptions = (library: LibraryCharacterRecord[]): LinkSeriesReuseOptions => ({
    ...baseOptions(),
    scanLibrary: async () => library,
    isStandaloneBookId: async () => false,
    resolveBookLanguage: async () => 'en',
  });

  const surnameDrift = async (voiceState: 'locked' | 'tuned') => {
    const prior: PriorRow[] = [{ id: 'wren', name: 'Wren', voiceId: 'v_mine', voiceState }];
    const fresh: LinkableCharacter[] = [
      { id: 'wren-ashby', name: 'Wren Ashby', gender: 'female', ageRange: 'teen' },
    ];
    const { merged, postLink } = await runReAnalysis(prior, fresh, routeOptions(PRIOR_LIBRARY));

    /* The link pass really stamped Book One's Wren onto the fresh row —
       matchedFrom, the unified voiceId and the denormalised qwen voice —
       before the merge ran. */
    const linked = postLink[0];
    expect(linked.matchedFrom?.bookId).toBe(BOOK1);
    expect(linked.matchedFrom?.characterId).toBe('wren');
    expect(linked.overrideTtsVoices?.qwen?.name).toBe('voice_wren');
    expect(linked.voiceState).toBe('reused');

    /* The merge takes the pinned prior voice WHOLE: every preserved field the
       prior row has is copied, every field it lacks is deleted, so nothing
       the linker stamped survives the join (merge-analysis-cast.ts, the
       #3920 child-1 pinned overlay). */
    const wren = merged.find((c) => c.id === 'wren-ashby');
    expect(wren).toBeTruthy();
    expect(wren?.voiceId).toBe('v_mine');
    expect(wren?.voiceState).toBe(voiceState);
    expect(wren?.matchedFrom).toBeUndefined();
    expect(wren?.overrideTtsVoices).toBeUndefined();
    expect(wren?.voiceUuid).toBeUndefined();
    expect(wren?.ttsEngine).toBeUndefined();
    expect(wren?.voiceStyle).toBeUndefined();
  };

  it('surname drift: a locked prior row keeps its voice whole through the full sequence', async () => {
    await surnameDrift('locked');
  });

  it('surname drift, tuned variant: same whole-voice outcome', async () => {
    await surnameDrift('tuned');
  });

  it('Start fresh: a locked row whose voice equals Book One keeps voiceId, loses matchedFrom (strip → seed → link → merge)', async () => {
    const rawPrior: PriorRow[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceId: 'w2',
        voiceState: 'locked',
        matchedFrom: { bookId: BOOK1, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];
    const prior = dropReuseContinuityKeepDesignedVoice(rawPrior);
    const fresh: LinkableCharacter[] = [
      { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen' },
    ];
    const library: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen', voiceId: 'w2' },
      },
    ];
    const { merged, postLink } = await runReAnalysis(prior, fresh, routeOptions(library));
    expect(postLink[0].matchedFrom?.bookId).toBe(BOOK1); // the linker did re-stamp a link
    const wren = merged.find((c) => c.id === 'wren');
    expect(wren?.voiceId).toBe('w2');
    expect(wren?.voiceState).toBe('locked');
    expect(wren?.matchedFrom).toBeUndefined();
  });

  it('cousin name: a same-name fresh row never inherits the seeded link of the prior row it was not joined to', async () => {
    /* Prior mara is locked and linked to Book One's Mara. The fresh roster
       mints TWO rows in that name family: mara (which claims the prior row by
       id) and mara-2 (a cousin under a fresh id the merge never joins). */
    const seededLink = {
      bookId: BOOK1,
      characterId: 'mara',
      bookTitle: 'Book One',
      confidence: 0.42,
    };
    const prior: PriorRow[] = [
      {
        id: 'mara',
        name: 'Mara',
        voiceId: 'v_mara',
        voiceState: 'locked',
        matchedFrom: seededLink,
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'mara', name: 'Mara Vale', gender: 'female', ageRange: 'adult' },
      { id: 'mara-2', name: 'Mara', gender: 'female', ageRange: 'adult' },
      { id: 'mara-3', name: 'Mara Cole', gender: 'female', ageRange: 'adult' },
    ];
    /* Two distinct longer names make "Mara" an AMBIGUOUS Tier-2a short name
       (supersets !== 1), so dedupeRosterByName leaves all three rows standing
       and the cousin genuinely reaches the merge. With only "Mara Vale" it
       would be collapsed to {mara-2: 'mara'}. */
    const sentences = [
      { characterId: 'mara' },
      { characterId: 'mara-2' },
      { characterId: 'mara-3' },
    ];
    const library: LibraryCharacterRecord[] = [
      ...PRIOR_LIBRARY,
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'mara', name: 'Mara', gender: 'female', ageRange: 'adult' },
      },
    ];
    const { merged } = await runReAnalysis(prior, fresh, routeOptions(library), sentences);

    /* dedup left the cousin standing, so it reached the merge. */
    expect(merged.map((c) => c.id).sort()).toEqual(['mara', 'mara-2', 'mara-3']);

    /* mara keeps the locked prior voice (joined by id). */
    const mara = merged.find((c) => c.id === 'mara');
    expect(mara?.voiceId).toBe('v_mara');
    expect(mara?.voiceState).toBe('locked');

    /* mara-2 was NOT joined to prior mara, so it inherits neither the lock
       nor the seeded link. The linker DOES legitimately link mara-2 to Book
       One's Mara on its own exact-name score — that link is stamped fresh
       this run (voiceState reused, the scorer's confidence) and is
       distinguishable from the seeded prior-row object by exactly those
       marks: the seeded path would leave the row pre-linked (the linker
       skips rows that already carry matchedFrom) with the prior confidence
       0.42 and NO voiceState. */
    const mara2 = merged.find((c) => c.id === 'mara-2');
    expect(mara2).toBeTruthy();
    expect(mara2?.voiceState).not.toBe('locked');
    expect(mara2?.voiceState).not.toBe('tuned');
    expect(mara2?.voiceState).toBe('reused');
    expect(mara2?.matchedFrom?.bookId).toBe(BOOK1);
    expect(mara2?.matchedFrom?.characterId).toBe('mara');
    expect(mara2?.matchedFrom?.confidence).not.toBe(seededLink.confidence);
  });

  it('Start fresh: a locked voice that differs from Book One keeps its own voiceId (w_mine, not w_b1) and gets no link', async () => {
    const rawPrior: PriorRow[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceId: 'w_mine',
        voiceState: 'locked',
        matchedFrom: { bookId: BOOK1, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 },
      },
    ];
    const prior = dropReuseContinuityKeepDesignedVoice(rawPrior);
    const fresh: LinkableCharacter[] = [
      { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen' },
    ];
    const library: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen', voiceId: 'w_b1' },
      },
    ];
    const { merged, postLink } = await runReAnalysis(prior, fresh, routeOptions(library));
    expect(postLink[0].voiceId).toBe('w_b1'); // the linker did try to hand over Book One's voice
    const wren = merged.find((c) => c.id === 'wren');
    expect(wren?.voiceId).toBe('w_mine');
    expect(wren?.voiceState).toBe('locked');
    expect(wren?.matchedFrom).toBeUndefined();
    expect(wren?.overrideTtsVoices).toBeUndefined();
  });

  it('dedup moves the join onto a row the seed refused: the prior notLinkedTo separation survives, no link is stamped', async () => {
    /* Prior brann is separated from Book One's Brann. The stage-1 roster mints
       brann ("Brann Weir", 1 line) and brann-2 ("Brann", 3 lines). The seed
       runs BEFORE dedup: brann claims the prior row by id, so the strict
       matchedFrom candidate set refuses brann-2. Tier-2a then collapses
       brann into brann-2 (rewrite {brann: 'brann-2'}) and the rewritten prior
       joins brann-2 by id — a row that must still carry the prior's
       notLinkedTo, or the linker re-links the pair the user separated. */
    const prior: PriorRow[] = [
      {
        id: 'brann',
        name: 'Brann',
        voiceState: 'generated',
        notLinkedTo: [{ bookId: BOOK1, characterId: 'brann' }],
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'brann', name: 'Brann Weir', gender: 'male', ageRange: 'adult' },
      { id: 'brann-2', name: 'Brann', gender: 'male', ageRange: 'adult' },
    ];
    const library: LibraryCharacterRecord[] = [
      ...PRIOR_LIBRARY,
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'brann', name: 'Brann', gender: 'male', ageRange: 'adult', voiceId: 'v_b1_brann' },
      },
    ];
    const sentences = [
      { characterId: 'brann' },
      { characterId: 'brann-2' },
      { characterId: 'brann-2' },
      { characterId: 'brann-2' },
    ];
    const { merged } = await runReAnalysis(prior, fresh, routeOptions(library), sentences);

    const brann = merged.find((c) => c.id === 'brann-2');
    expect(brann).toBeTruthy();
    expect(merged.some((c) => c.id === 'brann')).toBe(false); // dedup really collapsed it
    expect(brann?.matchedFrom).toBeUndefined();
    expect(brann?.voiceId).not.toBe('v_b1_brann');
    expect(brann?.notLinkedTo).toEqual([{ bookId: BOOK1, characterId: 'brann' }]);
  });

  it('dedup moves the join onto a row the strict seed refused: a linked unpinned prior row takes its voice fields whole, no stamp from another Book One character leaks', async () => {
    /* Prior brann (unpinned, reused) is linked to Book One's "The Smith". The
       strict matchedFrom seed gives that link to brann ("Brann Weir") by id and
       refuses brann-2 ("Brann"); dedup then collapses brann into brann-2, so
       the rewritten prior joins brann-2 — which the linker stamped with Book
       One's separate Brann (and its Qwen design). A linked prior row must take
       its voice fields whole, as a pinned one does. */
    const smithLink = {
      bookId: BOOK1,
      characterId: 'smith',
      bookTitle: 'Book One',
      confidence: 1,
    };
    const prior: PriorRow[] = [
      {
        id: 'brann',
        name: 'Brann',
        voiceState: 'reused',
        voiceId: 'v_b1_smith',
        matchedFrom: smithLink,
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'brann', name: 'Brann Weir', gender: 'male', ageRange: 'adult' },
      { id: 'brann-2', name: 'Brann', gender: 'male', ageRange: 'adult' },
    ];
    const library: LibraryCharacterRecord[] = [
      ...PRIOR_LIBRARY,
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'smith', name: 'The Smith', gender: 'male', ageRange: 'adult', voiceId: 'v_b1_smith' },
      },
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'brann', name: 'Brann', gender: 'male', ageRange: 'adult', voiceId: 'v_b1_brann' },
      },
    ];
    const options: LinkSeriesReuseOptions = {
      ...routeOptions(library),
      castLoader: async (bookId: string) =>
        bookId === BOOK1
          ? [
              { id: 'smith' },
              {
                id: 'brann',
                ttsEngine: 'qwen',
                overrideTtsVoices: { qwen: { name: 'voice_b1_brann' } },
                voiceStyle: 'gruff young smith',
              },
            ]
          : null,
    };
    const sentences = [
      { characterId: 'brann' },
      { characterId: 'brann-2' },
      { characterId: 'brann-2' },
      { characterId: 'brann-2' },
    ];
    const { merged, postLink } = await runReAnalysis(prior, fresh, options, sentences);

    // the linker really stamped Book One's Brann onto brann-2 (the leak source)
    expect(postLink.find((c) => c.id === 'brann-2')?.matchedFrom?.characterId).toBe('brann');
    expect(merged.some((c) => c.id === 'brann')).toBe(false); // dedup really collapsed it
    const brann = merged.find((c) => c.id === 'brann-2');
    expect(brann?.matchedFrom?.characterId).toBe('smith');
    expect(brann?.voiceId).toBe('v_b1_smith');
    expect(brann?.ttsEngine).toBeUndefined();
    expect(brann?.overrideTtsVoices).toBeUndefined();
    expect(brann?.voiceStyle).toBeUndefined();
  });

  it('narrator id flip: a declined narrator link survives char-narrator -> narrator (no link applied, edge seeded)', async () => {
    const declined = { bookId: BOOK1, characterId: 'narrator' };
    const prior: PriorRow[] = [
      {
        id: 'char-narrator',
        name: 'Narrator',
        voiceState: 'generated',
        voiceId: 'v_own_narr',
        notLinkedTo: [declined],
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'narrator', name: 'Narrator', gender: 'neutral', ageRange: 'adult' },
    ];
    const library: LibraryCharacterRecord[] = [
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'narrator', name: 'Narrator', gender: 'neutral', ageRange: 'adult', voiceId: 'v_b1_narr' },
      },
    ];
    const { merged, postLink } = await runReAnalysis(prior, fresh, routeOptions(library));

    expect(fresh[0].notLinkedTo).toEqual([declined]); // the edge was seeded
    expect(postLink[0].matchedFrom).toBeUndefined(); // so the linker applied no link
    const narrator = merged.find((c) => c.id === 'narrator');
    expect(narrator?.matchedFrom).toBeUndefined();
    expect(narrator?.voiceId).not.toBe('v_b1_narr');
    expect(narrator?.voiceState).not.toBe('reused');
  });

  it('narrator rename: the locked narrator keeps its voice and renamed name; a same-name real row inherits neither', async () => {
    const narrLink = {
      bookId: 'book-0',
      characterId: 'narrator',
      bookTitle: 'Book Zero',
      confidence: 0.9,
    };
    const prior: PriorRow[] = [
      {
        id: 'narrator',
        name: 'Old Tom',
        voiceId: 'v_narr',
        voiceState: 'locked',
        matchedFrom: narrLink,
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'old-tom', name: 'Old Tom', gender: 'male', ageRange: 'adult' },
    ];
    const library: LibraryCharacterRecord[] = [
      ...PRIOR_LIBRARY,
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'old-tom', name: 'Old Tom', gender: 'male', ageRange: 'adult' },
      },
    ];
    const { merged } = await runReAnalysis(prior, fresh, routeOptions(library));

    /* The narrator row keeps the user's locked voice and their RENAME — the
       narrator-name carry-forward beats the fresh roster's default name. */
    const narrator = merged.find((c) => c.id === 'narrator');
    expect(narrator?.voiceId).toBe('v_narr');
    expect(narrator?.voiceState).toBe('locked');
    expect(narrator?.name).toBe('Old Tom');

    /* old-tom is a different person who happens to share the narrator's
       prior display name: no locked state, and no matchedFrom from the
       narrator. The linker legitimately links it to Book One's Old Tom on
       its own score — never to the narrator's seeded book-0 link. */
    const oldTom = merged.find((c) => c.id === 'old-tom');
    expect(oldTom).toBeTruthy();
    expect(oldTom?.voiceState).not.toBe('locked');
    expect(oldTom?.voiceState).not.toBe('tuned');
    expect(oldTom?.matchedFrom?.bookId).toBe(BOOK1);
    expect(oldTom?.matchedFrom?.characterId).toBe('old-tom');
  });

  it('narrator rename, no fresh narrator row: a real Old Tom never takes the seeded narrator link', async () => {
    /* Strengthened variant for child 2's prior-narrator exclusion: when the
       fresh roster has NO narrator row this run, the prior narrator is not
       claimed by any fresh id, so ONLY the narrator exclusion keeps its
       guards off a real character who happens to share the renamed
       narrator's display name (the merge side is already covered by
       mergeCore's own narrator exclusion). In the variant above, with a
       fresh narrator row present, the freshIds exclusion alone would keep
       the seed sound — this variant is what actually pins the narrator
       clause. */
    const narrLink = {
      bookId: 'book-0',
      characterId: 'narrator',
      bookTitle: 'Book Zero',
      confidence: 0.9,
    };
    const prior: PriorRow[] = [
      {
        id: 'narrator',
        name: 'Old Tom',
        voiceId: 'v_narr',
        voiceState: 'locked',
        matchedFrom: narrLink,
      },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'old-tom', name: 'Old Tom', gender: 'male', ageRange: 'adult' },
    ];
    const library: LibraryCharacterRecord[] = [
      ...PRIOR_LIBRARY,
      {
        bookId: BOOK1,
        bookTitle: 'Book One',
        character: { id: 'old-tom', name: 'Old Tom', gender: 'male', ageRange: 'adult' },
      },
    ];
    const { merged } = await runReAnalysis(prior, fresh, routeOptions(library));

    /* The voiced prior narrator is carried forward whole (the fresh roster
       dropped it), still locked under its own id. */
    const narrator = merged.find((c) => c.id === 'narrator');
    expect(narrator?.voiceId).toBe('v_narr');
    expect(narrator?.voiceState).toBe('locked');

    /* The real Old Tom keeps its own identity: linked to Book One's Old Tom
       by the linker on its own score — never to the narrator's book-0 link,
       and never locked. */
    const oldTom = merged.find((c) => c.id === 'old-tom');
    expect(oldTom).toBeTruthy();
    expect(oldTom?.voiceState).not.toBe('locked');
    expect(oldTom?.voiceState).not.toBe('tuned');
    expect(oldTom?.matchedFrom?.bookId).toBe(BOOK1);
    expect(oldTom?.matchedFrom?.characterId).toBe('old-tom');
  });

  it('control: a generated (unlocked) prior row still receives the Book One link', async () => {
    /* Fixture 1 with voiceState generated: the pinned overlay does not apply,
       so today's behaviour stands — re-analysis still links unlocked rows. */
    const prior: PriorRow[] = [
      { id: 'wren', name: 'Wren', voiceId: 'v_mine', voiceState: 'generated' },
    ];
    const fresh: LinkableCharacter[] = [
      { id: 'wren-ashby', name: 'Wren Ashby', gender: 'female', ageRange: 'teen' },
    ];
    const { merged } = await runReAnalysis(prior, fresh, routeOptions(PRIOR_LIBRARY));

    const wren = merged.find((c) => c.id === 'wren-ashby');
    expect(wren?.matchedFrom?.bookId).toBe(BOOK1);
    expect(wren?.matchedFrom?.characterId).toBe('wren');
    expect(wren?.voiceState).not.toBe('locked');
    expect(wren?.voiceState).not.toBe('tuned');
    /* The linker's denormalised qwen voice survives too — the prior row had
       none of those fields to overlay. */
    expect(wren?.overrideTtsVoices?.qwen?.name).toBe('voice_wren');
  });
});
