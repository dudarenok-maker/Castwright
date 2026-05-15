import { describe, it, expect, vi } from 'vitest';
import {
  sortEvidence, normaliseForMatch, verifyEvidenceAgainstSource, mergeRosterChapter,
  chapterEstFromObserved, projectRemainingMs, buildInterimCast,
} from './analysis.js';
import type { CharacterOutput } from '../handoff/schemas.js';

describe('sortEvidence', () => {
  it('sorts each character\'s evidence by quote length descending', () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a', name: 'A', role: 'r', color: 'c',
        evidence: [
          { quote: 'short' },                                // 5
          { quote: 'this is a much longer evidence quote' }, // 36
          { quote: 'medium length quote here' },             // 24
        ],
      },
    ];

    sortEvidence(chars);

    const lengths = chars[0].evidence!.map(e => e.quote.length);
    expect(lengths).toEqual([36, 24, 5]);
  });

  it('preserves note and other fields when sorting', () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a', name: 'A', role: 'r', color: 'c',
        evidence: [
          { quote: 'shortie', note: 'tag-short' },
          { quote: 'a notably longer one', note: 'tag-long' },
        ],
      },
    ];

    sortEvidence(chars);

    expect(chars[0].evidence).toEqual([
      { quote: 'a notably longer one', note: 'tag-long' },
      { quote: 'shortie', note: 'tag-short' },
    ]);
  });

  it('is a no-op when evidence is missing or length ≤ 1', () => {
    const chars: CharacterOutput[] = [
      { id: 'a', name: 'A', role: 'r', color: 'c' },
      { id: 'b', name: 'B', role: 'r', color: 'c', evidence: [] },
      { id: 'c', name: 'C', role: 'r', color: 'c', evidence: [{ quote: 'solo' }] },
    ];

    expect(() => sortEvidence(chars)).not.toThrow();
    expect(chars[1].evidence).toEqual([]);
    expect(chars[2].evidence).toEqual([{ quote: 'solo' }]);
  });

  it('warns when a character has fewer than 3 evidence entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [
      { id: 'thin', name: 'Thin', role: 'r', color: 'c', evidence: [{ quote: 'one' }, { quote: 'two' }] },
      { id: 'rich', name: 'Rich', role: 'r', color: 'c', evidence: [{ quote: 'one' }, { quote: 'two' }, { quote: 'three' }] },
    ];

    sortEvidence(chars);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('thin');
    expect(warn.mock.calls[0][0]).toContain('2');
    warn.mockRestore();
  });
});

describe('normaliseForMatch', () => {
  it('lower-cases, folds smart punctuation, and collapses whitespace', () => {
    const input  = '  “Hello — world…”\n  Line two.  ';
    const output = normaliseForMatch(input);
    /* Smart quotes folded to straight; em-dash → hyphen; ellipsis → "...";
       outer quote-marks + whitespace stripped (the leading `“` after the
       leading whitespace is on the boundary so it goes too); internal
       whitespace collapsed. The closing `”` lands mid-string after the
       fold and stays — only OUTER quote marks are stripped, by design. */
    expect(output).toBe('hello - world..." line two.');
  });

  it('is a no-op for already-normalised lower-case ASCII', () => {
    expect(normaliseForMatch('hello, world')).toBe('hello, world');
  });
});

