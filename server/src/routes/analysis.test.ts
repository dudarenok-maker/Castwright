import { describe, it, expect, vi } from 'vitest';
import {
  sortEvidence, normaliseForMatch, verifyEvidenceAgainstSource, mergeRosterChapter,
  chapterEstFromObserved, projectRemainingMs,
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

  it('drops fabricated quotes that stitch separate utterances and emits a log line naming the character', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.fn();
    const chars: CharacterOutput[] = [{
      id: 'halloran', name: 'Halloran', role: 'captain', color: 'halloran',
      evidence: [
        { quote: 'Hard to starboard' }, // real
        /* Stitched: the words exist in the source but never as one
           continuous run. The verifier must drop this. */
        { quote: 'Hard to starboard. Cold supper it is, then. Aye.' },
      ],
    }];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(1);
    expect(result.affectedCharacters).toBe(1);
    expect(chars[0].evidence).toHaveLength(1);
    expect(chars[0].evidence![0].quote).toBe('Hard to starboard');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('halloran');
    expect(log.mock.calls[0][0]).toMatch(/fabricated quote/i);
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
});

describe('mergeRosterChapter — Phase 0a roster merging', () => {
  it('appends new characters to an empty roster in incoming order', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      { id: 'sophie',   name: 'Sophie',   role: 'protagonist', color: 'orange' },
    ]);
    expect(Array.from(roster.keys())).toEqual(['narrator', 'sophie']);
  });

  it('merges evidence quotes into an existing entry, deduping on normalised quote text', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      evidence: [{ quote: 'Hello world.' }],
    }]);
    /* Same quote with smart-quote variation should NOT add a duplicate. */
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      evidence: [{ quote: '“Hello world.”' }, { quote: 'Different line.' }],
    }]);
    const sophie = roster.get('sophie')!;
    expect(sophie.evidence).toHaveLength(2);
    expect(sophie.evidence!.map(e => e.quote)).toEqual(['Hello world.', 'Different line.']);
  });

  it('keeps the longer description when a later chapter offers a richer one', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      description: 'A girl.',
    }]);
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
    }]);
    expect(roster.get('sophie')!.description).toContain('telepathic');
  });

  it('keeps the shorter description if a later chapter is shorter (longest-wins, not latest-wins)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
    }]);
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      description: 'A girl.',
    }]);
    expect(roster.get('sophie')!.description).toContain('telepathic');
  });

  it('latest-wins for tone fields when both chapters provide them', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      tone: { warmth: 30, pace: 50 },
    }]);
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      tone: { warmth: 80 }, /* pace not provided this round */
    }]);
    /* warmth updated; pace preserved (don't blank out a known value). */
    expect(roster.get('sophie')!.tone).toEqual({ warmth: 80, pace: 50 });
  });

  it('attributes union without duplicates', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      attributes: ['curious', 'wry'],
    }]);
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      attributes: ['wry', 'brave'], /* 'wry' is a duplicate */
    }]);
    expect(roster.get('sophie')!.attributes).toEqual(['curious', 'wry', 'brave']);
  });

  it('first-detection wins for identity fields (gender / ageRange)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      gender: 'female', ageRange: 'teen',
    }]);
    /* A later chapter says the model thinks she's male — ignored. The
       model would only flip gender via a hallucination; trust the first
       confident pass. */
    mergeRosterChapter(roster, [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      gender: 'male',
    }]);
    expect(roster.get('sophie')!.gender).toBe('female');
    expect(roster.get('sophie')!.ageRange).toBe('teen');
  });

  it('does not mutate the incoming chapter outputs (defensive clone)', () => {
    const roster = new Map<string, CharacterOutput>();
    const incoming: CharacterOutput[] = [{
      id: 'sophie', name: 'Sophie', role: 'p', color: 'orange',
      attributes: ['curious'],
      evidence: [{ quote: 'a' }],
      tone: { warmth: 30 },
    }];
    mergeRosterChapter(roster, incoming);
    /* Mutate the merged copy. */
    roster.get('sophie')!.attributes!.push('wry');
    roster.get('sophie')!.evidence!.push({ quote: 'b' });
    roster.get('sophie')!.tone!.warmth = 80;
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