describe('verifyEvidenceAgainstSource', () => {
  /* A tiny manuscript with three discontiguous utterances. The "stitched"
     fabrication test combines two of them with extra glue text that is
     NOT in the source — the verifier should drop it. */
  const SOURCE = `
    Chapter 1.

    "Hard to starboard," Halloran said, watching the gulls scatter.

    Hours later, by the binnacle, he muttered: "Cold supper it is, then."

    Marcus shrugged. "Aye."
  `;

  it('keeps quotes that appear verbatim in the source', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.fn();
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'halloran',
      evidence: [
        { quote: 'Hard to starboard' },
        { quote: 'Cold supper it is, then.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps quotes whose only difference from the source is typography (smart quotes, em-dashes, whitespace)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = 'He thought: "It is a long road — perhaps the longest." She nodded.';
    const chars: CharacterOutput[] = [{
      id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator',
      evidence: [
        /* Smart quotes + em-dash + extra whitespace runs — should still match. */
        { quote: '“It is a long road —   perhaps the longest.”' },
      ],
    }];
    const result = verifyEvidenceAgainstSource(chars, src, () => {});
    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps stitched same-speaker quotes via the segment tier when every segment is in source', () => {
    /* Regression for the the Hollow Tide false-positive class: the model joins two
       consecutive same-speaker utterances and drops the narration tag
       between them. The pure-substring check used to drop these; the
       three-tier match now keeps them as `segments`. */
    const log = vi.fn();
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'halloran',
      evidence: [
        /* "Hard to starboard" and "Cold supper it is, then" are two
           separate utterances in SOURCE. The 3-char "aye." segment
           gets filtered by the ≥ 8-char rule so isn't required. */
        { quote: 'Hard to starboard. Cold supper it is, then. Aye.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    /* The aggregate match-tier log line fires when the looser tiers
       actually carried a quote. */
    expect(log.mock.calls.some(call => /Quote-match tiers:.*segments=1/.test(String(call[0])))).toBe(true);
  });

  it('keeps quotes whose only difference is terminal-punct drift (period for comma before a dialogue tag)', () => {
    /* The other half of the the Hollow Tide false-positive class. Source punctuates
       the utterance with `,` because a dialogue tag follows; the model
       emits `.` because it treats the line as a complete sentence. */
    const src = '"Mammoths are extinct," she interrupted. The dog barked.';
    const chars: CharacterOutput[] = [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'Wren',
      evidence: [{ quote: 'Mammoths are extinct.' }],
    }];
    const log = vi.fn();
    const result = verifyEvidenceAgainstSource(chars, src, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    expect(log.mock.calls.some(call => /terminal-punct=1/.test(String(call[0])))).toBe(true);
  });

  it('drops stitched quotes when at least one segment is genuinely fabricated', () => {
    /* "Cold supper it is, then" is in source, but "He winked" is NOT —
       so the segment tier must NOT accept the joined form. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.fn();
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'halloran',
      evidence: [
        { quote: 'Cold supper it is, then. He winked at the parrot.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(1);
    expect(result.affectedCharacters).toBe(1);
    expect(chars[0].evidence).toHaveLength(0);
    expect(log.mock.calls[0][0]).toContain('halloran');
    expect(log.mock.calls[0][0]).toMatch(/fabricated quote/i);
    warn.mockRestore();
  });

  it('does not keep a quote when only one segment survives the ≥ 8-char filter', () => {
    /* A single long segment that wasn't matched by tier 1 or 2 cannot
       be rescued by tier 3 — segment-tier requires ≥ 2 surviving
       segments so it can't degenerate into "any substring matches". */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'halloran',
      evidence: [
        /* Two halves, but only one is ≥ 8 chars after stripping. The
           short "No." segment is filtered out so we're left with a
           single segment — tier 3 must refuse it. */
        { quote: 'A fabricated long sentence never in the source. No.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});

    expect(result.totalDropped).toBe(1);
    expect(chars[0].evidence).toHaveLength(0);
    warn.mockRestore();
  });

  it('leaves a character with empty evidence (no error) when every quote was fabricated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [{
      id: 'ghost', name: 'Ghost', role: 'spectre', color: 'c',
      evidence: [
        { quote: 'I never said this in the book.' },
        { quote: 'Or this either.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});

    expect(result.totalDropped).toBe(2);
    expect(chars[0].evidence).toEqual([]);
    warn.mockRestore();
  });

  it('handles characters with no evidence array at all without throwing', () => {
    const chars: CharacterOutput[] = [
      { id: 'a', name: 'A', role: 'r', color: 'c' },
      { id: 'b', name: 'B', role: 'r', color: 'c', evidence: [] },
    ];
    expect(() => verifyEvidenceAgainstSource(chars, SOURCE, () => {})).not.toThrow();
  });

  it('returns entries[] empty when nothing was dropped', () => {
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'c',
      evidence: [{ quote: 'Hard to starboard' }],
    }];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toEqual([]);
  });

  it('returns one dropped entry per fabricated quote with characterName captured at drop-time', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'c',
      evidence: [
        /* Genuine fabrication (one segment is invented) — drops at all
           three tiers, preserves the note in the ledger entry. */
        { quote: 'Cold supper it is, then. The kraken danced a jig.', note: 'stitched' },
        { quote: 'Halloran said something profound.' },
      ],
    }];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      characterId: 'halloran',
      characterName: 'Halloran',
      reason: 'not_in_source',
      truncated: false,
      note: 'stitched',
    });
    expect(result.entries[1].note).toBeUndefined();
    warn.mockRestore();
  });

  it('tags empty-after-normalisation drops with the distinct reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [{
      id: 'voiceless', name: 'Voiceless', role: 'r', color: 'c',
      evidence: [
        /* Only quote marks + whitespace — normaliseForMatch strips
           these to '' so the verifier sees an empty needle. */
        { quote: '   "  "   ' },
      ],
    }];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].reason).toBe('empty_after_normalisation');
    warn.mockRestore();
  });

  it('truncates dropped quotes that exceed the 2000-char cap and flags truncated:true', async () => {
    const { MAX_QUOTE_CHARS } = await import('../store/dropped-quotes.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = 'a'.repeat(MAX_QUOTE_CHARS + 500); // not in source
    const chars: CharacterOutput[] = [{
      id: 'verbose', name: 'Verbose', role: 'r', color: 'c',
      evidence: [{ quote: huge }],
    }];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].quote.length).toBe(MAX_QUOTE_CHARS);
    expect(result.entries[0].truncated).toBe(true);
    warn.mockRestore();
  });
});

describe('mergeRosterChapter — Phase 0a roster merging', () => {
  it('appends new characters to an empty roster in incoming order', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      { id: 'Wren',   name: 'Wren',   role: 'protagonist', color: 'orange' },
    ]);
    expect(Array.from(roster.keys())).toEqual(['narrator', 'Wren']);
  });

  it('merges evidence quotes into an existing entry, deduping on normalised quote text', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      evidence: [{ quote: 'Hello world.' }],
    }]);
    /* Same quote with smart-quote variation should NOT add a duplicate. */
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      evidence: [{ quote: '“Hello world.”' }, { quote: 'Different line.' }],
    }]);
    const Wren = roster.get('Wren')!;
    expect(Wren.evidence).toHaveLength(2);
    expect(Wren.evidence!.map(e => e.quote)).toEqual(['Hello world.', 'Different line.']);
  });

  it('keeps the longer description when a later chapter offers a richer one', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      description: 'A girl.',
    }]);
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
    }]);
    expect(roster.get('Wren')!.description).toContain('telepathic');
  });

  it('keeps the shorter description if a later chapter is shorter (longest-wins, not latest-wins)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
    }]);
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'protagonist', color: 'orange',
      description: 'A girl.',
    }]);
    expect(roster.get('Wren')!.description).toContain('telepathic');
  });

  it('latest-wins for tone fields when both chapters provide them', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      tone: { warmth: 30, pace: 50 },
    }]);
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      tone: { warmth: 80 }, /* pace not provided this round */
    }]);
    /* warmth updated; pace preserved (don't blank out a known value). */
    expect(roster.get('Wren')!.tone).toEqual({ warmth: 80, pace: 50 });
  });

  it('attributes union without duplicates', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      attributes: ['curious', 'wry'],
    }]);
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      attributes: ['wry', 'brave'], /* 'wry' is a duplicate */
    }]);
    expect(roster.get('Wren')!.attributes).toEqual(['curious', 'wry', 'brave']);
  });

  it('first-detection wins for identity fields (gender / ageRange)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      gender: 'female', ageRange: 'teen',
    }]);
    /* A later chapter says the model thinks she's male — ignored. The
       model would only flip gender via a hallucination; trust the first
       confident pass. */
    mergeRosterChapter(roster, [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      gender: 'male',
    }]);
    expect(roster.get('Wren')!.gender).toBe('female');
    expect(roster.get('Wren')!.ageRange).toBe('teen');
  });

  it('does not mutate the incoming chapter outputs (defensive clone)', () => {
    const roster = new Map<string, CharacterOutput>();
    const incoming: CharacterOutput[] = [{
      id: 'Wren', name: 'Wren', role: 'p', color: 'orange',
      attributes: ['curious'],
      evidence: [{ quote: 'a' }],
      tone: { warmth: 30 },
    }];
    mergeRosterChapter(roster, incoming);
    /* Mutate the merged copy. */
    roster.get('Wren')!.attributes!.push('wry');
    roster.get('Wren')!.evidence!.push({ quote: 'b' });
    roster.get('Wren')!.tone!.warmth = 80;
    /* Incoming is unchanged. */
    expect(incoming[0].attributes).toEqual(['curious']);
    expect(incoming[0].evidence).toEqual([{ quote: 'a' }]);
    expect(incoming[0].tone).toEqual({ warmth: 30 });
  });
});

/* Regression for the "Chapter 18/59 · 1:16 of ~0:40 · over budget" screenshot —
   the old Phase 0a formula was `30s baseline + 0.5ms × chars`, which gave ~0:40
   for a 20k-char chapter on local Ollama that was actually taking 2-4 minutes
   per chapter. Once any prior chapter has run, the estimate must come from the
   observed rate, not the static formula. */
describe('chapterEstFromObserved', () => {
  it('falls back to the supplied baseline before any samples exist', () => {
    expect(chapterEstFromObserved(20_111, 0, 0, 40_000)).toBe(40_000);
  });

  it('uses observed ms-per-char once at least one chapter has completed', () => {
    /* 4 chapters at the rates from the bug screenshot: 30+45+56+64 = 195s
       across 6507+7909+13614+18296 = 46326 chars → ~4.21 ms/char. A new
       20,111-char chapter projects to ~85s, not ~40s. */
    const observed = chapterEstFromObserved(20_111, 195_000, 46_326, 40_000);
    expect(observed).toBeGreaterThan(80_000);
    expect(observed).toBeLessThan(90_000);
  });

  it('floors at 2s so micro-chapters do not teleport through the live ticker', () => {
    expect(chapterEstFromObserved(50, 195_000, 46_326, 40_000)).toBe(2000);
  });

  it('grows the estimate when the model proves much slower than the baseline', () => {
    /* Local Ollama at ~10ms/char (≈100 chars/sec, matching the screenshot's
       heartbeat). For a 20k-char chapter we want ~200s, not the
       baseline's ~40s. */
    const observed = chapterEstFromObserved(20_000, 50_000, 5_000, 40_000);
    expect(observed).toBeGreaterThanOrEqual(195_000);
  });
});

describe('projectRemainingMs', () => {
  it('returns the static fallbacks when nothing has been observed yet', () => {
    const r = projectRemainingMs({
      phase0WallClockMs: 0,
      phase0CharsDone: 0,
      phase0CharsRemaining: 100_000,
      phase1WallClockMs: 0,
      phase1CharsDone: 0,
      phase1CharsRemaining: 100_000,
      fallbackPhase0Ms: 60_000,
      fallbackPhase1Ms: 300_000,
    });
    expect(r).toBe(360_000);
  });

  it('uses wall-clock-per-char (concurrency-aware) once Phase 0a has samples', () => {
    /* 100k chars done in 200s wall-clock (under concurrency-2 these
       chapters' per-chapter sum-of-ms would be ~400s, but the user's
       wall-clock experience is 200s). Remaining 100k cast chars at the
       same rate = another 200s. Phase 1 over the same 100k chars at
       STAGE2_STRETCH (5×) the rate = ~1000s. Total ≈ 1200s. */
    const r = projectRemainingMs({
      phase0WallClockMs: 200_000,
      phase0CharsDone: 100_000,
      phase0CharsRemaining: 100_000,
      phase1WallClockMs: 0,
      phase1CharsDone: 0,
      phase1CharsRemaining: 100_000,
      fallbackPhase0Ms: 60_000,
      fallbackPhase1Ms: 60_000,
    });
    /* 200s phase-0-remaining + 1000s phase-1-projection = 1.2M ms. */
    expect(r).toBeGreaterThan(1_100_000);
    expect(r).toBeLessThan(1_300_000);
  });

  it('prefers Phase 1 wall-clock when Phase 1 has its own samples', () => {
    /* Phase 0 averaged 2ms/char wall-clock (would project Phase 1 at
       10ms/char via STAGE2_STRETCH), but Phase 1's own samples show
       it's actually faster — 8ms/char. Prefer Phase 1's number. */
    const r = projectRemainingMs({
      phase0WallClockMs: 200_000,
      phase0CharsDone: 100_000,
      phase0CharsRemaining: 0,
      phase1WallClockMs: 80_000,
      phase1CharsDone: 10_000,
      phase1CharsRemaining: 50_000,
      fallbackPhase0Ms: 0,
      fallbackPhase1Ms: 999_000,
    });
    /* 50k × 8ms/char = 400,000ms — not 50k × 10ms/char and not the fallback. */
    expect(r).toBe(400_000);
  });
});

/* Regression for the second screenshot — "25 of 59 chapters already cached"
   but the heading still showed "~38 minutes" and the per-chapter budget
   reverted to the static formula. The cache must surface its persisted
   durations and the route must use them. */
describe('AnalysisCache schema — persisted durations', () => {
  it('round-trips castDurations and stage2Durations through load/save', async () => {
    const { loadAnalysisCache, saveAnalysisCache, clearAnalysisCache } =
      await import('../store/analysis-cache.js');
    const id = `test-durations-${Date.now()}`;
    try {
      await saveAnalysisCache(id, {
        chapters: {},
        castDurations: { 1: 30_000, 2: 45_000 },
        stage2Durations: { 1: 120_000 },
      });
      const loaded = await loadAnalysisCache(id);
      expect(loaded.castDurations).toEqual({ 1: 30_000, 2: 45_000 });
      expect(loaded.stage2Durations).toEqual({ 1: 120_000 });
    } finally {
      await clearAnalysisCache(id);
    }
  });

  it('returns undefined duration fields when the cache predates the feature', async () => {
    const { loadAnalysisCache, saveAnalysisCache, clearAnalysisCache } =
      await import('../store/analysis-cache.js');
    const id = `test-legacy-cache-${Date.now()}`;
    try {
      /* Simulate an older cache file that only has chapters{} — no
         durations field. The route's seeding loop must tolerate this
         and start from 0 trackers without throwing. */
      await saveAnalysisCache(id, { chapters: {} });
      const loaded = await loadAnalysisCache(id);
      expect(loaded.castDurations).toBeUndefined();
      expect(loaded.stage2Durations).toBeUndefined();
    } finally {
      await clearAnalysisCache(id);
    }
  });

  /* failedChapterIds backs the analysing view's per-chapter Retry buttons
     and the full-route's resume-with-retry behaviour. The cache must keep
     it across save/load, AND legacy caches written before the field
     existed must still load without exploding — otherwise `npm run dev`
     against an existing partial book breaks on the first resume. */
  it('round-trips failedChapterIds through load/save', async () => {
    const { loadAnalysisCache, saveAnalysisCache, clearAnalysisCache } =
      await import('../store/analysis-cache.js');
    const id = `test-failedchapterids-${Date.now()}`;
    try {
      await saveAnalysisCache(id, {
        chapters: {},
        failedChapterIds: [44, 49],
      });
      const loaded = await loadAnalysisCache(id);
      expect(loaded.failedChapterIds).toEqual([44, 49]);
    } finally {
      await clearAnalysisCache(id);
    }
  });

  it('returns undefined failedChapterIds for caches that predate the field', async () => {
    const { loadAnalysisCache, saveAnalysisCache, clearAnalysisCache } =
      await import('../store/analysis-cache.js');
    const id = `test-legacy-failed-${Date.now()}`;
    try {
      await saveAnalysisCache(id, { chapters: {} });
      const loaded = await loadAnalysisCache(id);
      expect(loaded.failedChapterIds).toBeUndefined();
    } finally {
      await clearAnalysisCache(id);
    }
  });
});

/* buildInterimCast underpins the mid-run cast.json writes — the helper
   must produce a deduped, palette-coloured roster with lines:0/scenes:0
   placeholders so the file shape matches the post-Phase-1 end-of-run
   write and frontend cast.json readers don't choke on partial data. */
describe('buildInterimCast — mid-run cast snapshot', () => {
  const makeChar = (id: string, name: string, opts: Partial<CharacterOutput> = {}): CharacterOutput => ({
    id, name, role: 'character', color: 'unset',
    evidence: [{ quote: `${name}'s line one, long enough to be representative.` }],
    ...opts,
  });

  it('merges per-chapter character lists in chapter-id order and palette-colours the roster', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator', 'Narrator'), makeChar('Wren', 'Wren')],
      2: [makeChar('Wren', 'Wren'), makeChar('Marlow', 'Marlow')],
      3: [makeChar('Marlow', 'Marlow'), makeChar('Maerin', 'Maerin')],
    };

    const interim = buildInterimCast(chapterCast, [1, 2, 3]);

    /* 4 distinct ids after merge (narrator + Wren + Marlow + Maerin). */
    expect(interim.map(c => c.id)).toEqual(['narrator', 'Wren', 'Marlow', 'Maerin']);

    /* Narrator keeps its dedicated palette slot; everyone else gets a
       deterministic non-narrator slot. */
    const narrator = interim.find(c => c.id === 'narrator')!;
    expect(narrator.color).toBe('narrator');
    for (const c of interim) {
      if (c.id === 'narrator') continue;
      expect(c.color).not.toBe('narrator');
      expect(c.color).not.toBe('unset');
    }

    /* lines: 0 / scenes: 0 placeholders so the shape matches the
       post-Phase-1 end-of-run write — Phase 1 attribution hasn't run
       yet, so per-character counts can't be known. */
    for (const c of interim as Array<CharacterOutput & { lines?: number; scenes?: number }>) {
      expect(c.lines).toBe(0);
      expect(c.scenes).toBe(0);
    }
  });

  it('returns [] when the chapterCast map is empty (caller guards the cast.json write)', () => {
    expect(buildInterimCast({}, [])).toEqual([]);
    expect(buildInterimCast({}, [1, 2, 3])).toEqual([]);
    /* Chapters present in the map but with empty arrays (failure markers)
       should also produce an empty result — no characters were detected. */
    expect(buildInterimCast({ 1: [], 2: [] }, [1, 2])).toEqual([]);
  });

  it('assigns palette colours deterministically across runs with the same input', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator', 'N'), makeChar('a', 'A'), makeChar('b', 'B'), makeChar('c', 'C')],
    };

    const first = buildInterimCast(chapterCast, [1]);
    const second = buildInterimCast(chapterCast, [1]);

    expect(first.map(c => ({ id: c.id, color: c.color })))
      .toEqual(second.map(c => ({ id: c.id, color: c.color })));
  });

  it('skips chapters that are missing from the chapterCast map (cache predates the chapter, or excluded)', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('Wren', 'Wren')],
      /* chapter 2 missing entirely — buildInterimCast must not throw. */
      3: [makeChar('Marlow', 'Marlow')],
    };

    const interim = buildInterimCast(chapterCast, [1, 2, 3]);
    expect(interim.map(c => c.id)).toEqual(['Wren', 'Marlow']);
  });
});
