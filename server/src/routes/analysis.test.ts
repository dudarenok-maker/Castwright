import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sortEvidence,
  normaliseForMatch,
  verifyEvidenceAgainstSource,
  mergeRosterChapter,
  chapterEstFromObserved,
  clampStageEstMs,
  durationsForEngine,
  engineFallbackMsPerChar,
  localFallbackMsPerChar,
  projectChapterEstMsFromOutput,
  refineCastChapterEstMs,
  projectRemainingMs,
  buildInterimCast,
  clearFailedChapterId,
  recordFailedChapter,
  dropEvidencelessCast,
  isPhase0aCoverageComplete,
  reconcileSentenceCharacterIds,
  remapCjkHonorificIds,
  attributionDriftExceeded,
  stage1ShrinkRefused,
  buildStage1ChapterInbox,
  readPriorCastForMerge,
  recordRetirements,
  bookIdForRetirementCleanup,
  trackForReplay,
  replayCatchUp,
  castInFlightEntryToLiveChapter,
  resolveBookAuthorForManuscript,
  dedupAndPrepare,
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  aggregateStructureReports,
  aggregateMaxMergedTurns,
  buildStage2ChapterInbox,
  buildStage2ChunkInbox,
  STAGE2_ATTRIBUTION_RULES,
  STAGE2_ATTRIBUTION_RULES_CHUNK,
  selectStage2FailureCode,
  attributeChapterStage2,
  type AnalysisJob,
} from './analysis.js';
import type { Stage2CoverageVerdict } from '../analyzer/stage2-coverage.js';
import type { CharacterOutput, SentenceOutput, Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { EngineReport } from '../analyzer/dialogue-structure/types.js';
import type { BookStateJson } from '../workspace/scan.js';
import { GeminiContentBlockedError } from '../analyzer/errors.js';
import { dropBylineAuthorFromChapter } from '../analyzer/byline-author-guard.js';
import { normaliseNameKey } from '../util/safe-id.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import { clearAnalysisCache, saveAnalysisCache, loadAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript, type ChapterHint } from '../store/manuscripts.js';
import { castJsonPath, manuscriptEditsJsonPath } from '../workspace/paths.js';
import { loadCastIdHistory, retireCharacterId, castIdHistoryPath } from '../store/cast-id-history.js';
import { loadSuggestions } from '../store/cast-merge-suggestions.js';

/* W2.6 — Node cross-charge/cross-evict guards: the analyzer's confirmed
   GPU/CPU placement must be cached wherever detectOllamaDevice() actually
   runs. Mock its two call-site dependencies so the test below can assert
   the wiring without touching real Ollama / real GPU-cost state. */
const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({ detectOllamaDevice: detectOllamaDeviceMock }));
vi.mock('../gpu/analyzer-device-state.js', () => ({
  setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
}));

/* Controls the Phase-1 analyzer selection `runMainAnalyzerJob` resolves —
   mirrors the pattern in analysis.phase-model.test.ts / analysis-pipelining.test.ts. */
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__analyzer_device_test_phase1_selection) {
        return g.__analyzer_device_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

/* #2267 — `resolveBookLanguageForManuscript` (analysis.ts) resolves a book's
   language via `findBookByManuscriptId`, which scans the REAL on-disk
   `BOOKS_ROOT` tree — a tmpdir-based test book (as every provenance test
   below uses) is never found there, so it always falls through to the 'en'
   default (see the existing "writes analysisProvenance..." test's comment).
   That's fine for tests that don't care about language, but the
   fully-cached-book §4 test below needs a language WITH a paragraph-dash
   convention (ru) to get a non-`undefined` legibility reading. Mirrors the
   `__analyzer_device_test_phase1_selection` global-hook pattern above rather
   than a real BOOKS_ROOT write (which would touch the real workspace) or a
   file-wide behavior change (every other test keeps the real 'en' fallback
   since the override only fires when the hook is set for that manuscriptId). */
vi.mock('../workspace/scan.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/scan.js')>('../workspace/scan.js');
  return {
    ...actual,
    findBookByManuscriptId: async (manuscriptId: string) => {
      const g = globalThis as Record<string, unknown>;
      const override = g.__analysis_test_book_language_override as
        | { manuscriptId: string; language: string }
        | undefined;
      if (override && override.manuscriptId === manuscriptId) {
        return {
          bookDir: '/test-language-override',
          author: 'A',
          series: 'S',
          title: 'T',
          /* manuscriptFile points at a file that does not exist so a POST that
             sails through the language gate then hits getOrHydrateManuscript's
             workspace fallback cleanly returns undefined (no abort, no heavy
             loop) — exactly how the pre-existing 'en' fallback behaved for an
             unknown book. The direct runMainAnalyzerJob tests never call
             getOrHydrateManuscript, so this extra field is inert for them. */
          state: {
            manuscriptId,
            language: override.language,
            manuscriptFile: 'nonexistent-manuscript.txt',
          } as unknown as BookStateJson,
        };
      }
      /* Task 6c — override the *located-but-unset* case (a book EXISTS on disk
         but never declared a language), so tests can drive the 409 gate and the
         in-loop `language_unset` SSE error without touching a real BOOKS_ROOT
         tree. Mirrors the __analysis_test_book_language_override hook above:
         it fires only for the manuscriptIds listed, leaving every other test on
         the real 'en' fallback. */
      const unset = g.__analysis_test_book_language_unset as string[] | undefined;
      if (unset && unset.includes(manuscriptId)) {
        return {
          bookDir: '/test-language-override',
          author: 'A',
          series: 'S',
          title: 'T',
          state: {
            manuscriptId,
            language: undefined,
            manuscriptFile: 'nonexistent-manuscript.txt',
          } as unknown as BookStateJson,
        };
      }
      return actual.findBookByManuscriptId(manuscriptId);
    },
  };
});

describe('sortEvidence', () => {
  it("sorts each character's evidence by quote length descending", () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a',
        name: 'A',
        role: 'r',
        color: 'c',
        evidence: [
          { quote: 'short' }, // 5
          { quote: 'this is a much longer evidence quote' }, // 36
          { quote: 'medium length quote here' }, // 24
        ],
      },
    ];

    sortEvidence(chars);

    const lengths = chars[0].evidence!.map((e) => e.quote.length);
    expect(lengths).toEqual([36, 24, 5]);
  });

  it('preserves note and other fields when sorting', () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a',
        name: 'A',
        role: 'r',
        color: 'c',
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
      {
        id: 'thin',
        name: 'Thin',
        role: 'r',
        color: 'c',
        evidence: [{ quote: 'one' }, { quote: 'two' }],
      },
      {
        id: 'rich',
        name: 'Rich',
        role: 'r',
        color: 'c',
        evidence: [{ quote: 'one' }, { quote: 'two' }, { quote: 'three' }],
      },
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
    const input = '  “Hello — world…”\n  Line two.  ';
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
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'halloran',
        evidence: [{ quote: 'Hard to starboard' }, { quote: 'Cold supper it is, then.' }],
      },
    ];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps quotes whose only difference from the source is typography (smart quotes, em-dashes, whitespace)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = 'He thought: "It is a long road — perhaps the longest." She nodded.';
    const chars: CharacterOutput[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        role: 'narrator',
        color: 'narrator',
        evidence: [
          /* Smart quotes + em-dash + extra whitespace runs — should still match. */
          { quote: '“It is a long road —   perhaps the longest.”' },
        ],
      },
    ];
    const result = verifyEvidenceAgainstSource(chars, src, () => {});
    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps stitched same-speaker quotes via the segment tier when every segment is in source', () => {
    /* Regression for the Hollow Tide false-positive class: the model joins two
       consecutive same-speaker utterances and drops the narration tag
       between them. The pure-substring check used to drop these; the
       three-tier match now keeps them as `segments`. */
    const log = vi.fn();
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'halloran',
        evidence: [
          /* "Hard to starboard" and "Cold supper it is, then" are two
           separate utterances in SOURCE. The 3-char "aye." segment
           gets filtered by the ≥ 8-char rule so isn't required. */
          { quote: 'Hard to starboard. Cold supper it is, then. Aye.' },
        ],
      },
    ];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    /* The aggregate match-tier log line fires when the looser tiers
       actually carried a quote. */
    expect(
      log.mock.calls.some((call) => /Quote-match tiers:.*segments=1/.test(String(call[0]))),
    ).toBe(true);
  });

  it('keeps quotes whose only difference is terminal-punct drift (period for comma before a dialogue tag)', () => {
    /* The other half of the Hollow Tide false-positive class. Source punctuates
       the utterance with `,` because a dialogue tag follows; the model
       emits `.` because it treats the line as a complete sentence. */
    const src = '"Mammoths are extinct," she interrupted. The dog barked.';
    const chars: CharacterOutput[] = [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'wren',
        evidence: [{ quote: 'Mammoths are extinct.' }],
      },
    ];
    const log = vi.fn();
    const result = verifyEvidenceAgainstSource(chars, src, log);

    expect(result.totalDropped).toBe(0);
    expect(chars[0].evidence).toHaveLength(1);
    expect(log.mock.calls.some((call) => /terminal-punct=1/.test(String(call[0])))).toBe(true);
  });

  it('drops stitched quotes when at least one segment is genuinely fabricated', () => {
    /* "Cold supper it is, then" is in source, but "He winked" is NOT —
       so the segment tier must NOT accept the joined form. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.fn();
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'halloran',
        evidence: [{ quote: 'Cold supper it is, then. He winked at the parrot.' }],
      },
    ];

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
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'halloran',
        evidence: [
          /* Two halves, but only one is ≥ 8 chars after stripping. The
           short "No." segment is filtered out so we're left with a
           single segment — tier 3 must refuse it. */
          { quote: 'A fabricated long sentence never in the source. No.' },
        ],
      },
    ];

    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});

    expect(result.totalDropped).toBe(1);
    expect(chars[0].evidence).toHaveLength(0);
    warn.mockRestore();
  });

  it('leaves a character with empty evidence (no error) when every quote was fabricated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [
      {
        id: 'ghost',
        name: 'Ghost',
        role: 'spectre',
        color: 'c',
        evidence: [{ quote: 'I never said this in the book.' }, { quote: 'Or this either.' }],
      },
    ];

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
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'c',
        evidence: [{ quote: 'Hard to starboard' }],
      },
    ];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toEqual([]);
  });

  it('returns one dropped entry per fabricated quote with characterName captured at drop-time', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [
      {
        id: 'halloran',
        name: 'Halloran',
        role: 'captain',
        color: 'c',
        evidence: [
          /* Genuine fabrication (one segment is invented) — drops at all
           three tiers, preserves the note in the ledger entry. */
          { quote: 'Cold supper it is, then. The kraken danced a jig.', note: 'stitched' },
          { quote: 'Halloran said something profound.' },
        ],
      },
    ];
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
    const chars: CharacterOutput[] = [
      {
        id: 'voiceless',
        name: 'Voiceless',
        role: 'r',
        color: 'c',
        evidence: [
          /* Only quote marks + whitespace — normaliseForMatch strips
           these to '' so the verifier sees an empty needle. */
          { quote: '   "  "   ' },
        ],
      },
    ];
    const result = verifyEvidenceAgainstSource(chars, SOURCE, () => {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].reason).toBe('empty_after_normalisation');
    warn.mockRestore();
  });

  it('truncates dropped quotes that exceed the 2000-char cap and flags truncated:true', async () => {
    const { MAX_QUOTE_CHARS } = await import('../store/dropped-quotes.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = 'a'.repeat(MAX_QUOTE_CHARS + 500); // not in source
    const chars: CharacterOutput[] = [
      {
        id: 'verbose',
        name: 'Verbose',
        role: 'r',
        color: 'c',
        evidence: [{ quote: huge }],
      },
    ];
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
      { id: 'wren', name: 'Wren', role: 'protagonist', color: 'orange' },
    ]);
    expect(Array.from(roster.keys())).toEqual(['narrator', 'wren']);
  });

  it('merges evidence quotes into an existing entry, deduping on normalised quote text', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        evidence: [{ quote: 'Hello world.' }],
      },
    ]);
    /* Same quote with smart-quote variation should NOT add a duplicate. */
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        evidence: [{ quote: '“Hello world.”' }, { quote: 'Different line.' }],
      },
    ]);
    const wren = roster.get('wren')!;
    expect(wren.evidence).toHaveLength(2);
    expect(wren.evidence!.map((e) => e.quote)).toEqual(['Hello world.', 'Different line.']);
  });

  it('keeps the longer description when a later chapter offers a richer one', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        description: 'A girl.',
      },
    ]);
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
      },
    ]);
    expect(roster.get('wren')!.description).toContain('telepathic');
  });

  it('keeps the shorter description if a later chapter is shorter (longest-wins, not latest-wins)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
      },
    ]);
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        description: 'A girl.',
      },
    ]);
    expect(roster.get('wren')!.description).toContain('telepathic');
  });

  it('latest-wins for tone fields when both chapters provide them', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        tone: { warmth: 30, pace: 50 },
      },
    ]);
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        tone: { warmth: 80 } /* pace not provided this round */,
      },
    ]);
    /* warmth updated; pace preserved (don't blank out a known value). */
    expect(roster.get('wren')!.tone).toEqual({ warmth: 80, pace: 50 });
  });

  it('attributes union without duplicates', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        attributes: ['curious', 'wry'],
      },
    ]);
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        attributes: ['wry', 'brave'] /* 'wry' is a duplicate */,
      },
    ]);
    expect(roster.get('wren')!.attributes).toEqual(['curious', 'wry', 'brave']);
  });

  it('first-detection wins for identity fields (gender / ageRange)', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        gender: 'female',
        ageRange: 'teen',
      },
    ]);
    /* A later chapter says the model thinks she's male — ignored. The
       model would only flip gender via a hallucination; trust the first
       confident pass. */
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        gender: 'male',
      },
    ]);
    expect(roster.get('wren')!.gender).toBe('female');
    expect(roster.get('wren')!.ageRange).toBe('teen');
  });

  it('records a divergent same-id name form as an alias instead of dropping it', () => {
    /* The model emits the same id with a fuller name in a later chapter
       (e.g. «Антон» then «Антон Городецкий»). First-detection wins for the
       display name, but the divergent form must be preserved as an alias
       so cast review can surface it — not silently discarded. */
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{ id: 'anton', name: 'Антон', role: 'Иной', color: 'blue' }]);
    mergeRosterChapter(roster, [
      { id: 'anton', name: 'Антон Городецкий', role: 'Иной', color: 'blue' },
    ]);
    const anton = roster.get('anton')!;
    expect(anton.name).toBe('Антон');
    expect(anton.aliases).toEqual(['Антон Городецкий']);
  });

  it('does not alias an identical name, and never adds the entry’s own name', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [{ id: 'wren', name: 'Wren', role: 'p', color: 'orange' }]);
    mergeRosterChapter(roster, [{ id: 'wren', name: 'Wren', role: 'p', color: 'orange' }]);
    expect(roster.get('wren')!.aliases ?? []).toEqual([]);
  });

  it('unions incoming aliases, deduping case-insensitively and excluding the display name', () => {
    const roster = new Map<string, CharacterOutput>();
    mergeRosterChapter(roster, [
      { id: 'wren', name: 'Wren', role: 'p', color: 'orange', aliases: ['Wren Sparrow'] },
    ]);
    mergeRosterChapter(roster, [
      {
        id: 'wren',
        name: 'Sparrow',
        role: 'p',
        color: 'orange',
        aliases: ['wren sparrow', 'Wren'] /* dup of alias (case) + dup of display name */,
      },
    ]);
    /* 'Sparrow' (divergent name) added; 'Wren Sparrow' kept once (case dedup);
       'Wren' never added because it is the display name. */
    expect(roster.get('wren')!.aliases).toEqual(['Wren Sparrow', 'Sparrow']);
  });

  it('does not mutate the incoming chapter outputs (defensive clone)', () => {
    const roster = new Map<string, CharacterOutput>();
    const incoming: CharacterOutput[] = [
      {
        id: 'wren',
        name: 'Wren',
        role: 'p',
        color: 'orange',
        attributes: ['curious'],
        evidence: [{ quote: 'a' }],
        tone: { warmth: 30 },
      },
    ];
    mergeRosterChapter(roster, incoming);
    /* Mutate the merged copy. */
    roster.get('wren')!.attributes!.push('wry');
    roster.get('wren')!.evidence!.push({ quote: 'b' });
    roster.get('wren')!.tone!.warmth = 80;
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
describe('clampStageEstMs (whole-stage estimate — floor only, no 10-min cap)', () => {
  it('floors a tiny estimate at MIN_EST_MS', () => {
    expect(clampStageEstMs(100)).toBe(3000);
  });
  it('does NOT cap a large aggregate at 10 minutes (regression: local-model ETA pinned at ~10m)', () => {
    /* A 9-chapter book on local qwen3.5:4b can run ~90 min; the old clamp
       pinned the aggregate at 600_000 ms and the per-chapter ticker divided
       that down to absurd values. */
    expect(clampStageEstMs(90 * 60 * 1000)).toBe(90 * 60 * 1000);
  });
  it('rounds fractional milliseconds', () => {
    expect(clampStageEstMs(123_456.7)).toBe(123_457);
  });
});

describe('durationsForEngine (model-switch ETA staleness guard)', () => {
  it('seeds the cached durations when the engine matches', () => {
    const d = { 1: 30_000, 2: 45_000 };
    expect(durationsForEngine(d, 'local', 'local')).toBe(d);
  });
  it('discards durations produced by a different engine (Gemini cache → Qwen run)', () => {
    const d = { 1: 5_000 }; // Gemini-paced — would mis-seed a local run ~10x
    expect(durationsForEngine(d, 'gemini', 'local')).toEqual({});
  });
  it('discards untagged legacy durations (no stored engine)', () => {
    expect(durationsForEngine({ 1: 5_000 }, undefined, 'local')).toEqual({});
  });
  it('returns an empty map when there are no cached durations', () => {
    expect(durationsForEngine(undefined, 'local', 'local')).toEqual({});
  });
});

describe('engine/device-aware first-chapter fallback rate', () => {
  it('uses the fast CUDA rate for local on GPU', () => {
    expect(localFallbackMsPerChar('cuda')).toBe(1.2);
  });
  it('uses the ~10x slower rate for local on CPU', () => {
    expect(localFallbackMsPerChar('cpu')).toBe(12);
  });
  it('defaults unknown-device local to the GPU rate (the app target box)', () => {
    expect(localFallbackMsPerChar('unknown')).toBe(1.2);
  });
  it('keeps the Gemini rate for cloud regardless of device', () => {
    expect(engineFallbackMsPerChar('gemini', 'cpu')).toBe(0.5);
    expect(engineFallbackMsPerChar('gemini', 'cuda')).toBe(0.5);
  });
  it('routes local through the device-aware resolver', () => {
    expect(engineFallbackMsPerChar('local', 'cpu')).toBe(12);
    expect(engineFallbackMsPerChar('local', 'cuda')).toBe(1.2);
  });
});

describe('projectChapterEstMsFromOutput (mid-chapter live ETA refinement)', () => {
  it('returns null before enough time has elapsed', () => {
    expect(projectChapterEstMsFromOutput(5_000, 10_000, 100_000, 1.2)).toBeNull();
  });
  it('returns null with too few output bytes', () => {
    expect(projectChapterEstMsFromOutput(20_000, 500, 100_000, 1.2)).toBeNull();
  });
  it('projects total time from throughput once the signal is strong', () => {
    /* 100k input × 1.2 ratio = 120k expected output bytes. 30k received in
       60s → 25% done → ~240s total. */
    const out = projectChapterEstMsFromOutput(60_000, 30_000, 100_000, 1.2);
    expect(out).toBe(240_000);
  });
  it('caps apparent completion at 95% so a near-done chapter does not under-shoot', () => {
    // received >> expected → frac clamps to 0.95, not >1.
    const out = projectChapterEstMsFromOutput(60_000, 1_000_000, 100_000, 1.2);
    expect(out).toBe(Math.round(60_000 / 0.95));
  });
  it('returns null on a degenerate ratio or input', () => {
    expect(projectChapterEstMsFromOutput(60_000, 30_000, 0, 1.2)).toBeNull();
    expect(projectChapterEstMsFromOutput(60_000, 30_000, 100_000, 0)).toBeNull();
  });
});

describe('refineCastChapterEstMs (Phase-0a live ETA — section-progress + no-over-budget floor)', () => {
  it('projects total from section progress once ≥1 section is done', () => {
    // 1 of 4 sections done in 60s → ~240s total (dwarfs the 30s base).
    expect(refineCastChapterEstMs(60_000, 30_000, 1, 4)).toBe(240_000);
    // 3 of 4 done in 300s → ~400s total.
    expect(refineCastChapterEstMs(300_000, 30_000, 3, 4)).toBe(400_000);
  });

  it('never reads "over budget": estimate always sits above elapsed', () => {
    // A too-low base (the first-chapter lie) + no section data → floor wins.
    const est = refineCastChapterEstMs(120_000, 5_000, 0, 1);
    expect(est).toBeGreaterThan(120_000);
    expect(est).toBe(Math.round(120_000 * 1.1) + 3000);
  });

  it('keeps the base estimate early when it is comfortably ahead', () => {
    // Single-section chapter, 10s elapsed, 120s base → base wins (ahead of floor).
    expect(refineCastChapterEstMs(10_000, 120_000, 0, 1)).toBe(120_000);
  });

  it('the section projection still floors above elapsed near the end', () => {
    // Last section running long: done=3/4, elapsed 390s → proj 520s (still ahead).
    expect(refineCastChapterEstMs(390_000, 30_000, 3, 4)).toBe(520_000);
  });
});

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

/* clearFailedChapterId centralises the "did a previously-failed chapter
   just recover?" check used by both the full /analysis/stream route
   (Phase 0a re-queue success path) and the subset /analysis/chapters
   route. The two routes were duplicating the check inline, and they
   drifted: the full route's clear was wrapped in a truthy-length
   guard that re-saved a defined `failedChapterIds: []` even when the
   id wasn't actually in the list, while the subset route's path missed
   the SSE emission entirely. Promoting it to a tested helper keeps the
   emit-on-recovery invariant ("chapter-resolved fires iff the id was
   in the list") on a single line that both routes share. */
describe('clearFailedChapterId — recovery detection helper', () => {
  it('returns true and removes the id when it was in the list', () => {
    const cache = { failedChapterIds: [44, 49] };
    expect(clearFailedChapterId(cache, 44)).toBe(true);
    expect(cache.failedChapterIds).toEqual([49]);
  });

  it('returns false and leaves the list intact when the id was not present', () => {
    const cache = { failedChapterIds: [44, 49] };
    expect(clearFailedChapterId(cache, 999)).toBe(false);
    expect(cache.failedChapterIds).toEqual([44, 49]);
  });

  it('returns false when the field is undefined (legacy cache); does not initialise it', () => {
    const cache: { failedChapterIds?: number[] } = {};
    expect(clearFailedChapterId(cache, 44)).toBe(false);
    expect(cache.failedChapterIds).toBeUndefined();
  });

  it('returns false when the field is an empty array; does not flip the empty array', () => {
    const cache = { failedChapterIds: [] as number[] };
    expect(clearFailedChapterId(cache, 44)).toBe(false);
    expect(cache.failedChapterIds).toEqual([]);
  });

  it('is idempotent — a second call for the same id returns false (no double-emit)', () => {
    /* The route emits chapter-resolved on a true return. A double-call
       (e.g. retry-of-already-recovered-chapter) must not double-fire
       the event or the FE would see the row "resolve twice" and could
       race the panel state with a chapter-failed re-add. */
    const cache = { failedChapterIds: [44] };
    expect(clearFailedChapterId(cache, 44)).toBe(true);
    expect(clearFailedChapterId(cache, 44)).toBe(false);
    expect(cache.failedChapterIds).toEqual([]);
  });
});

describe('failedChapterErrors records (spec A4)', () => {
  it('recordFailedChapter writes id + error record', () => {
    const cache: {
      failedChapterIds?: number[];
      failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }>;
    } = {};
    recordFailedChapter(cache, 7, {
      code: 'analyzer-unreachable',
      userMessage: 'msg',
      remediation: 'fix',
    });
    expect(cache.failedChapterIds).toEqual([7]);
    expect(cache.failedChapterErrors?.['7']).toEqual({
      code: 'analyzer-unreachable',
      message: 'msg',
      remediation: 'fix',
    });
  });
  it('clearFailedChapterId clears the record alongside the id', () => {
    const cache = {
      failedChapterIds: [7],
      failedChapterErrors: { '7': { code: 'unknown', message: 'm', remediation: 'r' } },
    };
    expect(clearFailedChapterId(cache, 7)).toBe(true);
    expect(cache.failedChapterIds).toEqual([]);
    expect(cache.failedChapterErrors['7']).toBeUndefined();
  });
});

describe('chapter-failed replay map (spec A4 — reconnect carries code/remediation)', () => {
  function makeJob() {
    return {
      replay: { failedByChapterId: new Map(), logs: [], warnings: new Map() },
    } as unknown as Parameters<typeof trackForReplay>[0];
  }
  it('stores code + remediation off a chapter-failed event', () => {
    const job = makeJob();
    trackForReplay(job, {
      kind: 'chapter-failed',
      chapterId: 3,
      message: 'analyzer down',
      code: 'analyzer-unreachable',
      remediation: 'start ollama',
    });
    expect(
      (job as { replay: { failedByChapterId: Map<number, unknown> } }).replay.failedByChapterId.get(
        3,
      ),
    ).toEqual({
      kind: 'chapter-failed',
      chapterId: 3,
      message: 'analyzer down',
      code: 'analyzer-unreachable',
      remediation: 'start ollama',
    });
  });
  it('chapter-resolved drops the entry', () => {
    const job = makeJob();
    trackForReplay(job, { kind: 'chapter-failed', chapterId: 3, message: 'm' });
    trackForReplay(job, { kind: 'chapter-resolved', chapterId: 3 });
    expect(
      (job as { replay: { failedByChapterId: Map<number, unknown> } }).replay.failedByChapterId
        .size,
    ).toBe(0);
  });
});

describe('warning replay (#2015 — an advisory survives a disconnect)', () => {
  function makeJob(): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: 'm1',
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it('replays a warning emitted while nobody was listening', () => {
    const job = makeJob();
    trackForReplay(job, {
      kind: 'warning',
      code: 'cast_merge_base_stale',
      message: 'Another change landed.',
    });

    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));

    expect(sent).toContainEqual({
      kind: 'warning',
      code: 'cast_merge_base_stale',
      message: 'Another change landed.',
    });
  });

  it('dedupes by code — five sites conflicting once replay ONE advisory, not five', () => {
    const job = makeJob();
    for (let i = 0; i < 5; i++) {
      trackForReplay(job, {
        kind: 'warning',
        code: 'cast_merge_base_stale',
        message: `attempt ${i}`,
      });
    }
    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));
    expect(sent.filter((e) => (e as { kind?: string }).kind === 'warning')).toHaveLength(1);
  });

  it('ignores a malformed warning rather than storing an undefined key', () => {
    const job = makeJob();
    trackForReplay(job, { kind: 'warning' });
    trackForReplay(job, { kind: 'warning', code: 'x' });
    trackForReplay(job, { kind: 'warning', message: 'no code' });
    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));
    expect(sent).toHaveLength(0);
  });
});

/* Bug-3 diagnosis (Task B4): a page reload re-subscribes to the sticky job and
   the server replays `job.replay.lastPhase` verbatim via replayCatchUp. The
   live elapsed/sentence rows survive a reload IFF that snapshot is kept fresh.
   `send` (analysis.ts) routes EVERY payload through trackForReplay, and every
   `sendLiveTick` emits a `kind:'phase'` event — so trackForReplay overwrites
   `lastPhase` with the latest `live` snapshot on every tick. This pins the
   forwarding half of that contract: whatever `live.chapters` (incl. elapsedMs)
   `lastPhase` holds at reconnect is exactly what replayCatchUp re-emits. */
describe('replayCatchUp forwards live chapter rows on reconnect (bug 3 buffer)', () => {
  function makeJob(lastPhase: unknown) {
    return {
      replay: {
        lastPhase,
        logs: [],
        failedByChapterId: new Map(),
        warnings: new Map(),
      },
    } as unknown as Parameters<typeof replayCatchUp>[0];
  }

  it('re-emits the live chapter with its elapsedMs held in lastPhase', () => {
    const livePhase = {
      kind: 'phase',
      phaseId: 1,
      progress: 0.4,
      label: 'Casting voices',
      live: {
        totalChapters: 3,
        chapters: [
          {
            chapterIndex: 1,
            chapterTitle: 'Chapter One',
            elapsedMs: 302000,
            estMs: 400000,
            sectionsDone: 2,
            sectionsTotal: 5,
          },
        ],
      },
    };
    const job = makeJob(livePhase);
    const captured: unknown[] = [];
    replayCatchUp(job, (ev) => captured.push(ev));

    const phaseEv = captured.find(
      (e) => (e as { kind?: string }).kind === 'phase',
    ) as typeof livePhase | undefined;
    expect(phaseEv).toBeDefined();
    expect(phaseEv!.live?.chapters).toHaveLength(1);
    expect(phaseEv!.live?.chapters[0]).toMatchObject({
      chapterIndex: 1,
      elapsedMs: 302000,
    });
  });

  it('a live tick refreshes lastPhase so reconnect replays the latest elapsed', () => {
    // Simulate two successive live ticks landing in the replay buffer via the
    // same trackForReplay path `send` uses, then a reconnect replay.
    const job = makeJob(undefined);
    const tick = (elapsedMs: number) =>
      trackForReplay(job, {
        kind: 'phase',
        phaseId: 1,
        progress: 0.5,
        label: 'Casting voices',
        live: { totalChapters: 1, chapters: [{ chapterIndex: 1, elapsedMs }] },
      });
    tick(120000);
    tick(305000); // newest tick wins

    const captured: unknown[] = [];
    replayCatchUp(job, (ev) => captured.push(ev));
    const phaseEv = captured.find(
      (e) => (e as { kind?: string }).kind === 'phase',
    ) as { live?: { chapters: { elapsedMs: number }[] } } | undefined;
    expect(phaseEv?.live?.chapters[0].elapsedMs).toBe(305000);
  });
});

/* isPhase0aCoverageComplete gates stage1 finalisation in the subset-retry
   path. Without it, a sparse chapterCast (only some chapters run) plus
   failedChapterIds=[] would let rebuildRoster() write a partial roster
   over an existing richer one — see the regression on "The Floodmark" cited
   in the helper's comment. */
describe('isPhase0aCoverageComplete — Phase 0a coverage gate for stage1 finalisation', () => {
  const makeChar = (id: string): CharacterOutput => ({
    id,
    name: id,
    role: 'character',
    color: 'unset',
    evidence: [{ quote: `${id}'s quote, long enough to look real.` }],
  });

  it('returns complete when every non-excluded chapter has a non-empty chapterCast entry', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator'), makeChar('wren')],
      2: [makeChar('wren'), makeChar('marlow')],
      3: [makeChar('narrator')],
    };
    const result = isPhase0aCoverageComplete(chapterCast, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(result).toEqual({ complete: true, missingChapterIds: [], totalRequired: 3 });
  });

  it('flags missing chapters when chapterCast is sparse (The Floodmark-style regression)', () => {
    /* 5 chapters required, only 2 covered. */
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator')],
      3: [makeChar('narrator')],
    };
    const result = isPhase0aCoverageComplete(chapterCast, [
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.missingChapterIds).toEqual([2, 4, 5]);
    expect(result.totalRequired).toBe(5);
  });

  it('treats empty-array entries as missing (the route uses [] as the failure marker)', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator')],
      2: [], // failure marker
      3: [makeChar('narrator')],
    };
    const result = isPhase0aCoverageComplete(chapterCast, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(result.complete).toBe(false);
    expect(result.missingChapterIds).toEqual([2]);
    expect(result.totalRequired).toBe(3);
  });

  it('excluded chapters do not count toward coverage', () => {
    /* Chapter 2 is excluded (Dedication / front matter the user opted out
       of narrating). It must NOT be required for stage1 finalisation —
       Phase 0a deliberately skips excluded chapters. */
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator')],
      3: [makeChar('narrator')],
    };
    const result = isPhase0aCoverageComplete(chapterCast, [
      { id: 1 },
      { id: 2, excluded: true },
      { id: 3 },
    ]);
    expect(result).toEqual({ complete: true, missingChapterIds: [], totalRequired: 2 });
  });

  it('zero non-excluded chapters trivially complete (nothing to require)', () => {
    /* An entirely-excluded book is degenerate but shouldn't crash. */
    const result = isPhase0aCoverageComplete({}, [
      { id: 1, excluded: true },
      { id: 2, excluded: true },
    ]);
    expect(result).toEqual({ complete: true, missingChapterIds: [], totalRequired: 0 });
  });

  it('empty chapter hints returns complete (degenerate; caller is responsible for upstream validation)', () => {
    const result = isPhase0aCoverageComplete({}, []);
    expect(result).toEqual({ complete: true, missingChapterIds: [], totalRequired: 0 });
  });
});

/* reconcileSentenceCharacterIds is the Phase 1 disk-write safety net for
   orphan characterIds. Without it, manuscript-edits.json can carry IDs
   that don't exist in cast.json — exactly what we found on "The Floodmark"
   where 153 sentences referenced marlow/oduvan/maerin/linnet/wren after
   cast.json had been collapsed to Narrator-only by the partial-cache bug
   fixed in A1. */
describe('reconcileSentenceCharacterIds — Phase 1 orphan id demoter', () => {
  const makeSentence = (
    id: number,
    chapterId: number,
    characterId: string,
    text = `s${id}`,
  ): SentenceOutput => ({
    id,
    chapterId,
    characterId,
    text,
  });

  it('passes through sentences whose characterId is in validIds (no-op)', () => {
    const sentences = [
      makeSentence(1, 1, 'narrator'),
      makeSentence(2, 1, 'wren'),
      makeSentence(3, 2, 'marlow'),
    ];
    const result = reconcileSentenceCharacterIds(
      sentences,
      new Set(['narrator', 'wren', 'marlow']),
    );
    expect(result.demotedCount).toBe(0);
    expect(result.sentences).toEqual(sentences);
    expect(result.demotedByOriginalId.size).toBe(0);
  });

  it('demotes sentences whose characterId is missing from validIds to narrator (default fallback)', () => {
    /* The Floodmark-style regression: stage1 has [narrator] only, but Phase 1
       attributed to marlow/oduvan/maerin. Those ids become narrator at
       write time, preserving the rest of the sentence shape. */
    const sentences = [
      makeSentence(1, 1, 'narrator', 'Wren hailed me.'),
      makeSentence(2, 1, 'marlow', 'Hey, Foster.'),
      makeSentence(3, 2, 'oduvan', 'Yeti pee, fascinating.'),
      makeSentence(4, 2, 'narrator', 'Oduvan sighed.'),
    ];
    const result = reconcileSentenceCharacterIds(sentences, new Set(['narrator']));
    expect(result.demotedCount).toBe(2);
    expect(result.sentences.map((s) => s.characterId)).toEqual([
      'narrator',
      'narrator',
      'narrator',
      'narrator',
    ]);
    /* Non-characterId fields preserved verbatim. */
    expect(result.sentences[1].id).toBe(2);
    expect(result.sentences[1].text).toBe('Hey, Foster.');
    expect(result.sentences[2].chapterId).toBe(2);
    expect(result.sentences[2].text).toBe('Yeti pee, fascinating.');
    /* Per-original-id breakdown lets the caller surface a useful log line. */
    expect(result.demotedByOriginalId.get('marlow')).toBe(1);
    expect(result.demotedByOriginalId.get('oduvan')).toBe(1);
  });

  it('honours a custom fallbackId (caller can route to "unknown" instead of narrator)', () => {
    const sentences = [makeSentence(1, 1, 'marlow')];
    const result = reconcileSentenceCharacterIds(sentences, new Set(['narrator']), {
      fallbackId: 'unknown',
    });
    expect(result.sentences[0].characterId).toBe('unknown');
  });

  it('invokes onDemote for each orphan sentence with the original id intact', () => {
    const sentences = [
      makeSentence(1, 1, 'narrator'),
      makeSentence(2, 1, 'marlow'),
      makeSentence(3, 2, 'marlow'),
    ];
    const demotions: Array<{ sentenceId: number; originalId: string }> = [];
    reconcileSentenceCharacterIds(sentences, new Set(['narrator']), {
      onDemote: ({ sentence, originalId }) => {
        demotions.push({ sentenceId: sentence.id, originalId });
      },
    });
    expect(demotions).toEqual([
      { sentenceId: 2, originalId: 'marlow' },
      { sentenceId: 3, originalId: 'marlow' },
    ]);
  });

  it('returns a fresh array — caller-provided input is not mutated', () => {
    const sentences = [makeSentence(1, 1, 'marlow')];
    const before = JSON.stringify(sentences);
    reconcileSentenceCharacterIds(sentences, new Set(['narrator']));
    expect(JSON.stringify(sentences)).toBe(before);
  });

  // #1984 D18 — this is the site that matters: it runs by default,
  // knob-independently, and is the #1984 incident's own mechanism
  // (a roster-shrink demotion). `priorCharacterId` must record the id it
  // overwrote so the attribution-health metric can tell "engine demoted this"
  // apart from "the model said narrator".
  it('records the roster-shrink demotion, which is the #1984 incident mechanism', () => {
    const r = reconcileSentenceCharacterIds(
      [makeSentence(1, 1, 'dropped-char', '— Никого здесь не было.')],
      new Set(['egor', 'narrator']),
    );
    expect(r.sentences[0].characterId).toBe('narrator');
    expect(r.sentences[0].priorCharacterId).toBe('dropped-char');
    expect(r.demotedCount).toBe(1);
  });

  it('a sentence that is not demoted carries no priorCharacterId', () => {
    const r = reconcileSentenceCharacterIds(
      [makeSentence(1, 1, 'egor')],
      new Set(['egor', 'narrator']),
    );
    expect(r.sentences[0].priorCharacterId).toBeUndefined();
  });

  it('empty input is a no-op (zero counts, empty output)', () => {
    const result = reconcileSentenceCharacterIds([], new Set(['narrator']));
    expect(result.demotedCount).toBe(0);
    expect(result.sentences).toEqual([]);
    expect(result.demotedByOriginalId.size).toBe(0);
  });
});

describe('remapCjkHonorificIds — CJK title-variant rescue before demotion', () => {
  const makeSentence = (
    id: number,
    chapterId: number,
    characterId: string,
    text = `s${id}`,
  ): SentenceOutput => ({ id, chapterId, characterId, text });

  it('remaps honorific-fused orphan ids to their roster id on a zh book', () => {
    /* The observed failure: roster id is the bare "奥杜万"; Phase-1 attributed
       some lines to the fused "奥杜万师傅" (Master Oduvan). Strict equality
       would demote them → false drift. Here they resolve back to the roster. */
    const roster = [
      { id: 'narrator', name: 'Narrator' },
      { id: '奥杜万', name: '奥杜万' },
      { id: '玛俐恩', name: '玛俐恩' },
    ];
    const validIds = new Set(roster.map((c) => c.id));
    const sentences = [
      makeSentence(1, 2, 'narrator'),
      makeSentence(2, 2, '奥杜万师傅'), // Master Oduvan → 奥杜万
      makeSentence(3, 2, '地保玛俐恩'), // Constable Maerin → 玛俐恩
      makeSentence(4, 2, '奥杜万'), // already valid — untouched
    ];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'zh' });
    expect(result.remappedCount).toBe(2);
    expect(result.sentences.map((s) => s.characterId)).toEqual([
      'narrator',
      '奥杜万',
      '玛俐恩',
      '奥杜万',
    ]);
    // A subsequent reconcile now demotes nothing.
    const reconciled = reconcileSentenceCharacterIds(result.sentences, validIds);
    expect(reconciled.demotedCount).toBe(0);
  });

  it('leaves a genuinely-missed speaker to be demoted (no roster match)', () => {
    const roster = [
      { id: 'narrator', name: 'Narrator' },
      { id: '奥杜万', name: '奥杜万' },
    ];
    const validIds = new Set(roster.map((c) => c.id));
    // 烧炭人哈特 (Hart the charcoal-burner) was never rostered by Phase-0.
    const sentences = [makeSentence(1, 3, '烧炭人哈特')];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'zh' });
    expect(result.remappedCount).toBe(0);
    expect(result.sentences[0].characterId).toBe('烧炭人哈特'); // untouched → reconcile demotes it
    const reconciled = reconcileSentenceCharacterIds(result.sentences, validIds);
    expect(reconciled.demotedCount).toBe(1);
  });

  it('does NOT over-strip a familiar-prefix orphan into a wrong voice — it stays demoted', () => {
    /* The silent WRONG-remap vector: 小雀 (Sparrow) must NOT strip to 雀 and
       mis-map to a DIFFERENT roster character 雀. 小 is not an affix, so the
       orphan finds no match and is demoted — correct, and safer than a wrong
       voice. */
    const roster = [
      { id: 'narrator', name: 'Narrator' },
      { id: '雀', name: '雀' }, // a distinct character
    ];
    const validIds = new Set(roster.map((c) => c.id));
    const sentences = [makeSentence(1, 1, '小雀')];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'zh' });
    expect(result.remappedCount).toBe(0);
    expect(result.sentences[0].characterId).toBe('小雀');
    const reconciled = reconcileSentenceCharacterIds(result.sentences, validIds);
    expect(reconciled.demotedCount).toBe(1); // demoted to narrator, NOT mis-mapped to 雀
  });

  it('does NOT over-strip a ja-honorific-shaped zh name (丽君 stays, not → 丽)', () => {
    // Per-language gating: the ja list (君) never runs on a zh book.
    const roster = [
      { id: 'narrator', name: 'Narrator' },
      { id: '丽', name: '丽' },
    ];
    const validIds = new Set(roster.map((c) => c.id));
    const sentences = [makeSentence(1, 1, '丽君')];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'zh' });
    expect(result.remappedCount).toBe(0);
    expect(result.sentences[0].characterId).toBe('丽君');
  });

  it('does not remap when the stripped form is ambiguous (>1 roster entry)', () => {
    const roster = [
      { id: 'a', name: '王先生' },
      { id: 'b', name: '王夫人' },
    ];
    const validIds = new Set(['a', 'b']);
    const sentences = [makeSentence(1, 1, '王')];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'zh' });
    expect(result.remappedCount).toBe(0);
    expect(result.sentences[0].characterId).toBe('王');
  });

  it('is a byte-identical no-op for a non-CJK book (bookLanguage not zh/ja)', () => {
    const roster = [{ id: 'oduvan', name: 'Oduvan' }];
    const validIds = new Set(['oduvan', 'narrator']);
    const sentences = [
      makeSentence(1, 1, 'narrator'),
      makeSentence(2, 1, 'master-oduvan'), // an orphan, but non-CJK book → untouched
    ];
    const result = remapCjkHonorificIds(sentences, roster, validIds, { bookLanguage: 'en' });
    expect(result.remappedCount).toBe(0);
    expect(result.sentences).toBe(sentences); // same reference — no allocation
  });

  it('reports per-original-id counts and fires onRemap', () => {
    const roster = [{ id: '奥杜万', name: '奥杜万' }];
    const validIds = new Set(['奥杜万']);
    const sentences = [
      makeSentence(1, 2, '奥杜万师傅'),
      makeSentence(2, 2, '奥杜万师傅'),
    ];
    const seen: string[] = [];
    const result = remapCjkHonorificIds(sentences, roster, validIds, {
      bookLanguage: 'zh',
      onRemap: ({ originalId, toId }) => seen.push(`${originalId}->${toId}`),
    });
    expect(result.remappedCount).toBe(2);
    expect(result.remappedByOriginalId.get('奥杜万师傅')).toBe(2);
    expect(seen).toEqual(['奥杜万师傅->奥杜万', '奥杜万师傅->奥杜万']);
  });
});

describe('attributionDriftExceeded — threshold gate for blocking confirm advance', () => {
  it('returns false on small samples regardless of demotion rate (avoids false positives on micro-chapters)', () => {
    /* 99-sentence sample with 99 demotions — 100% demotion — is still
       below the 100-sentence minimum check, so the gate stays open.
       This is intentional: small first-chapter calls during a debug
       run shouldn't trip a route-wide error. */
    expect(attributionDriftExceeded(99, 99)).toBe(false);
  });

  it('returns false when demotion rate is below threshold on a large enough sample', () => {
    /* Default threshold is 5%; 4% should stay quiet. */
    expect(attributionDriftExceeded(20, 500)).toBe(false);
  });

  it('returns true when demotion rate exceeds threshold on a large enough sample', () => {
    /* Default threshold 5%, minimum 100. 10% on 500 trips it. */
    expect(attributionDriftExceeded(50, 500)).toBe(true);
  });

  it('honours a custom thresholdRatio + minSentencesForCheck', () => {
    /* Strict run: 1% threshold, 50-sentence minimum. 2 of 100 trips it. */
    expect(attributionDriftExceeded(2, 100, 0.01, 50)).toBe(true);
    expect(attributionDriftExceeded(1, 100, 0.01, 50)).toBe(false);
    /* Below custom minimum stays false. */
    expect(attributionDriftExceeded(99, 49, 0.01, 50)).toBe(false);
  });

  it('The Floodmark-shaped sample (153 demoted of 4192) stays below 5% — handled by demotion, no escalation', () => {
    /* The real regression numbers: marlow(134) + oduvan(9) + maerin(8) +
       linnet(1) + wren(1) = 153 orphan attributions out of 4192 total
       sentences. 153/4192 ≈ 3.65%. Demotion runs but the route still
       advances to confirm — this is the right call: a single-voice
       audiobook of 4039 narrator + 153 demoted-to-narrator is a degraded
       but coherent result that beats hard-stopping. */
    expect(attributionDriftExceeded(153, 4192)).toBe(false);
  });

  it('exactly-at-threshold is NOT exceeded (strict greater-than)', () => {
    /* 5.0% should not trip; 5.000001% should. */
    expect(attributionDriftExceeded(50, 1000)).toBe(false);
    expect(attributionDriftExceeded(51, 1000)).toBe(true);
  });
});

/* stage1ShrinkRefused is the data-loss guard for stage1 rewrites. When a
   well-populated existing roster would be replaced by a much smaller new
   roster, the route refuses the write and surfaces the choice to the
   user via `stage1_shrink_refused`. Without this guard The Floodmark
   regression (6 characters silently → 1) happens with no warning. */
describe('stage1ShrinkRefused — data-loss guard for stage1 rewrites', () => {
  it('refuses when next is less than half of prev on a non-trivial prior roster', () => {
    /* The Floodmark regression: prior had 6 characters, new run produces 1.
       1 < 6 * 0.5 = 3 → refused. */
    expect(stage1ShrinkRefused(6, 1)).toBe(true);
    expect(stage1ShrinkRefused(6, 2)).toBe(true);
  });

  it('allows shrinks that stay above the half threshold', () => {
    /* 6 → 3 is exactly half; default ratio is strict less-than (next < prev*0.5)
       so 3 (= 3.0) is NOT refused. The verifier might legitimately drop one
       or two evidenceless characters from a 6-character cast; that's fine. */
    expect(stage1ShrinkRefused(6, 3)).toBe(false);
    expect(stage1ShrinkRefused(6, 4)).toBe(false);
    expect(stage1ShrinkRefused(6, 5)).toBe(false);
    expect(stage1ShrinkRefused(6, 6)).toBe(false);
  });

  it('allows growth (next > prev) and equal counts', () => {
    expect(stage1ShrinkRefused(6, 10)).toBe(false);
    expect(stage1ShrinkRefused(3, 3)).toBe(false);
  });

  it('does not trigger when the prior roster is below minPrevForGate (default 3)', () => {
    /* A book that legitimately had 1-2 characters (a short story with
       a single narrator + one named speaker) shouldn't trip the gate
       when re-analysis collapses to a single narrator — the gate is
       for non-trivial casts. */
    expect(stage1ShrinkRefused(0, 0)).toBe(false);
    expect(stage1ShrinkRefused(1, 0)).toBe(false);
    expect(stage1ShrinkRefused(2, 0)).toBe(false);
    expect(stage1ShrinkRefused(2, 1)).toBe(false);
  });

  it('honours custom thresholdRatio + minPrevForGate', () => {
    /* Stricter run: 80% threshold (i.e. refuse any drop more than 20%), gate active from 2. */
    expect(stage1ShrinkRefused(5, 4, { thresholdRatio: 0.8, minPrevForGate: 2 })).toBe(false);
    expect(stage1ShrinkRefused(5, 3, { thresholdRatio: 0.8, minPrevForGate: 2 })).toBe(true);
    /* prev=2 now hits the gate. */
    expect(stage1ShrinkRefused(2, 1, { thresholdRatio: 0.8, minPrevForGate: 2 })).toBe(true);
  });

  it('first-run case (no prior stage1) never triggers — prev=0', () => {
    /* The main route's Phase 0b finalisation only enters when
       cache.stage1 was unset; prev=0, gate stays open. */
    expect(stage1ShrinkRefused(0, 5)).toBe(false);
    expect(stage1ShrinkRefused(0, 1)).toBe(false);
  });
});

/* The per-chapter inbox template feeds the detection skill. Verify it
   broadcasts the broadened inclusion rules so journal/registry/log
   chapters get the right guidance — without these, Gemini collapses
   The Floodmark-style first-person chapters to Narrator-only. */
describe('buildStage1ChapterInbox — Phase 0a per-chapter prompt', () => {
  it('includes manuscript metadata + chapter body verbatim', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'The Floodmark',
      {
        id: 7,
        title: "Oduvan's Medical Log",
        body: "I'd just settled into bed when Wren hailed me.",
      },
      [],
    );
    expect(inbox).toContain('manuscriptId: mns_test');
    expect(inbox).toContain('Title: The Floodmark');
    expect(inbox).toContain("Chapter: 7 — Oduvan's Medical Log");
    expect(inbox).toContain("I'd just settled into bed when Wren hailed me.");
  });

  /* #2313 — `name`/`aliases` were the one part of a non-English roster nothing
     bound to the manuscript's script, so they drifted: a Russian book came back
     59% Latin-named with the same weights and the same prompt. */
  it('binds name/aliases to the prose\'s own script, unconditionally', () => {
    /* Unconditional is the point. The rule takes no language argument, because
       `resolveBookLanguageForManuscript` returns 'en' on a miss and
       `normaliseBookLanguage` is `primary || 'en'` — so a language-gated rule
       would go silent (or assert English) on exactly the books that drift:
       those imported before fs-2 and those left undecided at the confirm
       screen. Those books also get an EMPTY `languagePreamble`, so this block
       is their only protection. */
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'Untitled',
      { id: 1, title: 'Chapter 1', body: 'Body.' },
      [],
    );
    expect(inbox).toMatch(/use the manuscript's own script/i);
    expect(inbox).toMatch(/exactly as this chapter'?s\s+prose spells them/i);
    expect(inbox).toMatch(/never\s+transliterate, romanise, or translate/i);
    /* No language is asserted ANYWHERE — stating one would be a guess. Pinning
       a single spelling (`^- Language:`) would let `- Book language: en` or
       `- Language (detected): en` reintroduce the defect untouched, so this
       checks for any `<label>: ` language assertion in the prompt. Verified no
       existing prompt text trips it. */
    expect(inbox).not.toMatch(/\blanguage\s*:/i);
  });

  it('carves `id` OUT of the script rule so ids stay ASCII kebab-case', () => {
    /* Regression for the other half of the same defect: the 2026-08-06 run
       emitted `борис-игнатьевич` as an *id*. A rule that said only "use the
       book's script" would bless that and break ids as stable join keys. */
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'Ночной дозор',
      { id: 1, title: 'Глава 1', body: 'Тело главы.' },
      [],
    );
    expect(inbox).toMatch(/`id` is the ONE exception/);
    expect(inbox).toMatch(/stays ASCII kebab-case/i);
    expect(inbox).toContain('Антон Городецкий` → `anton-gorodetsky');
  });

  it('does NOT let the id rule override reuse-the-roster-id-verbatim', () => {
    /* The transliterate-for-the-id sentence renders ABOVE the running-roster and
       series-prior blocks, both of which require reusing an existing id
       verbatim. Without the carve-back, a model correctly repairing a drifted
       `"Anton Gorodovsky"` back to `"Антон Городецкий"` would then derive
       `anton-gorodetsky` alongside the roster's existing `anton-gorodovsky`.
       `mergeRosterChapter` merges by id, so that splits one character into two
       roster rows, two voice profiles and two sets of lines — and it arrives
       past retireCharacterId/buildCastResolver, which watch for an id that
       CHANGED, not for a second one being minted. */
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'Ночной дозор',
      { id: 3, title: 'Глава 3', body: 'Тело главы.' },
      [
        {
          id: 'anton-gorodovsky',
          name: 'Anton Gorodovsky',
          role: 'Protagonist',
          color: '#c94f7c',
        },
      ],
    );
    /* The drifted id must be offered back verbatim, not "corrected". */
    expect(inbox).toContain('"id": "anton-gorodovsky"');
    expect(inbox).toMatch(/already appears in the running roster below/i);
    /* whitespace-tolerant: the block is hard-wrapped, so a reflow must not
       read as a missing rule */
    expect(inbox).toMatch(/reuse that `id` exactly as\s+written\s+there/i);
    expect(inbox).toMatch(/even when you are\s+correcting their `name`/i);
    /* The carve-back must sit INSIDE the same `## Names` block as the id rule —
       a structural check rather than a character budget, so rewording the
       paragraph cannot break a test that is not about wording. */
    const namesAt = inbox.indexOf("## Names — use the manuscript's own script");
    const nextHeadingAt = inbox.indexOf('\n## ', namesAt + 1);
    const idRuleAt = inbox.indexOf('`id` is the ONE exception');
    const carveAt = inbox.indexOf('already appears in the running roster');
    expect(namesAt).toBeGreaterThan(-1);
    expect(nextHeadingAt).toBeGreaterThan(namesAt);
    expect(idRuleAt).toBeGreaterThan(namesAt);
    expect(carveAt).toBeGreaterThan(idRuleAt);
    expect(carveAt).toBeLessThan(nextHeadingAt);
  });

  it('carries the name-fidelity + no-spurious-merge guardrails (2026-06-16 Russian surname-smear / Игорь↔Илья)', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'Night Watch',
      { id: 1, title: 'Chapter 1', body: 'Body.' },
      [],
    );
    // #1 name fidelity — no invented/copied surnames.
    expect(inbox).toMatch(/Name fidelity/i);
    expect(inbox).toMatch(/never copy another character'?s surname/i);
    // #3 no spurious merge of distinct names.
    expect(inbox).toMatch(/Do not merge distinct characters/i);
    expect(inbox).toMatch(/explicitly equates them/i);
  });

  it('renders the broadened first-person guidance so journal/registry chapters detect their author (regression for The Floodmark)', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'The Floodmark',
      { id: 7, title: "Oduvan's Medical Log", body: 'Body text.' },
      [],
    );
    /* The broadened rule names the document formats explicitly so the
       model knows to treat the chapter's prose as the author's evidence
       rather than collapsing to Narrator. */
    expect(inbox).toMatch(
      /journal entry|medical log|registry file|diary|letter|transcript|bio page/,
    );
    /* And it must call out that narrator is RESERVED for omniscient
       prose, not the default fallback for first-person content. */
    expect(inbox).toMatch(/reserved for omniscient/i);
  });

  it('renders the running-roster section with the supplied ids when non-empty', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'The Floodmark',
      { id: 7, title: 'X', body: 'Y.' },
      [
        {
          id: 'narrator',
          name: 'Narrator',
          role: 'Omniscient',
          color: 'narrator',
          evidence: [{ quote: 'q1' }],
        },
        {
          id: 'wren',
          name: 'Wren',
          role: 'Protagonist',
          color: 'unset',
          evidence: [{ quote: 'q2' }],
        },
      ],
    );
    expect(inbox).toContain('Running roster');
    expect(inbox).toContain('"id": "narrator"');
    expect(inbox).toContain('"id": "wren"');
    expect(inbox).toContain('"role": "Protagonist"');
  });

  it('renders the empty-roster fallback line when no characters have been detected yet (first chapter)', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'The Floodmark',
      { id: 1, title: 'Chapter 1', body: 'Body.' },
      [],
    );
    expect(inbox).toMatch(/first chapter being processed/i);
  });

  it('renders the series-cast prior section when sibling-book characters are supplied (C2 carry-over)', () => {
    /* The Floodmark-shaped regression motivator: the Hollow Tide + Bonus Marlow
       between them have Wren / Marlow / Oduvan already confirmed.
       Carrying them into The Floodmark's per-chapter prompt means the
       detector recognises them by name rather than inventing new ids. */
    const inbox = buildStage1ChapterInbox(
      'mns_unlocked',
      'The Floodmark',
      { id: 1, title: 'Chapter 1', body: 'I settled into bed.' },
      [],
      [
        {
          id: 'wren',
          name: 'Wren',
          aliases: ['Foster'],
          /* Deduped roster: Wren appears in two prior books, so the
             array carries both titles. */
          fromBookTitles: ['The Hollow Tide', 'The Ebb'],
        },
        { id: 'marlow', name: 'Marlow', fromBookTitles: ['the Coalfall Commission'] },
        {
          id: 'oduvan',
          name: 'Oduvan',
          description: 'A medical professional',
          fromBookTitles: ['The Hollow Tide'],
        },
      ],
    );
    expect(inbox).toContain('## Known characters from prior books in this series');
    /* All three names + their provenance render so the model can
       disambiguate same-name carry-overs across sibling books. */
    expect(inbox).toContain('"id": "wren"');
    expect(inbox).toContain('"id": "marlow"');
    expect(inbox).toContain('"id": "oduvan"');
    expect(inbox).toContain('The Hollow Tide');
    expect(inbox).toContain('the Coalfall Commission');
    /* The plural fromBookTitles renders as an array — important so the
       model sees that Wren spans two volumes, not just one. */
    expect(inbox).toMatch(/"fromBookTitles":\s*\[\s*"The Hollow Tide",\s*"The Ebb"\s*\]/);
    /* Singular legacy field must NOT appear in the rendered JSON. */
    expect(inbox).not.toMatch(/"fromBookTitle":/);
    /* And the reuse-verbatim guidance is rendered so the model knows
       NOT to invent a new id when a chapter speaker matches. */
    expect(inbox).toMatch(/reuse their `id` \*\*verbatim\*\*/i);
  });

  it('omits the series-cast prior section entirely when the prior list is empty (standalones / first-in-series)', () => {
    /* Default seriesPrior = [] should keep the prompt clean for
       standalones and the first book in a series -- no point in
       rendering an empty section. */
    const inbox = buildStage1ChapterInbox(
      'mns_standalone',
      'Standalone Book',
      { id: 1, title: 'Chapter 1', body: 'Body.' },
      [],
      [],
    );
    expect(inbox).not.toContain('Known characters from prior books');
  });

  it('compact prior rendering: aliases omitted from the JSON when the array is empty (saves prompt tokens)', () => {
    const inbox = buildStage1ChapterInbox(
      'mns_test',
      'Book',
      { id: 1, title: 'Chapter 1', body: 'Body.' },
      [],
      [{ id: 'lone-wolf', name: 'Lone Wolf', aliases: [], fromBookTitles: ['Earlier Book'] }],
    );
    /* The JSON.stringify-with-undefined trick: empty aliases array maps
       to undefined and disappears from the serialized JSON. Keeps the
       per-chapter prompt small on long series. */
    expect(inbox).toContain('"id": "lone-wolf"');
    expect(inbox).not.toContain('"aliases"');
    /* Single-entry fromBookTitles still renders as a one-element array,
       not unwrapped — the model handles either shape but the schema
       stays consistent for downstream prompt-stability tests. */
    expect(inbox).toMatch(/"fromBookTitles":\s*\[\s*"Earlier Book"\s*\]/);
  });
});

describe('buildStage1ChapterInbox — #938 byline-author guidance', () => {
  const chapter = { id: 1, title: 'Chapter 1', body: 'Эскалатор полз медленно.' };

  it('renders a "book author is not a character" block when an author is provided', () => {
    const md = buildStage1ChapterInbox('m1', 'Ночной дозор', chapter, [], [], 'Сергей Лукьяненко');
    expect(md).toMatch(/Сергей Лукьяненко/);
    expect(md).toMatch(/not a character/i);
  });

  it('omits the block when no author is provided (back-compat)', () => {
    const md = buildStage1ChapterInbox('m1', 'Ночной дозор', chapter, [], []);
    expect(md).not.toMatch(/not a character/i);
  });

  it('narrows the first-person-document rule to framed embedded documents', () => {
    const md = buildStage1ChapterInbox('m1', 'X', chapter, [], [], 'Author');
    expect(md).toMatch(/first-person novel is NOT/i);
  });
});

/* buildInterimCast underpins the mid-run cast.json writes — the helper
   must produce a deduped, palette-coloured roster with lines:0/scenes:0
   placeholders so the file shape matches the post-Phase-1 end-of-run
   write and frontend cast.json readers don't choke on partial data. */
describe('buildInterimCast — mid-run cast snapshot', () => {
  const makeChar = (
    id: string,
    name: string,
    opts: Partial<CharacterOutput> = {},
  ): CharacterOutput => ({
    id,
    name,
    role: 'character',
    color: 'unset',
    evidence: [{ quote: `${name}'s line one, long enough to be representative.` }],
    ...opts,
  });

  it('merges per-chapter character lists in chapter-id order and palette-colours the roster', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('narrator', 'Narrator'), makeChar('wren', 'Wren')],
      2: [makeChar('wren', 'Wren'), makeChar('marlow', 'Marlow')],
      3: [makeChar('marlow', 'Marlow'), makeChar('maerin', 'Maerin')],
    };

    const interim = buildInterimCast(chapterCast, [1, 2, 3]);

    /* 4 distinct ids after merge (narrator + wren + marlow + maerin). */
    expect(interim.map((c) => c.id)).toEqual(['narrator', 'wren', 'marlow', 'maerin']);

    /* Narrator keeps its dedicated palette slot; everyone else gets a
       deterministic non-narrator slot. */
    const narrator = interim.find((c) => c.id === 'narrator')!;
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

    expect(first.map((c) => ({ id: c.id, color: c.color }))).toEqual(
      second.map((c) => ({ id: c.id, color: c.color })),
    );
  });

  it('skips chapters that are missing from the chapterCast map (cache predates the chapter, or excluded)', () => {
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [makeChar('wren', 'Wren')],
      /* chapter 2 missing entirely — buildInterimCast must not throw. */
      3: [makeChar('marlow', 'Marlow')],
    };

    const interim = buildInterimCast(chapterCast, [1, 2, 3]);
    expect(interim.map((c) => c.id)).toEqual(['wren', 'marlow']);
  });

  it('folds descriptor names ("The Jogger", "Drooly Boy", "Unknown Intruder") into Unknown male/female buckets so the mid-run snapshot matches the post-Phase-1 fold', () => {
    /* Stage-1 detection emits descriptor names the user never wants to
       see as standalone cast entries. The on-disk cast.json mid-run
       must collapse them into the Unknown male / Unknown female
       buckets — same contract the live SSE cast-update uses — so the
       user inspecting `.audiobook/cast.json` while Phase 0a is still
       running sees the same shape they'll see at end-of-run. */
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [
        makeChar('narrator', 'Narrator'),
        makeChar('wren', 'Wren', { gender: 'female' }),
        makeChar('the-jogger', 'The Jogger', { gender: 'male' }),
      ],
      2: [
        makeChar('drooly-boy', 'Drooly Boy', { gender: 'male' }),
        makeChar('tall-lady', 'Tall Lady', { gender: 'female' }),
        makeChar('unknown-1', 'Unknown Intruder', { gender: 'male' }),
      ],
    };

    const interim = buildInterimCast(chapterCast, [1, 2]);

    expect(interim.map((c) => c.id).sort()).toEqual([
      'narrator',
      'unknown-female',
      'unknown-male',
      'wren',
    ]);
    const male = interim.find((c) => c.id === 'unknown-male')!;
    const female = interim.find((c) => c.id === 'unknown-female')!;
    expect(male.aliases).toEqual(['The Jogger', 'Drooly Boy', 'Unknown Intruder']);
    expect(female.aliases).toEqual(['Tall Lady']);
  });

  it('dedups same-name characters with divergent model ids in the interim cast (Fix 1)', () => {
    /* During Phase 0a the running roster merges by model id, so a small model
       that slugs the same name two ways (anton / антон) yields two pills. The
       interim cast + live SSE must dedup by name — consistently with the final
       cast — before the fold. */
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [{ id: 'anton', name: 'Антон', role: 'op', color: 'c' }],
      2: [{ id: 'антон', name: 'Антон', role: 'op', color: 'c' }],
    };
    const cast = buildInterimCast(chapterCast, [1, 2]);
    expect(cast.filter((c) => c.name === 'Антон')).toHaveLength(1);
  });

  it('mints localized Russian bucket names end-to-end when language is ru (Wave D, plan 221)', () => {
    /* A Russian book folds bare generic-noun descriptors and the bucket
       carries the user-specified Russian display name, matching what the
       post-Phase-1 fold will produce. */
    const chapterCast: Record<number, CharacterOutput[]> = {
      1: [
        makeChar('narrator', 'Рассказчик'),
        makeChar('anton', 'Антон', { gender: 'male' }),
        makeChar('parnishka', 'парень', { gender: 'male' }),
        makeChar('devushka', 'девушка', { gender: 'female' }),
      ],
    };

    const interim = buildInterimCast(chapterCast, [1], 'ru');

    const male = interim.find((c) => c.id === 'unknown-male')!;
    const female = interim.find((c) => c.id === 'unknown-female')!;
    expect(male?.name).toBe('Незнакомый Парень');
    expect(female?.name).toBe('Незнакомая Девушка');
    /* A real proper name ("Антон") is NOT folded. */
    expect(interim.some((c) => c.id === 'anton')).toBe(true);
  });
});

/* Phase 0b finalise drops non-narrator characters whose verifier
   killed every attributed quote — they failed the Stage-1 skill's
   own inclusion test ("can you copy a verbatim sentence … that is
   dialogue the entity speaks?"). Without this catch-net, pets +
   non-speakers that the model invented quotes for survive all the
   way to the cast view. */
describe('dropEvidencelessCast — Phase 0b drop of characters with no verifiable dialogue', () => {
  const makeChar = (
    id: string,
    name: string,
    evidence?: Array<{ quote: string }>,
  ): CharacterOutput => ({
    id,
    name,
    role: 'character',
    color: 'unset',
    evidence,
  });

  it('drops non-narrator characters left with zero evidence after the verifier ran', () => {
    const logs: string[] = [];
    const chars: CharacterOutput[] = [
      makeChar('narrator', 'Narrator', []), // narrator is exempt
      makeChar('wren', 'Wren', [{ quote: 'Real line' }]), // kept
      makeChar('pib', 'Pib', []), // pet — verifier killed everything
      makeChar('rescuer', 'Rescuer'), // never had evidence
    ];

    const kept = dropEvidencelessCast(chars, (msg) => logs.push(msg));

    expect(kept.map((c) => c.id)).toEqual(['narrator', 'wren']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Dropped 2 characters');
    expect(logs[0]).toContain('Pib');
    expect(logs[0]).toContain('Rescuer');
  });

  it('is a no-op (no log) when every non-narrator character has surviving evidence', () => {
    const logs: string[] = [];
    const chars: CharacterOutput[] = [
      makeChar('narrator', 'Narrator'),
      makeChar('wren', 'Wren', [{ quote: 'Line' }]),
      makeChar('marlow', 'Marlow', [{ quote: 'Line' }]),
    ];

    const kept = dropEvidencelessCast(chars, (msg) => logs.push(msg));

    expect(kept.map((c) => c.id)).toEqual(['narrator', 'wren', 'marlow']);
    expect(logs).toEqual([]);
  });

  it('NEVER drops the narrator even when it has zero evidence (narrator lines are prose, not dialogue)', () => {
    const chars: CharacterOutput[] = [
      makeChar('narrator', 'Narrator'), // no evidence
      makeChar('wren', 'Wren', [{ quote: 'Hi.' }]),
    ];

    const kept = dropEvidencelessCast(chars, () => {});
    expect(kept.map((c) => c.id)).toEqual(['narrator', 'wren']);
  });

  it('singularises the log message when exactly one character is dropped', () => {
    const logs: string[] = [];
    dropEvidencelessCast(
      [{ id: 'lone', name: 'Lone', role: 'r', color: 'c', evidence: [] }],
      (msg) => logs.push(msg),
    );
    expect(logs[0]).toContain('Dropped 1 character ');
    expect(logs[0]).not.toContain('Dropped 1 characters');
  });

  /* Defense-in-depth (Coalfall / Master Oduvan, 2026-06-09): the verifier can
     kill every quote of a REAL speaker when the source-vs-quote match is
     fragile (an encoding quirk, an LLM paraphrase). The roster-coverage guard
     that exists to never lose a tagged speaker runs during detection — BEFORE
     this prune — so it can't protect against the prune. Cross-check the prose:
     an evidenceless character the source still tags as a speaker is kept. */
  it('keeps an evidenceless character the source tags as a speaker, drops one with no tags', () => {
    const logs: string[] = [];
    const source =
      '"Leave it," said Master Oduvan, without looking up. "Whoever it is can knock." ' +
      '"If I douse the fire," Oduvan said, "I lose the weld I have been nursing." ' +
      'The cat watched from the rafters and did not speak.';
    const chars: CharacterOutput[] = [
      makeChar('narrator', 'Narrator', []),
      makeChar('wren', 'Wren', [{ quote: 'Real line' }]),
      makeChar('master-oduvan', 'Master Oduvan', []), // verifier killed all his quotes — but he's tagged
      makeChar('pib', 'Pib', []), // pet — never tagged as a speaker in the prose
    ];

    const kept = dropEvidencelessCast(chars, (msg) => logs.push(msg), source);

    expect(kept.map((c) => c.id)).toEqual(['narrator', 'wren', 'master-oduvan']);
    expect(logs.some((l) => /[Kk]ept 1 .*tag/.test(l))).toBe(true); // rescue logged
    expect(logs.some((l) => l.includes('Dropped 1 character') && l.includes('Pib'))).toBe(true);
  });

  it('drops a tagged-name character when no source text is supplied (back-compat)', () => {
    /* Without source text there's no tag signal — the prune behaves exactly
       as before, so the two-arg call sites and tests are unaffected. */
    const kept = dropEvidencelessCast(
      [makeChar('narrator', 'Narrator', []), makeChar('oduvan', 'Oduvan', [])],
      () => {},
    );
    expect(kept.map((c) => c.id)).toEqual(['narrator']);
  });
});

/* B1 — sticky analysis: in-flight job map + /pause endpoint.
   The full multi-subscriber + catch-up replay flow needs a mocked
   analyzer that can be paused mid-call; for now we exercise the
   most contract-critical surfaces:
     - POST /analysis/pause with no job is an idempotent no-op
       (returns paused:false, 200) — same shape as
       /generation/pause for symmetry.
     - isAnalysisJobRunning() returns false when nothing's running.
   The deeper integration tests (subscribe to existing job + replay,
   fresh: true displaces, server restart drops the map) are tracked
   for the B2/B3 commits where the frontend changes pull on them. */
describe('sticky analysis — in-flight job map + /pause endpoint', () => {
  it('isAnalysisJobRunning returns false when nothing is in flight', async () => {
    const { isAnalysisJobRunning } = await import('./analysis.js');
    expect(isAnalysisJobRunning('m_does_not_exist')).toBe(false);
  });

  it('POST /analysis/pause is an idempotent no-op when no job exists (200, paused:false)', async () => {
    /* Mirrors the generation /pause idempotency contract — middleware
       fires pause blindly on setPaused(true), so a double-click or a
       pause-after-completion must not 404. */
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');

    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const res = await supertest(app).post('/api/manuscripts/m_no_job/analysis/pause').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, paused: false });
  });
});

/* D1 — sticky subset retry: the second in-flight slot keyed by
   manuscriptId.

   We assert the contract-critical surfaces: snapshotInFlightAnalysis
   carries `kind` + `subsetChapterIds` only when subset state lives in
   the map, isAnalysisJobRunning reads from both slots, and pause is
   still a no-op when neither slot has a job.

   The deeper integration tests (subscribe-vs-start dispatch on the
   subset POST, multi-subscriber catch-up replay, mid-flight pause
   broadcasting endJob's paused snapshot to every subscriber) need a
   mocked analyzer that can park mid-call — same blocker the B1 sticky
   tests already noted for the main route. Tracked under plan 32 D1
   regression doc. */
describe('sticky subset retry — second in-flight slot (plan 32 D1)', () => {
  it('snapshotInFlightAnalysis returns null when neither main nor subset is live', async () => {
    const { snapshotInFlightAnalysis } = await import('./analysis.js');
    expect(snapshotInFlightAnalysis('m_nope')).toBeNull();
  });

  it('isAnalysisJobRunning returns false when both slots are empty', async () => {
    /* Sanity dual of the existing main-only check — confirms the
       OR-merge across both maps doesn't accidentally return true on
       a fresh manuscript id. */
    const { isAnalysisJobRunning } = await import('./analysis.js');
    expect(isAnalysisJobRunning('m_nope_either')).toBe(false);
  });

  it('POST /analysis/pause still no-ops when both slots are empty', async () => {
    /* Pause now aborts BOTH a main run AND a subset retry; the idempotent
       no-op behaviour from B1 carries through unchanged. */
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    const res = await supertest(app).post('/api/manuscripts/m_no_subset/analysis/pause').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, paused: false });
  });
});

describe('readPriorCastForMerge (srv-13 carryover fallback)', () => {
  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-prior-cast-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }
  const castPath = (dir: string) => join(dir, '.audiobook', 'cast.json');
  const carryPath = (dir: string) => join(dir, '.audiobook', 'cast-reuse-carryover.json');

  it('prefers cast.json when present', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(
        castPath(dir),
        JSON.stringify({ characters: [{ id: 'live', voiceId: 'live' }] }),
      );
      writeFileSync(
        carryPath(dir),
        JSON.stringify({ characters: [{ id: 'stale', voiceId: 'stale' }] }),
      );
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows.map((c) => c.id)).toEqual(['live']);
      expect(prior.source).toBe('cast');
      expect(prior.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the carryover when cast.json is absent (post-reparse window)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(
        carryPath(dir),
        JSON.stringify({
          characters: [
            { id: 'wren', voiceId: 'wren', voiceState: 'reused', matchedFrom: { bookId: 'b0' } },
          ],
        }),
      );
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows).toHaveLength(1);
      expect(prior.rows[0]).toMatchObject({ id: 'wren', voiceId: 'wren', voiceState: 'reused' });
      expect(prior.source).toBe('carryover');
      /* Design §1a — carryover rows describe bytes cast.json never held, so
         there is no compare-and-set available. `null` says "I cannot check",
         which is the honest answer and is what disables detection for the run
         rather than producing a wrong verdict. */
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no rows and no fingerprint when neither file exists', async () => {
    const dir = makeBookDir();
    try {
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows).toEqual([]);
      expect(prior.source).toBe('none');
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an EMPTY characters[] in cast.json still falls through to the carryover', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castPath(dir), JSON.stringify({ characters: [] }));
      writeFileSync(carryPath(dir), JSON.stringify({ characters: [{ id: 'wren' }] }));
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows.map((c) => c.id)).toEqual(['wren']);
      expect(prior.source).toBe('carryover');
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordRetirements clears a dropped self-loop notLinkedTo edge (#2133)', () => {
  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-record-retirements-selfloop-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  /* A reject's two writes (the `rejectedPairs` entry on cast-id-history.json
     and the one-sided `notLinkedTo` edge on cast.json) are created together
     and must be destroyed together (#2133). This mirrors the exact
     `retireCharacterId` self-loop shape `cast-id-history.test.ts`'s M2 test
     already pins (`rejectOrphanedPair(dir, 'mayrin', 'mairin')` then
     `retireCharacterId(dir, 'mairin', 'mayrin')` drops `{from: mayrin, to:
     mayrin}`) — seeded here with the matching `notLinkedTo` edge ALSO present
     on cast.json's `mayrin` row, the shape `seedReuseGuardsFromPriorCast`
     (merge-analysis-cast.ts) produces when a fresh analysis remints an
     orphaned, previously-rejected id as a live character (the module's own
     "an orphaned id is very often the character's own name" case). */
  it('removes the notLinkedTo edge naming the dropped pair\'s `from` id from cast.json', async () => {
    const dir = makeBookDir();
    const bookId = 'b_record_retirements_selfloop_test';
    try {
      writeFileSync(
        join(dir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'mayrin',
              name: 'Mayrin',
              notLinkedTo: [{ bookId, characterId: 'mayrin' }],
            },
          ],
        }),
      );
      const { rejectOrphanedPair } = await import('../store/cast-id-history.js');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');

      await recordRetirements(dir, bookId, [{ from: 'mairin', to: 'mayrin' }], null, () => {}, null);

      const history = await loadCastIdHistory(dir);
      expect(history.rejectedPairs ?? []).toEqual([]);

      const cast = JSON.parse(
        readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8'),
      ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }> };
      expect(cast.characters.find((c) => c.id === 'mayrin')!.notLinkedTo ?? []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an UNRELATED notLinkedTo edge on the same character untouched', async () => {
    // Same self-loop drop as above, but the row also carries an edge for a
    // different orphaned id — proves the cleanup is scoped to the dropped
    // pair's own `from`, not a blanket clear of the character's notLinkedTo.
    const dir = makeBookDir();
    const bookId = 'b_record_retirements_selfloop_unrelated_test';
    try {
      writeFileSync(
        join(dir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'mayrin',
              name: 'Mayrin',
              notLinkedTo: [
                { bookId, characterId: 'mayrin' },
                { bookId, characterId: 'someone-else' },
              ],
            },
          ],
        }),
      );
      const { rejectOrphanedPair } = await import('../store/cast-id-history.js');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');

      await recordRetirements(dir, bookId, [{ from: 'mairin', to: 'mayrin' }], null, () => {}, null);

      const cast = JSON.parse(
        readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8'),
      ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }> };
      expect(cast.characters.find((c) => c.id === 'mayrin')!.notLinkedTo).toEqual([
        { bookId, characterId: 'someone-else' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bookIdForRetirementCleanup — M6 (fix round, #2163)', () => {
  /* recordRetirements' `bookId` param exists ONLY to key
     clearNotLinkedEdgesForDroppedRejections' lookup against `notLinkedTo`
     edges keyed with the workspace `makeBookId` shape. The old call sites
     fell back to `record.bookId ?? bookIdFromTitle(record.title)` —
     `bookIdFromTitle` produces a completely different (title-only kebab
     slug) shape, so that fallback can never match a real edge; it fails
     OPEN by proceeding with a value that looks like a book id without
     being the one anything else uses. */
  it('returns record.bookId unchanged when present', () => {
    expect(bookIdForRetirementCleanup({ bookId: 'author__series__title', title: 'Some Title' })).toBe(
      'author__series__title',
    );
  });

  it('returns undefined (never a title-derived id) and warns when bookId is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = bookIdForRetirementCleanup({ title: 'Some Title' });
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('Some Title');
      expect(warnSpy.mock.calls[0][0]).toContain('skipping notLinkedTo cleanup');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('treats an empty-string bookId the same as absent (falls through to the warn+undefined path)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = bookIdForRetirementCleanup({ bookId: '', title: 'Some Title' });
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/* F8 (fix round 2, #2163) — the three unit tests above only pin the helper
   in isolation; they prove nothing about whether all FOUR real call sites
   (two in runMainAnalyzerJob's dedup + persist blocks, two in
   runSubsetAnalyzerJob's own dedup + persist blocks) actually call it,
   rather than still hand-rolling `record.bookId ?? bookIdFromTitle(record.title)`
   inline. "Mutate every entry point" is the rule this wave kept being
   bitten by — reverting ANY ONE of the four call sites back to the old
   inline fallback must turn at least one of the two tests below red.

   Neither test needs a real retirement to fire: `bookIdForRetirementCleanup`
   is called (and warns, since `record.bookId` is never set by the raw
   `putManuscript` fixture these tests use — the production-only path,
   `loadManuscriptForBook`, is what actually populates it) once PER SITE,
   independent of whether that site's retirement list ends up empty. Each
   job's two sites are made to fire in the SAME run — the dedup site needs
   only `priorCastForMerge.length > 1` (main) / is unconditional (subset),
   the persist site needs only a normal completing run — so the warn COUNT
   is the number of sites in that job still wired to the real helper. */
describe('bookIdForRetirementCleanup wired into every real call site (F8, #2163)', () => {
  function bookIdAbsentWarnings(warnSpy: { mock: { calls: unknown[][] } }): string[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((m: string) => m.includes('record.bookId is absent'));
  }

  function buildTrivialAnalyzer(roster: CharacterOutput[], sentences: SentenceOutput[]): {
    phase0: Analyzer;
    phase1: Analyzer;
  } {
    return {
      phase0: {
        runStage1: () => Promise.reject(new Error('not used')),
        async runStage1Chapter(): Promise<Stage1ChapterOutput> {
          return { characters: roster };
        },
        runStage2Chapter: () =>
          Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () => Promise.reject(new Error('not used')),
      },
      phase1: {
        runStage1: () => Promise.reject(new Error('not used')),
        runStage1Chapter: () =>
          Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
        async runStage2Chapter(): Promise<Stage2ChapterOutput> {
          return { sentences };
        },
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () =>
          Promise.reject(new Error('no flagged windows — escalation should never be called')),
      },
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  it(
    'runMainAnalyzerJob — dedup site + persist site both call it (warn fires exactly twice)',
    async () => {
      const manuscriptId = `test-f8-main-${Date.now()}-${Math.random()}`;
      const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-f8-main-e2e-test-'));
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: 'b_f8_main_e2e_test',
          manuscriptId,
          title: 'F8 Main E2E Test Book',
          author: 'Test Author',
          series: 'Standalones',
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.md',
          castConfirmed: false,
          chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
      // Deliberately NO `bookId` field here — mirrors the raw putManuscript
      // fixture pattern every other e2e-style test in this file already
      // uses (the production-only loadManuscriptForBook path is what
      // actually populates it), so `record.bookId` is genuinely falsy.
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'F8 Main E2E Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: CHAPTER_BODY,
        chapterHints,
        bookDir,
      });

      // 2 prior characters -> priorCastForMerge.length > 1 -> reaches the
      // MAIN job's dedup call site regardless of whether either name
      // actually collides with anything.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            { id: 'filler-a', name: 'Filler A' },
            { id: 'filler-b', name: 'Filler B' },
          ],
        }),
      );

      const roster: CharacterOutput[] = [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
        {
          id: 'anton',
          name: 'Anton',
          role: 'lead',
          color: '#111111',
          gender: 'male',
          evidence: [{ quote: 'Anton asked' }],
        },
      ];
      const sentences: SentenceOutput[] = [
        { id: 101, chapterId: 1, characterId: 'anton', confidence: 0.9, text: 'Are you sure this will work' },
      ];
      const { phase0, phase1 } = buildTrivialAnalyzer(roster, sentences);
      const phase0Selection = buildSelection(phase0, 'phase0-model');
      const phase1Selection = buildSelection(phase1, 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');
        // Sanity check on the fixture itself, not the fix: this run's
        // record genuinely has no bookId, so both call sites below are
        // exercising the warn path, not silently no-op-ing on a truthy one.
        expect(recordRef.bookId).toBeFalsy();

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // One from the dedup site (priorCastForMerge.length > 1 above), one
        // from the final authoritative persist. If EITHER call site reverts
        // to the old inline fallback, this drops from 2 to 1.
        expect(bookIdAbsentWarnings(warnSpy)).toHaveLength(2);
      } finally {
        warnSpy.mockRestore();
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    'runSubsetAnalyzerJob — dedup site + persist site both call it (warn fires exactly twice)',
    async () => {
      const manuscriptId = `test-f8-subset-${Date.now()}-${Math.random()}`;
      const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-f8-subset-e2e-test-'));
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: 'b_f8_subset_e2e_test',
          manuscriptId,
          title: 'F8 Subset E2E Test Book',
          author: 'Test Author',
          series: 'Standalones',
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.md',
          castConfirmed: false,
          chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
      // Same deliberate omission as the main-job test above.
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'F8 Subset E2E Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: CHAPTER_BODY,
        chapterHints,
        bookDir,
      });

      const roster: CharacterOutput[] = [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
        {
          id: 'anton',
          name: 'Anton',
          role: 'lead',
          color: '#111111',
          gender: 'male',
          evidence: [{ quote: 'Anton asked' }],
        },
      ];
      const sentences: SentenceOutput[] = [
        { id: 101, chapterId: 1, characterId: 'anton', confidence: 0.9, text: 'Are you sure this will work' },
      ];
      const { phase0, phase1 } = buildTrivialAnalyzer(roster, sentences);
      const phase0Selection = buildSelection(phase0, 'phase0-model-subset');
      const phase1Selection = buildSelection(phase1, 'phase1-model-subset');

      // stage1Existed === true, so the subset route actually reaches Phase 1
      // / the persist block the F8 persist site lives in, rather than
      // stopping after cast-update.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: roster,
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'subset',
        subsetChapterIds: chapterHints.map((c) => c.id),
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');
        expect(recordRef.bookId).toBeFalsy();

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        // One from the subset dedup site (unconditional — always reached),
        // one from the subset final authoritative persist. If EITHER call
        // site reverts to the old inline fallback, this drops from 2 to 1.
        expect(bookIdAbsentWarnings(warnSpy)).toHaveLength(2);
      } finally {
        warnSpy.mockRestore();
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('castInFlightEntryToLiveChapter — live tick chapter map (Phase-0a cast)', () => {
  it('live tick chapters carry section counts', () => {
    /* A chapter chunked into 4 sections with 2 done — the live tick entry
       must expose sectionsDone and sectionsTotal so the frontend can render
       section-level progress. */
    const entry = {
      chapterIndex: 0,
      chapterTitle: 'Chapter One',
      baseEstMs: 60_000,
      startedAt: Date.now() - 30_000,
      sectionsDone: 2,
      sectionsTotal: 4,
    };
    const result = castInFlightEntryToLiveChapter(entry, Date.now());
    expect(result.sectionsDone).toBe(2);
    expect(result.sectionsTotal).toBe(4);
  });

  it('preserves existing chapterIndex / chapterTitle / elapsedMs / estMs fields', () => {
    const now = Date.now();
    const entry = {
      chapterIndex: 2,
      chapterTitle: 'Chapter Three',
      baseEstMs: 30_000,
      startedAt: now - 10_000,
      sectionsDone: 0,
      sectionsTotal: 1,
    };
    const result = castInFlightEntryToLiveChapter(entry, now);
    expect(result.chapterIndex).toBe(3); // 0-based → 1-based
    expect(result.chapterTitle).toBe('Chapter Three');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.estMs).toBe('number');
  });
});

describe('resolveBookAuthorForManuscript', () => {
  it('returns "" for an unknown manuscript (no throw)', async () => {
    await expect(resolveBookAuthorForManuscript('mns_does_not_exist')).resolves.toBe('');
  });
});

/* #938 regression — byline-author exclusion on the CACHED roster path.
   The adversarial-review insight: the guard sits on the roster-BUILD
   (read) path inside rebuildRoster(), so it must drop the author even
   when chapterCast came from cache (a resume / already-analyzed book),
   not only for freshly-detected chapters.

   We cannot import rebuildRoster() (it is a closure inside the route),
   so we exercise the EXACT wiring Task 5 added:
     chapterCast → dropBylineAuthorFromChapter → mergeRosterChapter
   This is the composition that both entrypoints share and is the precise
   seam Task 5 introduced. The test FAILS without the guard. */
describe('#938 byline-author exclusion — cached roster path integration', () => {
  const BOOK_AUTHOR = 'Сергей Лукьяненко';

  /* Simulate a chapterCast record that came from CACHE (a prior
     completed analysis run). Chapter 1 is a story chapter; the
     stage-1 model mistakenly included the byline author. */
  const cachedChapterCast: Record<number, CharacterOutput[]> = {
    1: [
      {
        id: 'narrator',
        name: 'Narrator',
        role: 'Omniscient narrator',
        color: 'narrator',
        evidence: [{ quote: 'Эскалатор вниз полз медленно.' }],
      },
      {
        /* The bug: stage-1 detected the book's author as a character. */
        id: 'sergey-lukyanenko',
        name: 'Сергей Лукьяненко',
        role: 'Protagonist',
        color: 'unset',
        evidence: [{ quote: 'Я — Иной.' }],
      },
      {
        id: 'anton',
        name: 'Антон',
        role: 'Protagonist',
        color: 'unset',
        evidence: [{ quote: 'Поехали.' }],
      },
    ],
  };

  /* Inline the same logic rebuildRoster() uses in analysis.ts
     (both the main-route and subset-route closures do exactly this). */
  function rebuildRosterInline(
    chapterCast: Record<number, CharacterOutput[]>,
    chapterHints: Array<{ id: number; title?: string }>,
    author: string,
  ): Map<string, CharacterOutput> {
    const r = new Map<string, CharacterOutput>();
    for (const ch of chapterHints) {
      const cast = chapterCast[ch.id];
      if (cast?.length) {
        const guarded = dropBylineAuthorFromChapter(cast, {
          author,
          chapterTitle: ch.title,
        });
        mergeRosterChapter(r, guarded.characters);
      }
    }
    return r;
  }

  it('excludes the byline author from the final roster when chapterCast came from cache', () => {
    const chapterHints = [{ id: 1, title: 'Пролог' }];

    const finalRoster = rebuildRosterInline(cachedChapterCast, chapterHints, BOOK_AUTHOR);
    const rosterArray = Array.from(finalRoster.values());

    /* The real protagonist and narrator must survive. */
    expect(rosterArray.some((c) => c.id === 'anton')).toBe(true);
    expect(rosterArray.some((c) => c.id === 'narrator')).toBe(true);

    /* The byline author must NOT appear in the final roster (match
       case-insensitively via normaliseNameKey, same as the guard uses). */
    const authorKey = normaliseNameKey(BOOK_AUTHOR);
    const authorEntry = rosterArray.find((c) => normaliseNameKey(c.name) === authorKey);
    expect(authorEntry).toBeUndefined();
  });

  it('would include the byline author if the guard were absent (confirms the test is meaningful)', () => {
    /* Simulate rebuildRoster WITHOUT the guard — raw mergeRosterChapter
       from cache. If the guard is removed, the author leaks through. */
    const r = new Map<string, CharacterOutput>();
    mergeRosterChapter(r, cachedChapterCast[1]!);
    const rosterArray = Array.from(r.values());

    const authorKey = normaliseNameKey(BOOK_AUTHOR);
    const authorEntry = rosterArray.find((c) => normaliseNameKey(c.name) === authorKey);

    /* Without the guard the author IS in the roster — this confirms the
       test above is a meaningful regression (the guard is the diff). */
    expect(authorEntry).toBeDefined();
  });

  /* The two cases below exercise buildInterimCast directly — the exported
     function that wires dropBylineAuthorFromChapter inside its own loop.
     If the guard is deleted from buildInterimCast specifically, these
     cases go red even if the rebuildRosterInline cases above stay green. */
  it('buildInterimCast — excludes the byline author when author arg is supplied', () => {
    const interim = buildInterimCast(cachedChapterCast, [1], undefined, BOOK_AUTHOR);

    /* Real characters survive. */
    expect(interim.some((c) => c.id === 'anton')).toBe(true);
    expect(interim.some((c) => c.id === 'narrator')).toBe(true);

    /* The byline author must be absent. */
    const authorKey = normaliseNameKey(BOOK_AUTHOR);
    const authorEntry = interim.find((c) => normaliseNameKey(c.name) === authorKey);
    expect(authorEntry).toBeUndefined();
  });

  it('buildInterimCast — includes the byline author when author arg is omitted (witness: exclusion is from the guard)', () => {
    /* Without the author arg the guard has nothing to match against, so
       the author entry passes through. This proves the exclusion in the
       case above is attributable to the guard, not some other filter. */
    const interim = buildInterimCast(cachedChapterCast, [1]);

    const authorKey = normaliseNameKey(BOOK_AUTHOR);
    const authorEntry = interim.find((c) => normaliseNameKey(c.name) === authorKey);
    expect(authorEntry).toBeDefined();
  });
});

describe('dedupAndPrepare — dedup BEFORE fold, sentence rewrite + capture for journal', () => {
  const char = (over: Partial<CharacterOutput> & { id: string; name: string }): CharacterOutput =>
    ({
      role: 'supporting',
      attributes: [],
      evidence: [],
      lines: 0,
      scenes: 0,
      ...over,
    }) as CharacterOutput;

  const sentence = (over: Partial<SentenceOutput> & { id: number; characterId: string }): SentenceOutput =>
    ({ chapterId: 1, text: 'x', ...over }) as SentenceOutput;

  it('collapses two same-name characters to one canonical id and rewrites all their sentences', () => {
    const characters: CharacterOutput[] = [
      char({ id: 'olga', name: 'Ольга', gender: 'female' }),
      char({ id: 'ольга', name: 'Ольга', gender: 'female' }),
    ];
    const sentences: SentenceOutput[] = [
      sentence({ id: 1, characterId: 'olga' }),
      sentence({ id: 2, characterId: 'ольга' }),
      sentence({ id: 3, characterId: 'narrator' }),
    ];

    const dd = dedupAndPrepare(characters, sentences, 'ru');

    // ONE Ольга survives, with the safeId-derived canonical id.
    const olgas = dd.characters.filter((c) => c.name === 'Ольга');
    expect(olgas).toHaveLength(1);
    const canonical = olgas[0].id;
    expect(canonical).toBe('ольга');

    // Every sentence that was attributed to either source now points at the canonical id.
    expect(dd.sentences.find((s) => s.id === 1)!.characterId).toBe(canonical);
    expect(dd.sentences.find((s) => s.id === 2)!.characterId).toBe(canonical);
    // Untouched sentences keep their attribution.
    expect(dd.sentences.find((s) => s.id === 3)!.characterId).toBe('narrator');

    // A non-empty rewrites map drove the collapse.
    expect(Object.keys(dd.rewrites).length).toBeGreaterThan(0);
    expect(dd.rewrites['olga']).toBe(canonical);

    // preDedupSentences captured the ORIGINAL ids (pre-rewrite) for the journal.
    expect(dd.preDedupSentences.find((s) => s.id === 1)!.characterId).toBe('olga');
    expect(dd.preDedupSentences.find((s) => s.id === 2)!.characterId).toBe('ольга');

    // preDedupRoster captured the pre-dedup names (for journal sourceName lookup).
    expect(dd.preDedupRoster.some((r) => r.id === 'olga' && r.name === 'Ольга')).toBe(true);
  });

  it('is a no-op (empty rewrites) when the roster has no name collisions', () => {
    const characters: CharacterOutput[] = [
      char({ id: 'anton', name: 'Антон', gender: 'male' }),
      char({ id: 'olga', name: 'Ольга', gender: 'female' }),
    ];
    const sentences: SentenceOutput[] = [
      sentence({ id: 1, characterId: 'anton' }),
      sentence({ id: 2, characterId: 'olga' }),
    ];

    const dd = dedupAndPrepare(characters, sentences, 'ru');

    expect(dd.characters).toHaveLength(2);
    expect(Object.keys(dd.rewrites)).toHaveLength(0);
    // Sentences pass through unchanged.
    expect(dd.sentences.find((s) => s.id === 1)!.characterId).toBe('anton');
    expect(dd.sentences.find((s) => s.id === 2)!.characterId).toBe('olga');
  });
});

describe('runMainAnalyzerJob — analyzer device cache wiring (W2.6)', () => {
  function buildSpyPhase0Analyzer(): Analyzer {
    return {
      async runStage1(): Promise<Stage1Output> {
        throw new Error('runStage1 not used in this suite');
      },
      async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
        return {
          characters: [
            {
              id: 'narrator',
              name: 'Narrator',
              role: 'narrator',
              color: 'narrator',
              evidence: [
                { quote: 'lorem ipsum dolor sit amet' },
                { quote: 'lorem ipsum dolor sit amet' },
                { quote: 'lorem ipsum dolor sit amet' },
              ],
            },
            {
              id: `ch${chapterId}-char`,
              name: `Character_ch${chapterId}`,
              role: 'character',
              color: 'unset',
              evidence: [
                { quote: 'lorem ipsum dolor sit amet' },
                { quote: 'lorem ipsum dolor sit amet' },
                { quote: 'lorem ipsum dolor sit amet' },
              ],
            },
          ],
        };
      },
      async runStage2Chapter(): Promise<Stage2ChapterOutput> {
        throw new Error('Phase-0 analyzer does not run Phase-1 calls');
      },
      async runEmotionChapter() {
        throw new Error('Phase-0 analyzer does not run emotion calls');
      },
      async runScriptReviewChapter() {
        throw new Error('Phase-0 analyzer does not run script review calls');
      },
      async runStage3Chapter() {
        throw new Error('Phase-0 analyzer does not run instruct-annotation calls');
      },
      async runAttributionEscalation() {
        throw new Error('Phase-0 analyzer does not run escalation calls');
      },
    };
  }

  function buildSpyPhase1Analyzer(): Analyzer {
    return {
      async runStage1(): Promise<Stage1Output> {
        throw new Error('runStage1 not used in this suite');
      },
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new Error('Phase-1 analyzer does not run Phase-0 calls');
      },
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return {
          sentences: [
            {
              id: chapterId * 100 + 1,
              chapterId,
              characterId: 'narrator',
              text: 'lorem ipsum dolor sit amet.',
            },
          ],
        };
      },
      async runEmotionChapter() {
        throw new Error('Phase-1 analyzer does not run emotion calls');
      },
      async runScriptReviewChapter() {
        throw new Error('Phase-1 analyzer does not run script review calls');
      },
      async runStage3Chapter() {
        throw new Error('Phase-1 analyzer does not run instruct-annotation calls');
      },
      async runAttributionEscalation() {
        throw new Error('Phase-1 analyzer does not run escalation calls');
      },
    };
  }

  function buildSelection(analyzer: Analyzer, model: string, engine: 'local' | 'gemini'): AnalyzerSelection {
    return { analyzer, engine, model, fallbackModel: null };
  }

  function buildStubJob(manuscriptId: string): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  function buildStubChapters(count: number): ChapterHint[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `Chapter ${i + 1}`,
      body: `Chapter ${i + 1} body. ` + 'lorem ipsum dolor sit amet '.repeat(50),
    }));
  }

  function registerStubManuscript(id: string, count: number): void {
    const chapterHints = buildStubChapters(count);
    putManuscript({
      manuscriptId: id,
      format: 'plaintext',
      title: `Stub ${id}`,
      wordCount: chapterHints.length * 100,
      byteSize: 100_000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
    });
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }

  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;

  afterEach(() => {
    clearPhase1Selection();
    detectOllamaDeviceMock.mockClear();
    setLastKnownAnalyzerDeviceMock.mockClear();
    if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
  });

  async function runJobWith(engine0: 'local' | 'gemini', engine1: 'local' | 'gemini'): Promise<void> {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const manuscriptId = `test-analyzer-device-${engine0}-${engine1}-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);

    const phase0Selection = buildSelection(buildSpyPhase0Analyzer(), 'phase0-model', engine0);
    const phase1Selection = buildSelection(buildSpyPhase1Analyzer(), 'phase1-model', engine1);
    setPhase1Selection(phase1Selection);

    const job = buildStubJob(manuscriptId);

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }

  it(
    'cloud engine (both phases): does NOT probe Ollama and does NOT touch the global cache',
    async () => {
      /* A cloud-only job has nothing new to report about the local Ollama
         analyzer's placement — it must leave whatever a concurrent/prior
         local job's cache write established untouched, not clobber it with
         'unknown' (a real regression under concurrent multi-book use: see
         docs/features/236-multi-gpu-per-model-safety.md). */
      await runJobWith('gemini', 'gemini');

      expect(detectOllamaDeviceMock).not.toHaveBeenCalled();
      expect(setLastKnownAnalyzerDeviceMock).not.toHaveBeenCalled();
    },
    60_000,
  );

  it(
    'local engine (phase 0): setLastKnownAnalyzerDevice gets the resolved detectOllamaDevice() value',
    async () => {
      detectOllamaDeviceMock.mockResolvedValueOnce('cpu');

      await runJobWith('local', 'gemini');

      expect(detectOllamaDeviceMock).toHaveBeenCalled();
      expect(setLastKnownAnalyzerDeviceMock).toHaveBeenCalledWith('cpu');
    },
    60_000,
  );

  it(
    'a concurrent cloud-engine job does not clobber a prior local job\'s cached device (concurrent multi-book regression)',
    async () => {
      /* Simulates: Book A's local-engine job confirms 'cpu' (setLastKnownAnalyzerDevice
         is a single process-wide global — Book A and Book B share it). Book B's
         cloud-engine job must not overwrite that with 'unknown', or the W2.6
         cross-charge guard silently reverts to full-weight charging for the rest
         of the process. */
      detectOllamaDeviceMock.mockResolvedValueOnce('cpu');
      await runJobWith('local', 'gemini');
      expect(setLastKnownAnalyzerDeviceMock).toHaveBeenCalledWith('cpu');

      setLastKnownAnalyzerDeviceMock.mockClear();
      detectOllamaDeviceMock.mockClear();

      await runJobWith('gemini', 'gemini');
      expect(detectOllamaDeviceMock).not.toHaveBeenCalled();
      expect(setLastKnownAnalyzerDeviceMock).not.toHaveBeenCalled();
    },
    60_000,
  );
});

describe('selectStage2FailureCode (#2342 item 2 — collapse vs. incomplete)', () => {
  /* A dialogue collapse (every spoken line handed to the narrator, or the
     dialogue markers lost outright) covered EVERY sentence — there is no gap
     to fill, so `attribution-incomplete`'s copy ("did not cover every
     sentence… retry usually fills the gaps") is false on every count for
     this shape. `attribution-collapse` is the code that tells the truth: the
     cast was ignored. A verdict that ALSO fails on coverage/duplication
     keeps `attribution-incomplete` — missing prose is the more serious
     problem, and that code's remediation (retry to fill the gap) is the one
     that actually helps. */
  function baseVerdict(): Stage2CoverageVerdict {
    return {
      ok: false,
      coverageRatio: 1,
      endingPresent: true,
      duplicatedBlock: null,
      narratedSpeech: null,
      noSentences: false,
      truncated: false,
      excess: false,
      markersLost: false,
      issues: [],
    };
  }

  it('markersLost alone (no coverage/duplication failure) -> attribution-collapse', () => {
    const v = { ...baseVerdict(), markersLost: true };
    expect(selectStage2FailureCode(v)).toBe('attribution-collapse');
  });

  it('a narratedSpeech collapse breach alone -> attribution-collapse', () => {
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      narratedSpeech: { speechHalves: 30, narrated: 25, pct: (25 / 30) * 100, evaluable: true },
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-collapse');
  });

  it('an UN-evaluable narratedSpeech reading (too little dialogue) is not a collapse', () => {
    /* evaluable: false — too few speech halves to judge; must not misread as
       a breach. Deliberately NO other failing gate (no truncated/excess/
       duplicatedBlock/noSentences) — `isIncomplete` must stay false here too,
       or this assertion would pass via that branch regardless of whether the
       evaluable gate is respected, proving nothing about it. */
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      narratedSpeech: { speechHalves: 2, narrated: 2, pct: 100, evaluable: false },
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('truncated coverage failure alone -> attribution-incomplete', () => {
    const v = { ...baseVerdict(), truncated: true };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('excess coverage (repeat-loop) alone -> attribution-incomplete', () => {
    const v = { ...baseVerdict(), excess: true };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('a duplicated block alone -> attribution-incomplete', () => {
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      duplicatedBlock: { startIndex: 4, length: 3, offset: 5 },
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('noSentences alone -> attribution-incomplete', () => {
    const v = { ...baseVerdict(), noSentences: true };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('BOTH a coverage failure AND a collapse -> prefers attribution-incomplete (missing prose is worse)', () => {
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      truncated: true,
      markersLost: true,
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  it('a duplicated block AND a narratedSpeech collapse breach -> prefers attribution-incomplete', () => {
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      duplicatedBlock: { startIndex: 4, length: 3, offset: 5 },
      narratedSpeech: { speechHalves: 30, narrated: 25, pct: (25 / 30) * 100, evaluable: true },
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });

  /* Review round 3 — `markersLost` is gated `!truncated && !excess` only, NOT
     `!duplicatedBlock`, so a repeat-loop CAN also lose its dialogue markers
     (see stage2-coverage.test.ts's own regression for a real
     validateStage2Coverage take that produces exactly this combination).
     This function's precedence — `isIncomplete` wins — must still hold, the
     same as the collapse-breach overlap case above. */
  it('a duplicated block AND markersLost -> prefers attribution-incomplete', () => {
    const v: Stage2CoverageVerdict = {
      ...baseVerdict(),
      duplicatedBlock: { startIndex: 4, length: 3, offset: 5 },
      markersLost: true,
    };
    expect(selectStage2FailureCode(v)).toBe('attribution-incomplete');
  });
});

describe('aggregateStructureReports (srv-59 Task 11 — provenance report aggregation)', () => {
  function makeReport(overrides: Partial<EngineReport>): EngineReport {
    return {
      language: 'en',
      alignedPct: 100,
      confirmed: 0,
      corrected: 0,
      flagged: 0,
      unresolved: 0,
      lumped: 0,
      escalated: 0,
      escalationAccepted: 0,
      flagOnly: false,
      ...overrides,
    };
  }

  it('returns undefined for an empty list (engine off / every chapter served from cache)', () => {
    expect(aggregateStructureReports([])).toBeUndefined();
  });

  it('sums confirmed/corrected/flagged/escalated/escalationAccepted across chapters', () => {
    const result = aggregateStructureReports([
      makeReport({ confirmed: 2, corrected: 1, flagged: 0, escalated: 0, escalationAccepted: 0 }),
      makeReport({ confirmed: 1, corrected: 0, flagged: 1, escalated: 1, escalationAccepted: 1 }),
    ]);
    expect(result).toEqual({
      alignedPct: 100,
      confirmed: 3,
      corrected: 1,
      flagged: 1,
      unresolved: 0,
      escalated: 1,
      escalationAccepted: 1,
    });
  });

  it('weights alignedPct by each chapter\'s sentence count (confirmed+corrected+flagged+lumped), not a flat average', () => {
    /* Chapter A: 1 sentence at 0% aligned. Chapter B: 9 sentences at 100%
       aligned. A flat average would read 50%; the sentence-count-weighted
       mean reads 90% — the honest picture given B did 9x A's work. */
    const chapterA = makeReport({ alignedPct: 0, flagged: 1 });
    const chapterB = makeReport({ alignedPct: 100, confirmed: 9 });
    const result = aggregateStructureReports([chapterA, chapterB]);
    expect(result?.alignedPct).toBe(90);
  });

  it('omits alignedPct (rather than reporting 0) when every chapter classified zero sentences', () => {
    // confirmed/corrected/flagged/lumped all 0 -> totalWeight is 0. A 0%
    // here would misrepresent "nothing was classified" as "0% aligned".
    const emptyChapter = makeReport({ alignedPct: 0 });
    const result = aggregateStructureReports([emptyChapter]);
    expect(result?.alignedPct).toBeUndefined();
    expect(result).toEqual({
      confirmed: 0,
      corrected: 0,
      flagged: 0,
      unresolved: 0,
      escalated: 0,
      escalationAccepted: 0,
    });
  });

  it('#2253 — sums unresolved and counts it toward the alignedPct weight', () => {
    // Chapter A: 100 classified sentences, 90 of them unresolved, 100% aligned.
    // Chapter B: 10 classified sentences, all confirmed, 0% aligned.
    // If `unresolved` is left out of the weight, A weighs 10 instead of 100 and
    // the book reads ~9% aligned instead of ~91% — an inverted headline number.
    const chapterA = makeReport({ alignedPct: 100, confirmed: 10, unresolved: 90 });
    const chapterB = makeReport({ alignedPct: 0, confirmed: 10, flagOnly: true });
    const result = aggregateStructureReports([chapterA, chapterB]);
    expect(result?.unresolved).toBe(90);
    expect(result?.alignedPct).toBeCloseTo((100 * 100 + 0 * 10) / 110, 5);
  });
});

describe('aggregateMaxMergedTurns (#2267 — cross-chapter fold)', () => {
  it('reports the MAXIMUM across chapters, never the sum', () => {
    // A book whose chapters yield 3 and 11 reports 11, not 14 (Global
    // Constraint: Math.max over paragraphs/chapters, never a sum).
    expect(aggregateMaxMergedTurns([3, 11])).toBe(11);
  });

  it('is order-independent', () => {
    expect(aggregateMaxMergedTurns([11, 3])).toBe(11);
  });

  it('skips a chapter that contributed undefined rather than treating it as 0', () => {
    expect(aggregateMaxMergedTurns([undefined, 5])).toBe(5);
  });

  it('returns undefined when no chapter in this pass contributed a reading', () => {
    expect(aggregateMaxMergedTurns([])).toBeUndefined();
    expect(aggregateMaxMergedTurns([undefined, undefined])).toBeUndefined();
  });
});

describe('runMainAnalyzerJob / runSubsetAnalyzerJob — analysisProvenance persistence (srv-59 Task 11)', () => {
  /* English tag-anchored dialogue fixture (mirrors the proven shape in
     parser.test.ts's "en quotes" case: “…,” Name verb.). Paragraph 1 is a
     tag-anchored speech span (tag-name -> anton). Paragraph 2 is pure
     narration (no quotes at all). The mock Phase-1 analyzer misattributes
     the speech line to 'olga' (proven wrong by the "Anton asked" tag) and
     correctly calls the narration line 'narrator' — same fixture shape
     analysis.structure-engine.test.ts already exercises for 'ru', here in
     'en' (the language `resolveBookLanguageForManuscript` actually resolves
     to for a manuscript with no matching on-disk book — see that function's
     'en' fallback). Both test chapters reuse this exact body so each
     produces an identical per-chapter EngineReport, making the aggregated
     total (2x every counter) trivial to assert without re-deriving the
     dialogue-structure engine's own arithmetic. */
  const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';

  function stage1Roster(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'anton',
        name: 'Anton',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Anton asked' }],
      },
      {
        id: 'olga',
        name: 'Olga',
        role: 'lead',
        color: '#222222',
        gender: 'female',
        evidence: [{ quote: 'Olga nodded' }],
      },
    ];
  }

  function mockAttributionSentences(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'olga', // wrong — the tag proves 'anton'
        confidence: 0.42,
        text: 'Are you sure this will work',
      },
      {
        id: chapterId * 100 + 2,
        chapterId,
        characterId: 'narrator',
        confidence: 0.33,
        text: 'Olga nodded and looked away',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentences(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-provenance-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(
    bookDir: string,
    manuscriptId: string,
    extra: Record<string, unknown> = {},
  ): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_provenance_test',
        manuscriptId,
        title: 'Provenance Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...extra,
      }),
    );
  }

  function buildStubChapters(): ChapterHint[] {
    return [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
    ];
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints = buildStubChapters();
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Provenance Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  function readState(bookDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
  }

  function readCast(bookDir: string): {
    characters: Array<{ id: string; name: string; aliases?: string[]; voiceStyle?: string }>;
  } {
    return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
  }

  const EXPECTED_REPORT = {
    alignedPct: 100,
    confirmed: 2,
    corrected: 2,
    flagged: 0,
    unresolved: 0,
    escalated: 0,
    escalationAccepted: 0,
  };

  it(
    'main route: writes analysisProvenance with the aggregated structure-engine report after a full run',
    async () => {
      const manuscriptId = `test-provenance-main-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const stateAfter = readState(bookDir);
        const provenance = stateAfter.analysisProvenance as {
          engine: string;
          model: string;
          at: string;
          structureEngineVersion: number;
          report?: unknown;
          scope?: string;
          chaptersCovered?: number;
        };
        expect(provenance).toBeDefined();
        expect(provenance.engine).toBe('gemini');
        expect(provenance.model).toBe('phase1-model');
        expect(provenance.structureEngineVersion).toBe(1);
        expect(typeof provenance.at).toBe('string');
        expect(new Date(provenance.at).toString()).not.toBe('Invalid Date');
        expect(provenance.report).toEqual(EXPECTED_REPORT);
        // srv-59 Task 11 (review follow-up) — the main whole-book route
        // marks its own report distinctly from a subset retry's.
        expect(provenance.scope).toBe('book');
        expect(provenance.chaptersCovered).toBe(2);
        // Narrator identity is seeded into the persisted cast (both jobs). The
        // raw stage1Roster narrator has no aliases/voiceStyle, so their presence
        // proves applyNarratorIdentity ran on the persist path. Language resolves
        // to 'en' here (tmpdir book), so the name stays the English default;
        // per-language localization is unit-covered in narrator-identity.test.ts.
        const narr = readCast(bookDir).characters.find((c) => c.id === 'narrator')!;
        expect(narr.name).toBe('Narrator');
        expect(narr.aliases).toContain('Narrator');
        expect(narr.voiceStyle).toContain('folkloric warmth');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    '#2267 spec §4 — main route STILL persists maxMergedTurnsInParagraph when EVERY chapter is served from ' +
      'cache (the fully-cached-book case: zero fresh EngineReports this pass)',
    async () => {
      /* This is the scenario spec §4 exists to protect: a re-run of an
         already-analysed book where every chapter's sentences come back from
         the stage-2 cache, so attributeChapterStage2 (and therefore
         crossExamine / the EngineReport it produces) never runs at all this
         pass. structureReports stays empty and aggregateStructureReports
         returns undefined either way — the metric under test must not
         vanish along with it, because it needs only chapter text + the
         book's resolved language, neither of which requires the engine to
         have run. `phase1Analyzer.runStage2Chapter` is wired to THROW below
         so this test fails loudly (not silently) if the cache-seeding here
         ever stops actually skipping fresh attribution. */
      const manuscriptId = `test-provenance-cached-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      // Chapter 1's single paragraph has 2 merged turns (mirrors Task 1's
      // legibility.test.ts fixture); chapter 2 is clean narration.
      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: 'Он кивнул. - Привет. - Как дела?' },
        { id: 2, title: 'Chapter Two', body: 'Тихо было.' },
      ];
      seedStateJson(bookDir, manuscriptId, { language: 'ru' });
      // `resolveBookLanguageForManuscript` scans the real BOOKS_ROOT tree, which
      // this tmpdir-based test book is never part of — route it through the
      // `../workspace/scan.js` mock's override hook (see that mock's own
      // comment above) instead, so `bookLanguage` actually resolves to 'ru'.
      (globalThis as Record<string, unknown>).__analysis_test_book_language_override = {
        manuscriptId,
        language: 'ru',
      };
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Provenance Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
      });
      // Pre-seed the Phase-1 attribution cache for BOTH chapters, so the
      // cached-chapter replay loop (analysis.ts, "Replay cached chapters
      // synchronously up front") picks them up and skips
      // attributeChapterStage2WithEval entirely for this run.
      await saveAnalysisCache(manuscriptId, {
        chapters: {
          1: [{ id: 101, chapterId: 1, characterId: 'narrator', confidence: 1, text: 'Он кивнул.' }],
          2: [{ id: 201, chapterId: 2, characterId: 'narrator', confidence: 1, text: 'Тихо было.' }],
        },
      });

      function buildPhase1AnalyzerThatMustNotRun(): Analyzer {
        return {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () =>
            Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
          runStage2Chapter: () =>
            Promise.reject(
              new Error(
                'fully-cached-book test: Phase-1 attribution must NOT run when every chapter is cached',
              ),
            ),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: () => Promise.reject(new Error('not used')),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.reject(new Error('not used')),
        };
      }

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1AnalyzerThatMustNotRun(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // requestedFresh: false — a resumed run, NOT "Start fresh" (which
        // would discard the cache we just seeded and defeat the test).
        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const stateAfter = readState(bookDir);
        // #2275 C3 — maxMergedTurnsInParagraph is a SIBLING of `report`, not
        // nested inside it (report stays absent here: the engine never ran,
        // every chapter was cached).
        const provenance = stateAfter.analysisProvenance as {
          report?: unknown;
          maxMergedTurnsInParagraph?: number;
        };
        expect(provenance.report).toBeUndefined();
        expect(provenance.maxMergedTurnsInParagraph).toBe(2);
      } finally {
        delete (globalThis as Record<string, unknown>).__analysis_test_book_language_override;
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'fresh re-analysis PRESERVES designed voices while dropping reuse continuity (voice-strip incident 2026-07-14)',
    async () => {
      /* Regression: a `fresh: true` re-analysis used to set priorCastForMerge=[]
         and so overwrote cast.json with a voiceless roster, destroying every
         designed Qwen voice (the 2026-07-14 Coalfall incident). "Start fresh"
         legitimately discards reuse continuity (matchedFrom / voiceId / library
         links), but must NEVER discard the user's bespoke designed voices. */
      const manuscriptId = `test-fresh-preserve-voice-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      seedStateJson(bookDir, manuscriptId, { castConfirmed: true });
      // Pre-seed a cast.json where 'narrator' (the character with a stable id
      // across this fixture's fold) carries BOTH a designed Qwen voice (must
      // survive) and a reuse link (must be dropped by a fresh run).
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'narrator',
              name: 'Narrator',
              voiceUuid: 'U-narr',
              ttsEngine: 'qwen',
              overrideTtsVoices: {
                qwen: {
                  name: 'qwen-U-narr',
                  variants: { excited: { name: 'qwen-U-narr__excited' } },
                },
              },
              voiceId: 'some-library-voice',
              voiceState: 'reused',
              matchedFrom: { bookId: 'prior', characterId: 'narrator', confidence: 0.9 },
            },
          ],
        }),
      );
      registerManuscript(manuscriptId, bookDir);

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      setPhase1Selection(buildSelection(buildPhase1Analyzer(), 'phase1-model'));

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const narr = readCast(bookDir).characters.find((c) => c.id === 'narrator') as
          | (Record<string, unknown> & { id: string })
          | undefined;
        expect(narr).toBeDefined();
        // Designed voice SURVIVES the fresh run.
        expect(narr!.overrideTtsVoices).toEqual({
          qwen: {
            name: 'qwen-U-narr',
            variants: { excited: { name: 'qwen-U-narr__excited' } },
          },
        });
        expect(narr!.voiceUuid).toBe('U-narr');
        expect(narr!.ttsEngine).toBe('qwen');
        // Reuse continuity is DROPPED by the fresh run.
        expect(narr!.matchedFrom).toBeUndefined();
        expect(narr!.voiceId).toBeUndefined();
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "subset retry route: REWRITES analysisProvenance with a fresh `at` + recomputed report, superseding the prior run's",
    async () => {
      const manuscriptId = `test-provenance-subset-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      const staleAt = '2020-01-01T00:00:00.000Z';
      seedStateJson(bookDir, manuscriptId, {
        analysisProvenance: {
          engine: 'local',
          model: 'stale-model',
          at: staleAt,
          structureEngineVersion: 1,
          report: {
            alignedPct: 50,
            confirmed: 1,
            corrected: 0,
            flagged: 1,
            escalated: 0,
            escalationAccepted: 0,
          },
        },
      });
      const chapterHints = registerManuscript(manuscriptId, bookDir);

      /* Pre-seed cache.stage1 so the subset route takes the "book already
         fully analysed" branch (stage1Existed === true) instead of the
         cast-detection-retry branch that defers Phase 1 to the main route
         (see the comment on `stage1Existed` in runSubsetAnalyzerJob). */
      const stage1: Stage1Output = {
        characters: stage1Roster(),
        chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
      };
      await saveAnalysisCache(manuscriptId, { chapters: {}, stage1 });

      const selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'subset',
        subsetChapterIds: chapterHints.map((c) => c.id),
        bookDir,
        engine: selection.engine,
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          selection,
          phase1Selection,
          recordRef.chapterHints,
          false,
        );

        const stateAfter = readState(bookDir);
        const provenance = stateAfter.analysisProvenance as {
          engine: string;
          model: string;
          at: string;
          structureEngineVersion: number;
          report?: unknown;
          scope?: string;
          chaptersCovered?: number;
        };
        expect(provenance).toBeDefined();
        expect(provenance.at).not.toBe(staleAt);
        expect(new Date(provenance.at).toString()).not.toBe('Invalid Date');
        expect(provenance.model).toBe('phase1-model-subset');
        expect(provenance.report).toEqual(EXPECTED_REPORT);
        // srv-59 Task 11 (review follow-up) — a subset (chapter-retry) run
        // marks its report distinctly from a whole-book one, since it only
        // covers the retried chapters (here: both, so scope alone is the
        // distinguishing assertion vs. the main-route test above).
        expect(provenance.scope).toBe('subset');
        expect(provenance.chaptersCovered).toBe(2);
        // Narrator identity is seeded into the persisted cast (both jobs). The
        // raw stage1Roster narrator has no aliases/voiceStyle, so their presence
        // proves applyNarratorIdentity ran on the persist path. Language resolves
        // to 'en' here (tmpdir book), so the name stays the English default;
        // per-language localization is unit-covered in narrator-identity.test.ts.
        const narr = readCast(bookDir).characters.find((c) => c.id === 'narrator')!;
        expect(narr.name).toBe('Narrator');
        expect(narr.aliases).toContain('Narrator');
        expect(narr.voiceStyle).toContain('folkloric warmth');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    'C2 — subset route computes maxMergedTurnsInParagraph over every non-excluded chapter, ' +
      "not just the chapters this pass re-attributes (`toRun`)",
    async () => {
      /* Regression for #2275 C2: re-analysing a single CLEAN chapter used to
         recompute the book-level max over `toRun` alone, so a subset retry
         that only touches a clean chapter silently overwrote a HIGH reading
         left by every OTHER chapter with that chapter's own low reading.
         Chapter 1 here is a 21-turn merged paragraph (reads 20 — the exact
         fixture from legibility.test.ts's C1 case) and is deliberately left
         OUT of `toRun`; only chapter 2 (a single clean narration sentence,
         reads 0) is retried. The persisted book-level reading must still be
         20 — it must come from `record.chapterHints`, not `toRun`. */
      const manuscriptId = `test-provenance-subset-scope-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      const mergedTurns = Array.from({ length: 21 }, (_, i) => `Реплика ${i}`);
      const chapter1Body = mergedTurns.join('. - ') + '.';
      const chapter2Body = 'Тихо было.';

      seedStateJson(bookDir, manuscriptId, { language: 'ru' });
      (globalThis as Record<string, unknown>).__analysis_test_book_language_override = {
        manuscriptId,
        language: 'ru',
      };

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: chapter1Body },
        { id: 2, title: 'Chapter Two', body: chapter2Body },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Provenance Subset-Scope Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
      });

      const stage1: Stage1Output = {
        characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }],
        chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
      };
      const narratorCast: CharacterOutput[] = [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      ];
      // isPhase0aCoverageComplete requires a non-empty chapterCast entry for
      // EVERY non-excluded chapter (including chapter 1, which this test
      // never re-runs Phase 0a for) or the subset job defers cast
      // finalisation and returns before ever reaching Phase 1 / persist.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1,
        chapterCast: { 1: narratorCast, 2: narratorCast },
      });

      function buildSubsetOnlyPhase1Analyzer(): Analyzer {
        return {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () =>
            Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
          async runStage2Chapter(): Promise<Stage2ChapterOutput> {
            return {
              sentences: [
                { id: 201, chapterId: 2, characterId: 'narrator', confidence: 1, text: 'Тихо было' },
              ],
            };
          },
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: () => Promise.reject(new Error('not used')),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.reject(new Error('not used')),
        };
      }

      const selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset-scope');
      const phase1Selection = buildSelection(
        buildSubsetOnlyPhase1Analyzer(),
        'phase1-model-subset-scope',
      );

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'subset',
        subsetChapterIds: [2],
        bookDir,
        engine: selection.engine,
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // toRun = ONLY chapter 2 — chapter 1 (the merged mega-paragraph) is
        // never re-attributed this pass.
        const toRun = recordRef.chapterHints.filter((c) => c.id === 2);

        await runSubsetAnalyzerJob(job, recordRef as never, selection, phase1Selection, toRun, false);

        const stateAfter = readState(bookDir);
        // #2275 C3 — maxMergedTurnsInParagraph is a SIBLING of `report`, not
        // nested inside it.
        const provenance = stateAfter.analysisProvenance as {
          maxMergedTurnsInParagraph?: number;
        };
        expect(provenance.maxMergedTurnsInParagraph).toBe(20);
      } finally {
        delete (globalThis as Record<string, unknown>).__analysis_test_book_language_override;
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

/* C4 on-box acceptance row (#2325/#2342) asks an operator to "record the
   actual percentages" on a healthy dash-convention book, and to observe "the
   source's dash-opening count and the attributed speech-half count... for at
   least one chapter". Neither was ever emitted anywhere except inside the
   `dialogueCollapse`/`markersLost` ISSUE STRINGS, which the job only logs on
   `!coverage.ok` — so the row's own healthy-book case (the one it's chiefly
   about) would discharge on a NULL observation. This pins the fix: a
   `narrated-speech check` log line fires for EVERY chapter whose language has
   a dialogue marker, on a PASSING chapter same as a failing one. */
describe('runMainAnalyzerJob — narrated-speech check log line (#2325/#2342 C4 observability)', () => {
  const SPEECH_HALVES_TOTAL = 22; // > STAGE2_MIN_SPEECH_HALVES (20)
  const NARRATED_COUNT = 6; // 6/22 ≈ 27.3%, well under the 60% collapse threshold
  const CHAPTER_BODY = Array.from(
    { length: SPEECH_HALVES_TOTAL },
    (_, i) => `- Реплика номер ${i} для проверки.`,
  ).join('\n');

  function stage1Roster(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'anton',
        name: 'Anton',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Реплика' }],
      },
    ];
  }

  function mockAttributionSentences(chapterId: number): SentenceOutput[] {
    return Array.from({ length: SPEECH_HALVES_TOTAL }, (_, i) => ({
      id: chapterId * 100 + i + 1,
      chapterId,
      characterId: i < NARRATED_COUNT ? 'narrator' : 'anton',
      confidence: 0.9,
      text: `- Реплика номер ${i} для проверки.`,
    }));
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentences(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-narrated-speech-log-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_narrated_speech_log_test',
        manuscriptId,
        title: 'Narrated Speech Log Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        language: 'ru',
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  it(
    'logs the narrated-speech measurement for a PASSING chapter, not only a failing one',
    async () => {
      const manuscriptId = `test-narrated-speech-log-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      // The synthetic repeated dash-lines are ambiguous enough to flag windows
      // in the deterministic structure engine, which would then escalate —
      // irrelevant to what this test pins (the coverage-guard log line), and
      // the mock analyzer's `runAttributionEscalation` deliberately throws to
      // catch an unexpected call. Off for this test only.
      const originalEscalation = process.env.ATTRIBUTION_ESCALATION;
      process.env.ATTRIBUTION_ESCALATION = 'off';
      seedStateJson(bookDir, manuscriptId);
      // `resolveBookLanguageForManuscript` scans the real BOOKS_ROOT tree, which
      // this tmpdir-based test book is never part of — route it through the
      // `../workspace/scan.js` mock's override hook instead (same pattern as
      // the #2267 cached-chapter provenance test above).
      (globalThis as Record<string, unknown>).__analysis_test_book_language_override = {
        manuscriptId,
        language: 'ru',
      };
      const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Narrated Speech Log Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: CHAPTER_BODY,
        chapterHints,
        bookDir,
      });

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        
        const narratedSpeechLog = job.replay.logs.find((l) => l.message.includes('narrated-speech check'));
        expect(narratedSpeechLog, 'no narrated-speech check log line was emitted at all').toBeDefined();
        // The measurement, not merely the fact that SOMETHING logged:
        // 6/22 narrated, the pct, AND the source's own dash-opening count.
        expect(narratedSpeechLog!.message).toContain('6/22');
        expect(narratedSpeechLog!.message).toContain('27.3%');
        expect(narratedSpeechLog!.message).toContain('source has 22 dash-opening speech lines');
        // This chapter is a PASSING one — no `attribution-collapse` failure —
        // proving the line isn't gated on `!coverage.ok`.
        expect(job.replay.failedByChapterId.size).toBe(0);
      } finally {
        delete (globalThis as Record<string, unknown>).__analysis_test_book_language_override;
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        if (originalEscalation === undefined) delete process.env.ATTRIBUTION_ESCALATION;
        else process.env.ATTRIBUTION_ESCALATION = originalEscalation;
      }
    },
    60_000,
  );
});

/* #2342 review round 3 item 4 — the subset (Retry) job's stage-2 loop used to
   discard `coverage` entirely: `clearFailedChapterId` fires unconditionally
   once Phase 0 (cast detection) succeeds for a chapter, BEFORE Phase 1
   attribution even runs, so a chapter whose Phase 1 attribution collapses
   AGAIN on this very retry came back looking "resolved" with nothing
   re-flagging it. That is exactly the promise the `attribution-collapse`
   remediation copy makes when it tells the user to press Retry — this round
   is what makes it a promise the job can break. */
describe('runSubsetAnalyzerJob — re-reports a coverage failure instead of silently clearing it (#2342 round 3 item 4)', () => {
  const GOOD_CHAPTER_BODY = 'This is a perfectly ordinary paragraph of narration with no dialogue at all.';

  function stage1Roster(): CharacterOutput[] {
    return [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  /* The retry that STILL collapses — the exact shape item 4 is about. An
     EMPTY sentence list is the simplest reliable trigger for `noSentences`
     (→ `attribution-incomplete`), independent of any language's dialogue
     marker, so this test pins the general coverage re-report, not the
     RU-specific narrated-speech path (that path is covered separately by
     the C4 log-line describe block above). */
  function buildPhase1AnalyzerThatStillFails(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(): Promise<Stage2ChapterOutput> {
        return { sentences: [] };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-subset-coverage-reflag-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_subset_coverage_reflag_test',
        manuscriptId,
        title: 'Subset Coverage Reflag Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  it(
    'a chapter that STILL collapses on retry is re-flagged in failedChapterIds and chapter-failed, not silently cleared',
    async () => {
      const manuscriptId = `test-subset-coverage-reflag-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: GOOD_CHAPTER_BODY }];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Subset Coverage Reflag Test Book',
        wordCount: 20,
        byteSize: 200,
        uploadedAt: new Date().toISOString(),
        sourceText: GOOD_CHAPTER_BODY,
        chapterHints,
        bookDir,
      });

      /* Pre-seed cache.stage1 so the subset route takes the "book already
         fully analysed" branch (stage1Existed === true), reaching Phase 1
         attribution directly instead of deferring to the main route — same
         setup as the sibling provenance-persistence subset test above.
         Pre-seed `failedChapterIds` too: this chapter is the one the user
         is retrying BECAUSE it previously failed. */
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: { characters: stage1Roster(), chapters: [{ id: 1, title: 'Chapter One' }] },
        failedChapterIds: [1],
      });

      const selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1AnalyzerThatStillFails(), 'phase1-model');

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'subset',
        subsetChapterIds: [1],
        bookDir,
        engine: selection.engine,
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          selection,
          phase1Selection,
          recordRef.chapterHints,
          false,
        );

        // The SSE contract: a live subscriber sees the chapter re-fail.
        expect(job.replay.failedByChapterId.has(1)).toBe(true);
        expect(job.replay.failedByChapterId.get(1)!.code).toBe('attribution-incomplete');
        // The bug this pins: `failedChapterIds` on the PERSISTED cache must
        // still list chapter 1 — the whole defect was that Phase 0's
        // `clearFailedChapterId` call left it looking resolved regardless of
        // what Phase 1 did afterward.
        const persisted = await loadAnalysisCache(manuscriptId);
        expect(persisted.failedChapterIds).toContain(1);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runMainAnalyzerJob — cast id history end-to-end guard (#2040 Task 8)', () => {
  /* This is the test that would have caught all three rounds of "green but
     inert": a unit test on a pure function proves it RETURNS a retirement
     list; it proves nothing about whether that list ever reaches
     cast-id-history.json in production. Here we drive the REAL route
     (runMainAnalyzerJob) against a real bookDir with real file I/O — no
     mocked cast-id-history — pre-seed the history with an entry from an
     EARLIER run, and assert after a full analysis that the pre-existing
     entry survived AND two NEW entries were recorded, one per §4.4 site:

     - Site 1 (`applyRewriteToPriorCast`): the prior cast carries a voiced row
       under id `anton-x`. THIS run's own fresh roster introduces two
       same-name rows across chapters (`anton-x` in chapter 1, `anton-y` in
       chapters 2-3, both "Anton Prime" — mirroring the analyzer's documented
       non-determinism) that `dedupeRosterByName`'s Tier-1 collapses to a
       third canonical id, producing a real `dd.rewrites` hit. Because the
       prior row's id is a REWRITE KEY (not just a same-run collision that
       never touches the prior cast), `applyRewriteToPriorCast` remaps it —
       exercising the same-run-collision path a unit test can't reach without
       synthesising the rewrite table by hand.
     - Site 2 (`dedupePriorCastByName`): the prior cast ALSO carries two rows
       sharing the (unrelated) name "Legacy Duplicate" — collapsed before the
       chapter loop even starts.

     Fold round 1 review finding: the original version of this guard only
     exercised the (correctly non-recording, per item 4) interim-write path —
     it went red for the wrong reason once that path stopped recording.
     Rewritten to pin the sites §4.4 actually lists. Round-1 fix item 5.

     Coverage note: does not cover the subset route or `performCastMerge`
     (call site 5) — those remain unit-pinned above / in cast-merge.test.ts. */
  const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';

  /* Chapter 1 introduces 'anton-x'; chapters 2-3 introduce 'anton-y' — same
     name, different id, exactly the drift dedupeRosterByName's Tier-1
     collapses. mergeRosterChapter merges by id, so both survive as distinct
     rows in the whole-book roster dedupAndPrepare receives. Combined lines
     (1 + 2 = 3) clear foldMinorCast's MIN_LINES_DEFAULT so the merged
     survivor isn't folded into the unknown-male bucket before this reaches
     the merge. */
  function stage1RosterForChapter(chapterId: number): CharacterOutput[] {
    const antonId = chapterId === 1 ? 'anton-x' : 'anton-y';
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: antonId,
        name: 'Anton Prime',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Anton asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    const antonId = chapterId === 1 ? 'anton-x' : 'anton-y';
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: antonId,
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter(chapterId) };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-cast-id-history-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_cast_id_history_e2e_test',
        manuscriptId,
        title: 'Cast Id History E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    // Anton needs >= MIN_LINES_DEFAULT (3) attributed lines or foldMinorCast
    // folds him into the unknown-male bucket before this test's id-drift
    // scenario ever reaches the merge — 3 chapters, 1 anton-fresh line each.
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Cast Id History E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'a full analysis over a book whose history already has an entry: that entry survives AND site-1 + site-2 each record a new one',
    async () => {
      const manuscriptId = `test-cast-id-history-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      /* Pre-existing history entry from an EARLIER run/repair, unrelated to
         anything this run touches. Must still be there after the run. */
      await retireCharacterId(bookDir, 'old-eliza', 'eliza');

      /* Prior cast.json seeds BOTH §4.4 sites this test pins:
         - 'anton-x': voiced, id matches a key THIS run's own fresh-roster
           dedup (dedupeRosterByName Tier-1) will rewrite — site 1
           (applyRewriteToPriorCast). Its NAME ("Anton Legacy Voice")
           deliberately does NOT match the fresh roster's "Anton Prime"
           (round-2 review fix): if it did,
           `mergeAnalysisResultWithExistingCast`'s own same-name fallback
           (§4.4 site 3, merge-analysis-cast.ts:148-186) could independently
           produce an identical `anton-x -> <canonical>` entry even if
           `applyRewriteToPriorCast`'s retirement bookkeeping were broken —
           masking a regression there. Diverging the names means the ONLY
           way this row's id can be overlaid/retired is via the id-space
           rewrite table (`composeRewrites(dd.rewrites, folded.rewrites)`),
           which is exactly what site 1 is.
         - 'dup-a' / 'dup-b': two prior rows sharing an (unrelated) name —
           site 2 (dedupePriorCastByName), collapsed before the chapter loop
           even starts, independent of anything the analyzer detects. This
           half is already exclusive: "Legacy Duplicate" never appears in
           the fresh roster, so nothing else in the final merge can produce
           `dup-b -> dup-a`. */
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'anton-x',
              name: 'Anton Legacy Voice',
              voiceUuid: 'U-anton',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-anton' } },
            },
            {
              id: 'dup-a',
              name: 'Legacy Duplicate',
              voiceState: 'locked',
              voiceUuid: 'U-dup-a',
            },
            {
              id: 'dup-b',
              name: 'Legacy Duplicate',
              voiceState: 'generated',
            },
            // #2110 — 'eliza' must be genuinely LIVE after this run for the
            // 'old-eliza' -> 'eliza' assertion below to prove what it claims
            // (an entry with a live target surviving untouched); voiced so
            // the carry-forward loop rescues her even though the fresh
            // roster never mentions her this run.
            { id: 'eliza', name: 'Eliza', voiceState: 'reused' },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // The fresh roster's Tier-1 name-dedup actually collapsed anton-x/
        // anton-y to a THIRD canonical id (sanity check — if this fails the
        // fixture itself is wrong, not the history wiring).
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const antonPrime = castAfter.characters.find((c) => c.name === 'Anton Prime');
        expect(antonPrime).toBeDefined();
        const antonPrimeId = antonPrime!.id;
        expect(antonPrimeId).not.toBe('anton-x');
        expect(antonPrimeId).not.toBe('anton-y');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('anton-x');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('anton-y');

        const history = await loadCastIdHistory(bookDir);
        // The pre-existing entry from before this run survived the run.
        expect(history.supersededBy).toHaveProperty('old-eliza', 'eliza');
        // Site 1 (applyRewriteToPriorCast): the prior 'anton-x' row's id is a
        // same-run dedup rewrite key, so the prior cast is remapped onto the
        // fresh survivor.
        expect(history.supersededBy).toHaveProperty('anton-x', antonPrimeId);
        // Site 2 (dedupePriorCastByName): the two "Legacy Duplicate" prior
        // rows collapse, keeping the stronger voiceState's own id.
        expect(history.supersededBy).toHaveProperty('dup-b', 'dup-a');
        // NOTE: this fixture's prior 'anton-x' row is deliberately named
        // "Anton Legacy Voice", NOT "Anton Prime" (see the comment above the
        // cast.json seed) — so remapFreshToPriorIds's own name-match never
        // even attempts this pair here, and asserting "Task 10 recorded
        // nothing" against this fixture would be vacuous (confirmed: it
        // still passes with priorIdAfter reverted to the raw pre-composition
        // id — the earlier round-2 bug). The real convergence-skip
        // "recorded nothing" pin lives in the dedicated test below, whose
        // fixture's prior name DOES match the fresh roster's.
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    'a throwing history write never blocks the authoritative cast.json persist (round 1 fix item 1)',
    async () => {
      /* cast-id-history.json's PATH is occupied by a directory, so every
         retireCharacterId() call's writeJsonAtomic (rename onto an existing
         path) throws EPERM/EEXIST-shaped for real — no mocking. Same fixture
         as the sibling test above (guarantees BOTH §4.4 sites this run
         touches actually attempt a write and throw), so the only variable
         is whether that throw reaches the caller. */
      const manuscriptId = `test-cast-id-history-throw-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      mkdirSync(castIdHistoryPath(bookDir), { recursive: true });

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'anton-x',
              name: 'Anton Prime',
              voiceUuid: 'U-anton',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-anton' } },
            },
            { id: 'dup-a', name: 'Legacy Duplicate', voiceState: 'locked', voiceUuid: 'U-dup-a' },
            { id: 'dup-b', name: 'Legacy Duplicate', voiceState: 'generated' },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // Must not reject — a throwing history write is caught and warned,
        // never propagated.
        await expect(
          runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
            requestedFresh: false,
            allowStage1Shrink: true,
            requestedModel: undefined,
          }),
        ).resolves.toBeUndefined();

        // The authoritative cast.json write happened DESPITE every retirement
        // write throwing — this is the actual property under test.
        //
        // NOT a sufficient check on its own: the PER-CHAPTER interim write
        // (buildInterimCast -> previewFoldForLiveView -> dedupeRosterByName)
        // ALSO Tier-1-collapses anton-x/anton-y under a `lines: 0` PLACEHOLDER
        // — so an id-only assertion would pass even if the AUTHORITATIVE
        // final write were skipped entirely by the outer persistErr catch
        // (confirmed by direct experiment: this exact assertion shape passed
        // against the unfixed code, for the wrong reason). The final write is
        // the only one that stamps REAL Phase-1 line counts, so assert on
        // `lines` to actually distinguish "interim placeholder" from
        // "authoritative write completed".
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string; lines?: number }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        expect(idsAfter).not.toContain('anton-x');
        expect(idsAfter).not.toContain('dup-b');
        const antonPrime = castAfter.characters.find((c) => c.name === 'Anton Prime');
        expect(antonPrime).toBeDefined();
        // 1 attributed line per chapter x 3 chapters — real Phase-1 output,
        // not the interim write's `lines: 0` placeholder.
        expect(antonPrime!.lines).toBe(3);

        // The history path is still a directory — the throwing writes never
        // got far enough to corrupt anything there either.
        expect(existsSync(castIdHistoryPath(bookDir))).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    'site 4 (#2040 Task 10 round 3): the convergence-skip records nothing, even though Site 1 records its own entry for the same fresh survivor',
    async () => {
      /* Same roster/attribution shape as the sibling tests above (anton-x
         ch1 / anton-y ch2-3, both "Anton Prime" — Tier-1-deduped to a fresh
         canonical id), but the prior 'anton-x' row's NAME matches "Anton
         Prime" (unlike the FIRST sibling test above, which deliberately
         diverges the name so Site 3/Task 10's name-matcher never even
         attempts the pair) and the history path is a real file, not a
         corrupted directory (unlike the SECOND sibling test, whose every
         write throws and so proves nothing about what got recorded). This
         is the one fixture where remapFreshToPriorIds actually attempts the
         anton-x/CANON pair, finds it already converged via the cumulative
         table Site 1 also consumes, and must record NOTHING for it — a
         spurious entry here would be the same-run-reversal shape
         `retireCharacterId`'s inversion branch (cast-id-history.ts:65-77)
         exists to clean up after, not a case that should arise in the
         first place. */
      const manuscriptId = `test-cast-id-history-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'anton-x',
              name: 'Anton Prime',
              voiceUuid: 'U-anton',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-anton' } },
            },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const antonPrime = castAfter.characters.find((c) => c.name === 'Anton Prime');
        expect(antonPrime).toBeDefined();
        const antonPrimeId = antonPrime!.id;
        // Confirms the remap correctly skipped (converged) rather than
        // reversing the roster back onto the stale prior id.
        expect(antonPrimeId).not.toBe('anton-x');

        const history = await loadCastIdHistory(bookDir);
        // Site 1 still records its own entry for this exact pair.
        expect(history.supersededBy).toHaveProperty('anton-x', antonPrimeId);
        // #2040 Task 14 review item 4: this assertion no longer isolates the
        // "Task 10's remap recorded nothing" claim it was written for —
        // dropSupersededIdsReclaimedByLiveCast (Task 14) now guarantees a
        // LIVE id (antonPrimeId IS the surviving row actually in cast.json)
        // can never remain a history KEY after this write, regardless of
        // whether the remap ever wrote the reversed entry. It would pass
        // even if that bug came back. The real proof the bug isn't back is
        // the sibling assertion one line up (Site 1's forward entry).
        // Left in place (not deleted) as a secondary check.
        expect(history.supersededBy).not.toHaveProperty(antonPrimeId);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runMainAnalyzerJob — #2584/#2570 stripEstablishedAsciiRewrites wiring (PR #2640 pass-3 review, N7)', () => {
  /* N7 — none of the 4 real `stripEstablishedAsciiRewrites` call sites in
     analysis.ts (main route x2, subset route x2) were covered by a test that
     drives the actual route/orchestration code: reverting all 4 sites to
     the bare `composeRewrites(...)` call (no strip) still left the full
     server suite green. This test drives the REAL runMainAnalyzerJob against
     a real bookDir with real file I/O — no mocked dedup/remap — reproducing
     the exact real-box shape (`docs/testing` / PR #2640 review): the
     analyzer's own non-determinism mints THREE fresh candidate rows across
     three chapters for one character ("Одуван" as `oduvan`, `owdovan`,
     `одуван`), which dedupeRosterByName's Tier-1 exact-name pass collapses
     to `одуван` as its own internal survivor — coincidentally colliding with
     the established prior cast row's stable ASCII id `oduvan`. Without the
     strip at both main-route sites (5615 `cumulativeForRemap` / 5804
     `cumulative`), the established `oduvan` row is wrongly retired in favour
     of the non-canonical `одуван` survivor. */
  const CHAPTER_BODY = '“Are you sure this will work,” Одуван asked.\n\nOlga nodded and looked away.';

  // Chapter 1 introduces 'oduvan', chapter 2 'owdovan', chapter 3 'одуван' —
  // all named "Одуван". mergeRosterChapter merges by id, so all three
  // survive as distinct rows in the whole-book roster dedupAndPrepare
  // receives, exactly the same-run duplication dedupeRosterByName's Tier-1
  // collapses onto one of its own choosing.
  function stage1RosterForChapter(chapterId: number): CharacterOutput[] {
    const oduvanId = chapterId === 1 ? 'oduvan' : chapterId === 2 ? 'owdovan' : 'одуван';
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: oduvanId,
        name: 'Одуван',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Одуван asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    const oduvanId = chapterId === 1 ? 'oduvan' : chapterId === 2 ? 'owdovan' : 'одуван';
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: oduvanId,
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter(chapterId) };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-strip-ascii-rewrites-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_strip_ascii_rewrites_e2e_test',
        manuscriptId,
        title: 'Strip Ascii Rewrites E2E Test Book',
        author: 'Test Author',
        language: 'ru',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Strip Ascii Rewrites E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'the established ASCII id survives — the fresh Tier-1 survivor cascades onto it, not the reverse',
    async () => {
      const manuscriptId = `test-strip-ascii-rewrites-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      // Established prior cast row under the STABLE ASCII id, carrying a
      // tuned voice — the identity that must survive this run.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'oduvan',
              name: 'Одуван',
              voiceState: 'tuned',
              voiceUuid: 'U-oduvan',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-oduvan' } },
            },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as {
          characters: Array<{
            id: string;
            name: string;
            voiceState?: string;
            voiceUuid?: string;
            overrideTtsVoices?: unknown;
          }>;
        };

        // Sanity: this run's own fresh-side Tier-1 dedup really did collapse
        // the three-way duplicate onto ITS OWN internal survivor — if this
        // fails the fixture is wrong, not the wiring under test.
        const oduvanRows = castAfter.characters.filter((c) => c.name === 'Одуван');
        expect(oduvanRows).toHaveLength(1);

        // The core N7 assertion: the ESTABLISHED ascii id survived, not the
        // fresh dedup's own non-canonical choice. This is exactly what a
        // revert of either main-route call site (5615/5804) breaks.
        expect(oduvanRows[0].id).toBe('oduvan');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('одуван');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('owdovan');

        // The established voice rode onto the surviving row — proves Site 1
        // never retired 'oduvan' (a retirement would have dropped this row
        // and let the voiceless fresh survivor win instead).
        expect(oduvanRows[0].voiceState).toBe('tuned');
        expect(oduvanRows[0].voiceUuid).toBe('U-oduvan');
        expect(oduvanRows[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-U-oduvan' } });

        // cast-id-history: the fresh survivor 'одуван' was retired ONTO the
        // established id (Task 10 early remap, site 4) — but 'oduvan' itself
        // was never retired (Site 1 must not fire on it, since the strip
        // removed it from the composed rewrite table it consumes).
        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).toHaveProperty('одуван', 'oduvan');
        expect(history.supersededBy).not.toHaveProperty('oduvan');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runMainAnalyzerJob — an interim cast.json write cannot swap a persisted character id (srv-87, #2086)', () => {
  /* Clone of the harness at :3148 — real bookDir, real file I/O, no mocked
     cast-id-history. The three interim writes (`analysis.ts:3630`, `:3840`,
     `:5607`) used to call `mergeAnalysisResultWithExistingCast` and discard
     its `.retirements`. When the id-drift name-fallback fired at one of
     those writes, the prior character's id was durably removed from
     cast.json with no history record — if the run then died before the
     authoritative end-of-run write, the swap was never undone.

     This test drives a real mid-run death: chapter 1's Phase-0 stub returns
     a fresh roster that name-matches the pre-seeded prior cast under a
     DIFFERENT id (the drift), so interim write #1 is where the old fix would
     have swapped the id; chapter 2's stub then throws
     GeminiContentBlockedError, which is whole-book-fatal and rethrown at
     `analysis.ts:3523` — the run terminates after the interim write and
     before the authoritative write at `:4880`. No process kill, no timing
     race, no `phase1DriftExceeded` fixture. */
  const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
        if (chapterId === 2) {
          // Deterministic, whole-book-fatal — rethrown at analysis.ts:3523.
          throw new GeminiContentBlockedError('phase0-model', 'RECITATION');
        }
        // Chapter 1 mints 'anton-y' for the same character the pre-seeded
        // cast.json already has voiced under 'anton-x' — the id-drift the
        // name-fallback matches on.
        return {
          characters: [
            { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
            {
              id: 'anton-y',
              name: 'Anton Prime',
              role: 'lead',
              color: '#111111',
              gender: 'male',
              evidence: [{ quote: 'Anton asked' }],
            },
          ],
        };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    // The run dies inside Phase 0 before Phase 1 is ever dispatched for any
    // chapter (default ANALYZER_PHASE1_MIN_LAG_CHAPTERS=10 parks every
    // Phase 1 chapter on the watermark, which never advances past this
    // 2-chapter book's failure). Still required: `phase1Selection` is
    // resolved up-front in `runMainAnalyzerJob`, before the Phase 0 loop
    // even starts, so an unset selection would hit the real
    // `selectAnalyzerForPhase` and fail before this test's fixture ever runs.
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      runStage2Chapter: () => Promise.reject(new Error('Phase 1 should never dispatch in this test')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-interim-cast-write-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_interim_cast_write_test',
        manuscriptId,
        title: 'Interim Cast Write Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Interim Cast Write Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'a mid-run GeminiContentBlockedError leaves the interim-swapped prior id, its voice, and cast-id-history.json untouched',
    async () => {
      const manuscriptId = `test-interim-cast-write-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      const originalConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      // Deterministic chapter dispatch order: chapter 1 (and its interim
      // write) must fully complete before chapter 2 is even dispatched, or
      // the death could race the interim write that is this test's whole
      // point.
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      // A pre-existing, unrelated history entry — must survive BYTE-IDENTICAL.
      // This is the assertion that catches the refused naive fix: if the
      // interim write's name-fallback match had been recorded, this file
      // would have gained an 'anton-x' key.
      const seededHistory = { schema: 1, supersededBy: { 'alden-old': 'alden' } };
      writeFileSync(castIdHistoryPath(bookDir), JSON.stringify(seededHistory));

      // Prior cast.json: 'anton-x' is voiced ('tuned', with a voiceUuid) —
      // the row an unfixed interim write would durably swap out for the
      // freshly-detected 'anton-y'.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'anton-x',
              name: 'Anton Prime',
              voiceUuid: 'U-anton',
              voiceState: 'tuned',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-anton' } },
            },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // GeminiContentBlockedError is caught by runMainAnalyzerJob's own
        // outer try/catch and reported via an `error` SSE event — it does
        // NOT reject the returned promise.
        await expect(
          runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
            requestedFresh: false,
            allowStage1Shrink: true,
            requestedModel: undefined,
          }),
        ).resolves.toBeUndefined();

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string; voiceUuid?: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);

        // Assertion 1 (RED today — only 'anton-y' is present): the prior
        // voiced row survives the interim write, voice intact.
        const antonX = castAfter.characters.find((c) => c.id === 'anton-x');
        expect(antonX).toBeDefined();
        expect(antonX!.voiceUuid).toBe('U-anton');

        // Assertion 2: the interim write still does its job — the
        // freshly-detected row is there too (mid-run duplicate, by design;
        // see the interim-write comment in analysis.ts).
        expect(idsAfter).toContain('anton-y');

        // Assertion 3: cast-id-history.json is BYTE-IDENTICAL to the seed —
        // no provisional retirement was recorded, and the pre-existing
        // 'alden-old' -> 'alden' entry was not touched. This is the guard
        // that the *naive* "record interim retirements too" fix — refused
        // in the ticket — was not what shipped.
        const historyAfterRaw = readFileSync(castIdHistoryPath(bookDir), 'utf8');
        expect(historyAfterRaw).toBe(JSON.stringify(seededHistory));
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        if (originalConcurrency === undefined) delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
        else process.env.ANALYZER_OLLAMA_CONCURRENCY = originalConcurrency;
      }
    },
    60_000,
  );
});

describe('runMainAnalyzerJob — early remap pass, main path (#2040 Task 10)', () => {
  /* Wiring-level regression for the genuine drift case, distinct from the
     unit suite in remap-fresh-to-prior.test.ts: a re-analysis re-slugs an
     EXISTING, UNAMBIGUOUS character under a fresh id with no same-run dedup
     collision involved at all — this run's own dd.rewrites/folded.rewrites
     table has NO entry for either id, so §11 Q2's convergence-skip must NOT
     fire. Added per the round-2 fix alongside the Task 8 guard test above:
     without this, a change that disabled the remap entirely (e.g. an
     over-eager convergence check that skips unconditionally) would leave the
     Task 8 test green while the actual feature — adopting the prior id at
     all — silently stopped working. */
  // Same dialogue-tag shape as the Task 8 guard fixture above (proven not to
  // trigger the dialogue-structure engine's escalation path) — only the
  // character's name/id changed, to keep this test isolated to the remap.
  const CHAPTER_BODY = '“Are you sure this will work,” Мэйрин asked.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'mayrin',
        name: 'Мэйрин',
        role: 'lead',
        color: '#111111',
        gender: 'female',
        evidence: [{ quote: 'Мэйрин asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'mayrin',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-early-remap-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_early_remap_e2e_test',
        manuscriptId,
        title: 'Early Remap E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Early Remap E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'a fresh id with no same-run dedup collision still adopts the prior cast id by name',
    async () => {
      const manuscriptId = `test-early-remap-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      // Prior cast under a DIFFERENT id but the SAME name as this run's
      // fresh 'mayrin' row — no dedup collision on either side, so
      // dd.rewrites/folded.rewrites carry no entry for either id and §11
      // Q2's convergence-skip must not fire.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [{ id: 'mairin', name: 'Мэйрин', voiceState: 'locked', voiceUuid: 'U-mairin' }],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        // The remap adopted the prior 'mairin' id — the fresh 'mayrin' id
        // never reaches cast.json.
        expect(idsAfter).not.toContain('mayrin');
        expect(idsAfter).toContain('mairin');

        // Roster and sentences moved together (spec §4.4 point 3): the
        // authoritative manuscript-edits.json attributes to 'mairin', not the
        // orphaned pre-remap 'mayrin' — proof reconcileSentenceCharacterIds
        // never saw 'mayrin' as a candidate id and so never demoted these
        // lines to the narrator.
        const editsFile = JSON.parse(
          readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8'),
        ) as { sentences: Array<{ characterId: string }> };
        const editIds = new Set(editsFile.sentences.map((s) => s.characterId));
        expect(editIds.has('mayrin')).toBe(false);
        expect(editIds.has('mairin')).toBe(true);

        // Site 4 (#2040 Task 10 round 3 — spec §4.4 call site 4): the remap
        // itself is a retirement and must reach cast-id-history.json, not
        // just the roster. This fixture has NO same-run dedup collision (a
        // single fresh 'mayrin' row, no name duplicate to collapse) so
        // dd.rewrites/folded.rewrites are empty — cumulative carries no
        // 'mairin' entry, meaning Site 1 (applyRewriteToPriorCast) cannot
        // produce this retirement. And because Task 10's remap already
        // renamed the roster's 'mayrin' row to 'mairin' before Site 3
        // (mergeAnalysisResultWithExistingCast) runs, Site 3's overlay finds
        // an EXACT id match and never reaches its name-fallback branch — the
        // only place it records anything. This entry can only have come from
        // Task 10's own recording.
        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).toHaveProperty('mayrin', 'mairin');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    "the Step-5 fix: a dedup diminutive suggestion survives a same-run remap (pruneSuggestionsToRoster gets characters0, not the remapped roster)",
    async () => {
      /* task-10-brief.md Step 5, never actually pinned until this fix round:
         dd.suggestions carries ids in the PRE-remap space. Fresh roster this
         run: 'Оля' (diminutive, few lines) + 'Ольга' (full name, more lines)
         — dedupeRosterByName's Tier-2b suggests a merge WITHOUT auto-merging
         (proven pairing, same one roster-dedup.test.ts's own Tier-2b test
         uses). The prior cast holds 'Ольга' under a DIFFERENT id
         ('olga-legacy'), so Task 10's remap fires for 'olga' -> 'olga-legacy'
         — the fresh id the suggestion's targetId still points at. Passing
         the REMAPPED roster (`characters`) to pruneSuggestionsToRoster would
         fail `ids.has('olga')` (no such id anymore) and silently drop the
         suggestion; passing characters0 (this fix) keeps it. */
      const SUGGESTION_CHAPTER_BODY =
        '“Are you sure this will work,” Оля asked.\n\n“I am certain of it,” Ольга replied.\n\n“Let us proceed,” Ольга added.';

      function suggestionStage1Roster(): CharacterOutput[] {
        return [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          {
            id: 'olya',
            name: 'Оля',
            role: 'supporting',
            color: '#222222',
            gender: 'female',
            evidence: [{ quote: 'Оля asked' }],
          },
          {
            id: 'olga',
            name: 'Ольга',
            role: 'lead',
            color: '#111111',
            gender: 'female',
            evidence: [{ quote: 'Ольга replied' }],
          },
        ];
      }

      function suggestionSentencesForChapter(chapterId: number): SentenceOutput[] {
        return [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: 'olya',
            confidence: 0.9,
            text: 'Are you sure this will work',
          },
          {
            id: chapterId * 100 + 2,
            chapterId,
            characterId: 'olga',
            confidence: 0.9,
            text: 'I am certain of it',
          },
          {
            id: chapterId * 100 + 3,
            chapterId,
            characterId: 'olga',
            confidence: 0.9,
            text: 'Let us proceed',
          },
        ];
      }

      const suggestionPhase0Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        async runStage1Chapter(): Promise<Stage1ChapterOutput> {
          return { characters: suggestionStage1Roster() };
        },
        runStage2Chapter: () =>
          Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () => Promise.reject(new Error('not used')),
      };

      const suggestionPhase1Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        runStage1Chapter: () =>
          Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
        async runStage2Chapter(
          _manuscriptId: string,
          chapterId: number,
          _prompt: string,
          _call: StageCall,
        ): Promise<Stage2ChapterOutput> {
          return { sentences: suggestionSentencesForChapter(chapterId) };
        },
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () =>
          Promise.reject(new Error('no flagged windows — escalation should never be called')),
      };

      const manuscriptId = `test-early-remap-suggestions-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: SUGGESTION_CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: SUGGESTION_CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: SUGGESTION_CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Early Remap Suggestions E2E Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
      });

      // Prior cast holds 'Ольга' under a DIFFERENT id than this run mints —
      // the remap target. No prior entry for 'Оля', so only 'olga' moves.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            { id: 'olga-legacy', name: 'Ольга', voiceState: 'locked', voiceUuid: 'U-olga' },
          ],
        }),
      );

      const phase0Selection = buildSelection(suggestionPhase0Analyzer, 'phase0-model');
      const phase1Selection = buildSelection(suggestionPhase1Analyzer, 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // Sanity check on the fixture itself: the remap actually fired (the
        // roster carries 'olga-legacy', not the fresh 'olga') — otherwise a
        // green suggestions assertion below would prove nothing about the
        // remap/prune interaction this test targets.
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        expect(idsAfter).not.toContain('olga');
        expect(idsAfter).toContain('olga-legacy');

        const suggestionsFile = await loadSuggestions(bookDir);
        expect(suggestionsFile.suggestions.length).toBeGreaterThan(0);
        // The diminutive suggestion references the PRE-remap 'olga' id
        // (dd.suggestions is built before the remap runs) — confirms this
        // survived because pruneSuggestionsToRoster was checked against
        // characters0, not because some unrelated suggestion snuck through.
        expect(
          suggestionsFile.suggestions.some((s) => s.sourceId === 'olga' || s.targetId === 'olga'),
        ).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runMainAnalyzerJob — a re-minted live id drops its history entry (#2040 Task 14, spec §4.4 closing paragraph)', () => {
  /* The real case §4.4 describes: cast-id-history.json carries a legacy
     entry 'unknown-male' -> 'timkin' from an earlier run/repair (the analyzer
     once folded Timkin's lines into the generic background bucket, then a
     later pass figured out who it actually was and retired the bucket id in
     Timkin's favour). Resolution is exact-id-first (§4.3), so any segment
     still carrying characterId 'unknown-male' would silently reroute to
     whatever THIS run's fresh roster mints under that same id — UNLESS the
     stale entry is dropped, which is what dropSupersededIdsReclaimedByLiveCast
     (cast-id-history.ts) exists to do.

     This test drives the REAL route (runMainAnalyzerJob) with a fresh roster
     that mints a live 'unknown-male' row (no fold needed — foldMinorCast
     skips its own fold logic entirely for a character whose id is ALREADY
     one of its two bucket ids, so a directly-authored stage-1 row of that id
     survives to the merge unchanged). A second, unrelated legacy entry
     ('old-eliza' -> 'eliza') proves the drop is scoped to the reclaimed key,
     not a wholesale history wipe.

     Dialogue-tag shape: same proven-not-to-escalate prose as the Task 8/
     Task 10 fixtures above ("Anton asked") — a pronoun tag ("he muttered")
     was tried first and triggered the dialogue-structure engine's escalation
     path (no named speaker to cross-examine against), which this fixture's
     mocked analyzer doesn't implement. The character is a live 'unknown-male'
     row named "Anton" at Stage 1; foldMinorCast's bucket-id invariant then
     canonicalises the NAME to "Unknown male" while leaving the id untouched
     (see the "Invariant (plan 122)" comment in fold-minor-cast.ts) — this
     test only asserts on the id, so that's inert here.

     #2110 — 'eliza' is given real dialogue (3+ lines, `foldMinorCast`'s
     `MIN_LINES_DEFAULT`) so she survives THIS run's own fresh roster under
     her own id, making her a genuinely LIVE target — needed so the
     'old-eliza' -> 'eliza' assertion below still proves what it claims (an
     entry with a live target surviving untouched) now that the dangling-
     TARGET prune (#2110) runs at the same write as the reclaim drop this
     test pins. Kept out of a prior-cast.json on purpose (this fixture is
     deliberately prior-cast-less, below) — she is simply part of this run's
     own detected cast, same as Anton. */
  const CHAPTER_BODY =
    '“Are you sure this will work,” Anton asked.\n\n“Yes,” Eliza said.\n\n“Let us go,” Eliza added.\n\n“Agreed,” Eliza replied.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'unknown-male',
        name: 'Anton',
        role: 'background',
        color: 'narrator',
        gender: 'male',
        evidence: [{ quote: 'Anton asked' }],
      },
      {
        id: 'eliza',
        name: 'Eliza',
        role: 'lead',
        color: '#333333',
        gender: 'female',
        evidence: [{ quote: 'Eliza said' }, { quote: 'Eliza added' }, { quote: 'Eliza replied' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'unknown-male',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
      {
        id: chapterId * 100 + 2,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Yes',
      },
      {
        id: chapterId * 100 + 3,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Let us go',
      },
      {
        id: chapterId * 100 + 4,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Agreed',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-reclaimed-id-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_reclaimed_id_e2e_test',
        manuscriptId,
        title: 'Reclaimed Id E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Reclaimed Id E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'a fresh roster reintroducing a live "unknown-male" row drops the stale entry keyed to it, and an unrelated entry survives',
    async () => {
      const manuscriptId = `test-reclaimed-id-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      // Legacy entry this run's fresh 'unknown-male' row must displace —
      // written by a real retireCharacterId call (an earlier run/repair
      // once folded these lines into the generic bucket, then figured out
      // they belonged to 'timkin' and retired the bucket id in his favour).
      await retireCharacterId(bookDir, 'unknown-male', 'timkin');
      // Unrelated legacy entry from a different repair — must survive
      // untouched; nothing in this run's roster reclaims 'old-eliza'.
      await retireCharacterId(bookDir, 'old-eliza', 'eliza');

      // No prior cast.json — readPriorCastForMerge returns no rows for a
      // missing file, keeping this fixture isolated to the reclaim scenario
      // (no dedup/remap machinery needs to fire for a single fresh row with
      // no same-name prior).
      expect(existsSync(castJsonPath(bookDir))).toBe(false);

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // Sanity check on the fixture: 'unknown-male' actually landed in
        // cast.json as a LIVE row (if this fails, the scenario never fired
        // and the assertions below would be vacuous).
        const castAfter = JSON.parse(
          readFileSync(castJsonPath(bookDir), 'utf8'),
        ) as { characters: Array<{ id: string }> };
        expect(castAfter.characters.map((c) => c.id)).toContain('unknown-male');

        const history = await loadCastIdHistory(bookDir);
        // The reclaimed entry is gone — it no longer protects anything now
        // that 'unknown-male' resolves straight to the live row (tier 1,
        // §4.3), so leaving it in place would just be misleading.
        expect(history.supersededBy).not.toHaveProperty('unknown-male');
        // The unrelated entry is untouched — this is a scoped drop, not a
        // wholesale history wipe.
        expect(history.supersededBy).toHaveProperty('old-eliza', 'eliza');
        // #2040 Task 14 review item 2b — the pair isn't discarded, it's
        // moved to `displaced` so Wave 3 has something to read.
        expect(history.displaced).toEqual({ 'unknown-male': 'timkin' });
        // #2040 Task 14 review item 2a — an operator-visible log line names
        // the dropped pair, mirroring the sibling dedup-collapse log.
        expect(
          job.replay.logs.some(
            (l) => l.message.includes('Dropped 1 history alias') && l.message.includes('unknown-male -> timkin'),
          ),
        ).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runSubsetAnalyzerJob — early remap pass, subset path (#2040 Task 11)', () => {
  /* Mirrors "runMainAnalyzerJob — early remap pass, main path (#2040 Task 10)"
     above, driving runSubsetAnalyzerJob instead — the SAME helper wired into
     the second (subset/chapter-retry) call site per spec §4.4's five-entry
     list. cache.stage1 is pre-seeded so the subset route takes the "book
     already fully analysed" branch (stage1Existed === true) and actually
     reaches Phase 1 / the persist block where the remap lives — otherwise it
     ends after cast-update and none of this ever runs. */
  const CHAPTER_BODY = '“Are you sure this will work,” Мэйрин asked.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'mayrin',
        name: 'Мэйрин',
        role: 'lead',
        color: '#111111',
        gender: 'female',
        evidence: [{ quote: 'Мэйрин asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'mayrin',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-subset-early-remap-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_subset_early_remap_e2e_test',
        manuscriptId,
        title: 'Subset Early Remap E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Subset Early Remap E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  function makeSubsetJob(manuscriptId: string, bookDir: string, chapterIds: number[]): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'subset',
      subsetChapterIds: chapterIds,
      bookDir,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it(
    'a fresh id with no same-run dedup collision still adopts the prior cast id by name (mirrors Task 10 main-path test)',
    async () => {
      const manuscriptId = `test-subset-early-remap-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      const chapterHints = registerManuscript(manuscriptId, bookDir);

      // Prior cast under a DIFFERENT id but the SAME name as this run's fresh
      // 'mayrin' row — no dedup collision on either side (a single fresh
      // roster row merged by id across all 3 chapters, not a name
      // collision), so dd.rewrites/folded.rewrites carry no entry for either
      // id and §11 Q2's convergence-skip must not fire.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [{ id: 'mairin', name: 'Мэйрин', voiceState: 'locked', voiceUuid: 'U-mairin' }],
        }),
      );

      // stage1Existed === true so Phase 1 (and the persist block the remap
      // lives in) actually runs this pass.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: stage1RosterForChapter(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        // The remap adopted the prior 'mairin' id — the fresh 'mayrin' id
        // never reaches cast.json. Not explainable by Site 3
        // (mergeAnalysisResultWithExistingCast's name-fallback) alone: that
        // mechanism keeps the FRESH row's OWN id and only carries the
        // prior's voice FIELDS onto it, so absent this task's remap
        // 'mayrin' would still be the id in idsAfter.
        expect(idsAfter).not.toContain('mayrin');
        expect(idsAfter).toContain('mairin');

        // Roster and sentences moved together (spec §4.4 point 3): the
        // authoritative manuscript-edits.json attributes to 'mairin', not
        // the orphaned pre-remap 'mayrin'.
        const editsFile = JSON.parse(
          readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8'),
        ) as { sentences: Array<{ characterId: string }> };
        const editIds = new Set(editsFile.sentences.map((s) => s.characterId));
        expect(editIds.has('mayrin')).toBe(false);
        expect(editIds.has('mairin')).toBe(true);

        // §4.4 call site 4: the remap itself is a retirement and must reach
        // cast-id-history.json. No same-run dedup collision in this fixture
        // (dd.rewrites/folded.rewrites empty), so Site 1
        // (applyRewriteToPriorCast) cannot produce this entry; and because
        // the remap already renamed the roster's 'mayrin' row to 'mairin'
        // before Site 3 (mergeAnalysisResultWithExistingCast) runs, Site 3's
        // overlay finds an EXACT id match and never reaches its
        // name-fallback branch. This entry can only have come from this
        // task's own recording.
        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).toHaveProperty('mayrin', 'mairin');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    'the Step-5 fix on the subset path: a dedup diminutive suggestion survives a same-run remap (pruneSuggestionsToRoster gets the pre-remap roster, not the remapped one)',
    async () => {
      /* Same fixture shape as the main-path Step-5 test: fresh roster this
         run has 'Оля' (diminutive, few lines) + 'Ольга' (full name, more
         lines) — dedupeRosterByName's Tier-2b suggests a merge WITHOUT
         auto-merging. The prior cast holds 'Ольга' under a DIFFERENT id
         ('olga-legacy'), so the remap fires for 'olga' -> 'olga-legacy' — the
         fresh id the suggestion's targetId/sourceId still points at. Passing
         the REMAPPED roster to pruneSuggestionsToRoster would fail
         `ids.has('olga')` and silently drop the suggestion; passing the
         pre-remap roster (this fix) keeps it. */
      const SUGGESTION_CHAPTER_BODY =
        '“Are you sure this will work,” Оля asked.\n\n“I am certain of it,” Ольга replied.\n\n“Let us proceed,” Ольга added.';

      function suggestionStage1Roster(): CharacterOutput[] {
        return [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          {
            id: 'olya',
            name: 'Оля',
            role: 'supporting',
            color: '#222222',
            gender: 'female',
            evidence: [{ quote: 'Оля asked' }],
          },
          {
            id: 'olga',
            name: 'Ольга',
            role: 'lead',
            color: '#111111',
            gender: 'female',
            evidence: [{ quote: 'Ольга replied' }],
          },
        ];
      }

      function suggestionSentencesForChapter(chapterId: number): SentenceOutput[] {
        return [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: 'olya',
            confidence: 0.9,
            text: 'Are you sure this will work',
          },
          {
            id: chapterId * 100 + 2,
            chapterId,
            characterId: 'olga',
            confidence: 0.9,
            text: 'I am certain of it',
          },
          {
            id: chapterId * 100 + 3,
            chapterId,
            characterId: 'olga',
            confidence: 0.9,
            text: 'Let us proceed',
          },
        ];
      }

      const suggestionPhase0Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        async runStage1Chapter(): Promise<Stage1ChapterOutput> {
          return { characters: suggestionStage1Roster() };
        },
        runStage2Chapter: () =>
          Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () => Promise.reject(new Error('not used')),
      };

      const suggestionPhase1Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        runStage1Chapter: () =>
          Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
        async runStage2Chapter(
          _manuscriptId: string,
          chapterId: number,
          _prompt: string,
          _call: StageCall,
        ): Promise<Stage2ChapterOutput> {
          return { sentences: suggestionSentencesForChapter(chapterId) };
        },
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () =>
          Promise.reject(new Error('no flagged windows — escalation should never be called')),
      };

      const manuscriptId = `test-subset-early-remap-suggestions-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: SUGGESTION_CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: SUGGESTION_CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: SUGGESTION_CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Subset Early Remap Suggestions E2E Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
      });

      // Prior cast holds 'Ольга' under a DIFFERENT id than this run mints —
      // the remap target. No prior entry for 'Оля', so only 'olga' moves.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            { id: 'olga-legacy', name: 'Ольга', voiceState: 'locked', voiceUuid: 'U-olga' },
          ],
        }),
      );

      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: suggestionStage1Roster(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(suggestionPhase0Analyzer, 'phase0-model-subset');
      const phase1Selection = buildSelection(suggestionPhase1Analyzer, 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        // Sanity check on the fixture itself: the remap actually fired.
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        expect(idsAfter).not.toContain('olga');
        expect(idsAfter).toContain('olga-legacy');

        const suggestionsFile = await loadSuggestions(bookDir);
        expect(suggestionsFile.suggestions.length).toBeGreaterThan(0);
        // The diminutive suggestion references the PRE-remap 'olga' id
        // (dd.suggestions is built before the remap runs) — confirms this
        // survived because pruneSuggestionsToRoster was checked against the
        // pre-remap roster, not because some unrelated suggestion snuck
        // through.
        expect(
          suggestionsFile.suggestions.some((s) => s.sourceId === 'olga' || s.targetId === 'olga'),
        ).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  it(
    "site 4 convergence-skip on the subset path: no spurious retirement when the prior row already converged via this run's own dedup (mirrors the Task 8 / Task-10-round-3 guard)",
    async () => {
      /* Same roster/attribution shape as the main-path Task 8 guard fixture:
         chapter 1 introduces 'anton-x', chapters 2-3 introduce 'anton-y' —
         same name "Anton Prime", different id, which dedupeRosterByName's
         Tier-1 collapses to a third canonical id (dd.rewrites hit). The
         prior 'anton-x' row's NAME matches "Anton Prime" exactly, so
         remapFreshToPriorIds attempts the pair — and because 'anton-x' is
         ALSO a same-run dedup rewrite key, priorIdAfter('anton-x') already
         resolves to the canonical survivor via the cumulative table (§11
         Q2). The pair has already converged; the remap must record NOTHING
         for it, while Site 1 (applyRewriteToPriorCast) still records its own
         'anton-x' -> canonical entry via the SAME table. */
      const CONVERGE_CHAPTER_BODY =
        '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';

      function convergeStage1RosterForChapter(chapterId: number): CharacterOutput[] {
        const antonId = chapterId === 1 ? 'anton-x' : 'anton-y';
        return [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          {
            id: antonId,
            name: 'Anton Prime',
            role: 'lead',
            color: '#111111',
            gender: 'male',
            evidence: [{ quote: 'Anton asked' }],
          },
        ];
      }

      function convergeSentencesForChapter(chapterId: number): SentenceOutput[] {
        const antonId = chapterId === 1 ? 'anton-x' : 'anton-y';
        return [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: antonId,
            confidence: 0.9,
            text: 'Are you sure this will work',
          },
        ];
      }

      const convergePhase0Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        async runStage1Chapter(
          _manuscriptId: string,
          chapterId: number,
        ): Promise<Stage1ChapterOutput> {
          return { characters: convergeStage1RosterForChapter(chapterId) };
        },
        runStage2Chapter: () =>
          Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () => Promise.reject(new Error('not used')),
      };

      const convergePhase1Analyzer: Analyzer = {
        runStage1: () => Promise.reject(new Error('not used')),
        runStage1Chapter: () =>
          Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
        async runStage2Chapter(
          _manuscriptId: string,
          chapterId: number,
          _prompt: string,
          _call: StageCall,
        ): Promise<Stage2ChapterOutput> {
          return { sentences: convergeSentencesForChapter(chapterId) };
        },
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () =>
          Promise.reject(new Error('no flagged windows — escalation should never be called')),
      };

      const manuscriptId = `test-subset-early-remap-convergence-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: CONVERGE_CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: CONVERGE_CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: CONVERGE_CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Subset Early Remap Convergence E2E Test Book',
        wordCount: 100,
        byteSize: 1000,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
      });

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'anton-x',
              name: 'Anton Prime',
              voiceUuid: 'U-anton',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-anton' } },
            },
          ],
        }),
      );

      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: convergeStage1RosterForChapter(1),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(convergePhase0Analyzer, 'phase0-model-subset');
      const phase1Selection = buildSelection(convergePhase1Analyzer, 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const antonPrime = castAfter.characters.find((c) => c.name === 'Anton Prime');
        expect(antonPrime).toBeDefined();
        const antonPrimeId = antonPrime!.id;
        // Confirms the remap correctly skipped (converged) rather than
        // reversing the roster back onto the stale prior id.
        expect(antonPrimeId).not.toBe('anton-x');

        const history = await loadCastIdHistory(bookDir);
        // Site 1 still records its own entry for this exact pair.
        expect(history.supersededBy).toHaveProperty('anton-x', antonPrimeId);
        // #2040 Task 14 review item 4: same note as the sibling test above
        // (main path, ~:3648) — this assertion no longer isolates "the early
        // remap recorded nothing" on its own, since
        // dropSupersededIdsReclaimedByLiveCast guarantees a LIVE id
        // (antonPrimeId) can never remain a history KEY after this write
        // regardless of whether that bug exists. The real proof is the
        // sibling assertion one line up. Left in place as a secondary check.
        expect(history.supersededBy).not.toHaveProperty(antonPrimeId);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runSubsetAnalyzerJob — #2584/#2570 stripEstablishedAsciiRewrites wiring (PR #2640 pass-3 review, N7)', () => {
  /* Mirrors "runMainAnalyzerJob — #2584/#2570 stripEstablishedAsciiRewrites
     wiring" above, driving runSubsetAnalyzerJob instead — the second pair of
     the 4 real call sites (subset route :7295 `cumulativeForRemap` / :7452
     `cumulative`). Mirrors the reference "Task 11" scaffold above: even on
     the subset (already-analysed) path, Phase 0's `runStage1Chapter` is
     still called per requested chapter (a fresh per-chapter cast probe
     merged with the cache), so it must resolve, not reject — chapter 1
     contributes `oduvan`, chapter 2 `owdovan`, chapter 3 `одуван`, all named
     "Одуван", exactly the same-run duplicate shape as the main-path test. */
  const CHAPTER_BODY = '“Are you sure this will work,” Одуван asked.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(chapterId: number): CharacterOutput[] {
    const oduvanId = chapterId === 1 ? 'oduvan' : chapterId === 2 ? 'owdovan' : 'одуван';
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: oduvanId,
        name: 'Одуван',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Одуван asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    const oduvanId = chapterId === 1 ? 'oduvan' : chapterId === 2 ? 'owdovan' : 'одуван';
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: oduvanId,
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter(chapterId) };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-subset-strip-ascii-rewrites-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_subset_strip_ascii_rewrites_e2e_test',
        manuscriptId,
        title: 'Subset Strip Ascii Rewrites E2E Test Book',
        author: 'Test Author',
        language: 'ru',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Subset Strip Ascii Rewrites E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  function makeSubsetJob(manuscriptId: string, bookDir: string, chapterIds: number[]): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'subset',
      subsetChapterIds: chapterIds,
      bookDir,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it(
    'the established ASCII id survives on the subset path — the fresh Tier-1 survivor cascades onto it, not the reverse',
    async () => {
      const manuscriptId = `test-subset-strip-ascii-rewrites-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      const chapterHints = registerManuscript(manuscriptId, bookDir);

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'oduvan',
              name: 'Одуван',
              voiceState: 'tuned',
              voiceUuid: 'U-oduvan',
              ttsEngine: 'qwen',
              overrideTtsVoices: { qwen: { name: 'qwen-U-oduvan' } },
            },
          ],
        }),
      );

      // stage1Existed === true so Phase 1 (and the persist block the strip
      // guards) actually runs this pass. The per-chapter runStage1Chapter
      // mock (above) still contributes the owdovan/одуван duplicate rows as
      // each requested chapter runs; this seed only needs to be a valid
      // starting roster so the "already analysed" gate is satisfied.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: stage1RosterForChapter(1),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as {
          characters: Array<{
            id: string;
            name: string;
            voiceState?: string;
            voiceUuid?: string;
            overrideTtsVoices?: unknown;
          }>;
        };

        // Sanity: this run's own fresh-side Tier-1 dedup really did collapse
        // the three-way duplicate onto ITS OWN internal survivor.
        const oduvanRows = castAfter.characters.filter((c) => c.name === 'Одуван');
        expect(oduvanRows).toHaveLength(1);

        // Core N7 assertion for the subset-path pair of call sites.
        expect(oduvanRows[0].id).toBe('oduvan');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('одуван');
        expect(castAfter.characters.map((c) => c.id)).not.toContain('owdovan');
        expect(oduvanRows[0].voiceState).toBe('tuned');
        expect(oduvanRows[0].voiceUuid).toBe('U-oduvan');
        expect(oduvanRows[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-U-oduvan' } });

        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).toHaveProperty('одуван', 'oduvan');
        expect(history.supersededBy).not.toHaveProperty('oduvan');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runSubsetAnalyzerJob — a re-minted live id drops its history entry (#2040 Task 14 review item 1)', () => {
  /* Mirrors "runMainAnalyzerJob — a re-minted live id drops its history
     entry (#2040 Task 14, spec §4.4 closing paragraph)" above, driving
     runSubsetAnalyzerJob instead — the subset persist block is a SEPARATE
     dropSupersededIdsReclaimedByLiveCast call site (analysis.ts's subset
     branch), and before this test nothing exercised it: deleting that call
     left both test:server and test:server-slow green (the same green-but-
     inert shape the Wave 1 final review's one Important finding was).

     Same fixture pattern as the Task 11 subset describe above:
     cache.stage1 must be pre-seeded so the subset route takes the "book
     already fully analysed" branch (stage1Existed === true) and actually
     reaches Phase 1 / the persist block where the drop lives — otherwise it
     ends after cast-update and none of this ever runs.

     #2110 — 'eliza' is given real dialogue (3+ lines, `foldMinorCast`'s
     `MIN_LINES_DEFAULT`) so she survives this run's own fresh roster under
     her own id, making her a genuinely LIVE target — needed so the
     'old-eliza' -> 'eliza' assertion below still proves what it claims (an
     entry with a live target surviving untouched) now that the
     dangling-TARGET prune (#2110) runs at the same write as the reclaim
     drop this test pins. */
  const CHAPTER_BODY =
    '“Are you sure this will work,” Anton asked.\n\n“Yes,” Eliza said.\n\n“Let us go,” Eliza added.\n\n“Agreed,” Eliza replied.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'unknown-male',
        name: 'Anton',
        role: 'background',
        color: 'narrator',
        gender: 'male',
        evidence: [{ quote: 'Anton asked' }],
      },
      {
        id: 'eliza',
        name: 'Eliza',
        role: 'lead',
        color: '#333333',
        gender: 'female',
        evidence: [{ quote: 'Eliza said' }, { quote: 'Eliza added' }, { quote: 'Eliza replied' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'unknown-male',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
      {
        id: chapterId * 100 + 2,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Yes',
      },
      {
        id: chapterId * 100 + 3,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Let us go',
      },
      {
        id: chapterId * 100 + 4,
        chapterId,
        characterId: 'eliza',
        confidence: 0.9,
        text: 'Agreed',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-subset-reclaimed-id-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_subset_reclaimed_id_e2e_test',
        manuscriptId,
        title: 'Subset Reclaimed Id E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Subset Reclaimed Id E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  function makeSubsetJob(manuscriptId: string, bookDir: string, chapterIds: number[]): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'subset',
      subsetChapterIds: chapterIds,
      bookDir,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it(
    'a fresh roster reintroducing a live "unknown-male" row drops the stale entry keyed to it, on the subset path',
    async () => {
      const manuscriptId = `test-subset-reclaimed-id-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      const chapterHints = registerManuscript(manuscriptId, bookDir);

      await retireCharacterId(bookDir, 'unknown-male', 'timkin');
      await retireCharacterId(bookDir, 'old-eliza', 'eliza');

      // stage1Existed === true so Phase 1 (and the persist block the drop
      // lives in) actually runs this pass, same as the Task 11 fixture.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: stage1RosterForChapter(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        // Sanity check: 'unknown-male' actually landed in cast.json live.
        const castAfter = JSON.parse(
          readFileSync(castJsonPath(bookDir), 'utf8'),
        ) as { characters: Array<{ id: string }> };
        expect(castAfter.characters.map((c) => c.id)).toContain('unknown-male');

        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).not.toHaveProperty('unknown-male');
        expect(history.supersededBy).toHaveProperty('old-eliza', 'eliza');
        expect(history.displaced).toEqual({ 'unknown-male': 'timkin' });
        expect(
          job.replay.logs.some(
            (l) => l.message.includes('Dropped 1 history alias') && l.message.includes('unknown-male -> timkin'),
          ),
        ).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('runSubsetAnalyzerJob — a supersededBy entry whose target died is pruned (#2110)', () => {
  /* Mirrors "runSubsetAnalyzerJob — a re-minted live id drops its history
     entry" above, but for the MIRROR-IMAGE drop `dropSupersededTargetsNoLongerLive`
     performs: cast-id-history.json holds `{anton: 'антон'}` from an earlier
     retirement; 'антон' is a live-but-UNVOICED prior character. This run's
     fresh roster never mentions her, so the carry-forward drops her with no
     retirement of her own ever recorded — the entry dangles. Proves the
     SUBSET call site (analysis.ts's subset persist block, a separate call
     from the main path's) is actually wired, the same way the sibling
     "reclaim" describe block above proves its own subset call site. */
  const CHAPTER_BODY = '“Are you sure this will work,” Olga asked.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'olga',
        name: 'Olga',
        role: 'lead',
        color: '#222222',
        gender: 'female',
        evidence: [{ quote: 'Olga asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'olga',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-subset-dangling-target-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_subset_dangling_target_e2e_test',
        manuscriptId,
        title: 'Subset Dangling Target E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function seedPriorCastWithDyingAntonAndEliza(bookDir: string): void {
    writeFileSync(
      castJsonPath(bookDir),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          {
            id: 'антон',
            name: 'Антон',
            role: 'character',
            color: 'unset',
            voiceState: 'generated',
          },
          // Voiced (via `voiceState: 'reused'`), unlike 'антон' above — the
          // carry-forward loop rescues a voiced/reused prior row even when
          // the fresh roster never mentions it, so she stays LIVE after
          // this run. Needed so the 'old-eliza' -> 'eliza' entry has a
          // genuinely live target and the test can prove it survives
          // untouched, not merely that it happens to die along with 'антон'.
          { id: 'eliza', name: 'Eliza', role: 'character', color: 'unset', voiceState: 'reused' },
        ],
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Subset Dangling Target E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  function makeSubsetJob(manuscriptId: string, bookDir: string, chapterIds: number[]): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'subset',
      subsetChapterIds: chapterIds,
      bookDir,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it(
    'a fresh roster that drops a live-but-unvoiced "антон" prunes the dangling alias keyed to her, on the subset path',
    async () => {
      const manuscriptId = `test-subset-dangling-target-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      seedPriorCastWithDyingAntonAndEliza(bookDir);
      await retireCharacterId(bookDir, 'anton', 'антон');
      // Unrelated legacy entry with a LIVE target — must survive untouched.
      await retireCharacterId(bookDir, 'old-eliza', 'eliza');
      const chapterHints = registerManuscript(manuscriptId, bookDir);

      // stage1Existed === true so Phase 1 (and the persist block the prune
      // lives in) actually runs this pass.
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: stage1RosterForChapter(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      });

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');
      const job = makeSubsetJob(
        manuscriptId,
        bookDir,
        chapterHints.map((c) => c.id),
      );

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          phase0Selection,
          phase1Selection,
          recordRef.chapterHints,
          true,
        );

        // Sanity check: 'антон' really vanished (unvoiced, no name match in
        // the fresh roster) so the scenario actually fired.
        const castAfter = JSON.parse(
          readFileSync(castJsonPath(bookDir), 'utf8'),
        ) as { characters: Array<{ id: string }> };
        expect(castAfter.characters.map((c) => c.id)).not.toContain('антон');

        const history = await loadCastIdHistory(bookDir);
        expect(history.supersededBy).not.toHaveProperty('anton');
        expect(history.supersededBy).toHaveProperty('old-eliza', 'eliza');
        expect(history.displaced).toEqual({ anton: 'антон' });
        expect(
          job.replay.logs.some(
            (l) =>
              l.message.includes('Dropped 1 history alias') &&
              l.message.includes('anton -> антон') &&
              l.message.includes('target no longer exists'),
          ),
        ).toBe(true);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('#1447 third-party front-matter guard — main-route integration', () => {
  /* Front-matter chapter (index 0, within the guard's default front-region)
     whose title does NOT match Signal 1 (isNonStoryEssayTitle) — the guard
     must fall back to the positional Gate 0 signal instead. A tag-anchored
     quote attributes one line to a real third party, 'Radiy', who is never
     mentioned in any other chapter body. The stubbed analyzer confirms
     Signal 2 (runNonStoryClassification -> { nonStory: true }) since the
     title alone doesn't classify. */
  const ESSAY_CHAPTER_BODY = '“This project was a mistake from the start,” Radiy said.';
  const STORY_CHAPTER_BODY = 'Olga nodded and looked away.';

  function stage1Roster(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'radiy',
        name: 'Radiy',
        role: 'minor',
        color: '#333333',
        evidence: [{ quote: 'Radiy said' }],
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
      async runNonStoryClassification() {
        return { nonStory: true };
      },
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        if (chapterId === 1) {
          return {
            sentences: [
              {
                id: 101,
                chapterId,
                characterId: 'radiy',
                confidence: 0.9,
                text: 'This project was a mistake from the start',
              },
            ],
          };
        }
        return {
          sentences: [
            {
              id: chapterId * 100 + 1,
              chapterId,
              characterId: 'narrator',
              confidence: 0.9,
              text: 'Olga nodded and looked away',
            },
          ],
        };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-thirdparty-guard-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_thirdparty_guard_test',
        manuscriptId,
        title: 'Third Party Guard Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Foreword', slug: '01-foreword' },
          { id: 2, title: 'Chapter One', slug: '02-chapter-one' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function buildStubChapters(): ChapterHint[] {
    return [
      { id: 1, title: 'Foreword', body: ESSAY_CHAPTER_BODY },
      { id: 2, title: 'Chapter One', body: STORY_CHAPTER_BODY },
    ];
  }

  function registerManuscript(manuscriptId: string, bookDir: string): ChapterHint[] {
    const chapterHints = buildStubChapters();
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Third Party Guard Test Book',
      wordCount: 50,
      byteSize: 500,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
    return chapterHints;
  }

  it(
    'strips a third-party name confined to a front-matter chapter from the final roster and re-routes its line to narrator',
    async () => {
      const manuscriptId = `test-thirdparty-guard-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const castFile = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: CharacterOutput[];
        };
        // Third party is gone from the final roster:
        expect(castFile.characters.find((c) => c.name.includes('Radiy'))).toBeUndefined();

        const editsFile = JSON.parse(readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8')) as {
          sentences: SentenceOutput[];
        };
        // The essay's sentence survives, re-routed to narrator:
        const essaySentence = editsFile.sentences.find((s) => s.chapterId === 1);
        expect(essaySentence).toBeDefined();
        expect(essaySentence!.characterId).toBe('narrator');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  /* Fix #1 (this PR's whole-branch-review pass): a Signal-2 analyzer failure
     (truncation, quota, rate-limit, network) must degrade to "treat as story"
     (Signal-1-only) rather than propagating and failing the whole analysis
     job. Same fixture as the passing-Signal-2 test above, except
     runNonStoryClassification REJECTS instead of resolving. */
  function buildPhase0AnalyzerThrowing(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
      async runNonStoryClassification() {
        throw new Error('analyzer truncation / quota / rate-limit hiccup');
      },
    };
  }

  it(
    'completes the job and keeps the third-party character when Signal 2 rejects (degrades to Signal-1-only)',
    async () => {
      const manuscriptId = `test-thirdparty-guard-throw-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      const phase0Selection = buildSelection(buildPhase0AnalyzerThrowing(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // Must NOT throw — a Signal-2 hiccup degrades to Signal-1-only,
        // it does not fail the whole analysis job.
        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const editsFile = JSON.parse(readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8')) as {
          sentences: SentenceOutput[];
        };
        // Title alone doesn't classify and Signal 2 degraded to "story" —
        // the guard did NOT strip Radiy, so its line is NOT re-routed to
        // narrator (the guard's strip action). Radiy only has 1 evidence
        // line, so it's separately (and correctly) folded into the generic
        // background bucket by foldMinorCast (unrelated pre-existing
        // low-line-count rule, not the guard) — the fold target is
        // 'unknown-male', not 'narrator'.
        const essaySentence = editsFile.sentences.find((s) => s.chapterId === 1);
        expect(essaySentence).toBeDefined();
        expect(essaySentence!.characterId).not.toBe('narrator');
        expect(essaySentence!.characterId).toBe('unknown-male');

        const castFile = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: CharacterOutput[];
        };
        // Radiy survives as an alias of the folded background bucket
        // (rolled in by name, not silently discarded).
        const bucket = castFile.characters.find((c) => c.id === 'unknown-male');
        expect(bucket).toBeDefined();
        expect(bucket!.aliases).toContain('Radiy');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});

describe('stage-2 prompt first-person anchor (RC3)', () => {
  const stage1 = {
    characters: [
      { id: 'антон', name: 'Антон', role: 'Colleague', aliases: ['Антон Городецкий', 'Я'] },
      { id: 'егор', name: 'Егор', role: 'Protagonist / Observer' },
    ],
  } as any;
  const chapter = { id: 1, title: 'Ch1', body: 'Я кивнул.' };

  it('emits the first-person anchor naming the narrator id when one is provided', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, 'антон');
    expect(prompt).toContain('First-person narrator');
    expect(prompt).toContain('`антон`');
  });

  it('omits the anchor block when firstPersonId is null', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, null);
    expect(prompt).not.toContain('First-person narrator');
  });
});

describe('stage-2 attribution rules block (Target C)', () => {
  const stage1 = {
    characters: [
      { id: 'anton', name: 'Anton', role: 'Colleague' },
      { id: 'egor', name: 'Egor', role: 'Protagonist' },
    ],
  } as any;
  const chapter = { id: 1, title: 'Ch1', body: '"Get out." Anton turned away.' };

  it('renders the rules block in the chapter builder, after the roster and before the body', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, null);
    expect(prompt).toContain('## Attribution rules');
    expect(prompt).toContain('A dialogue tag is decisive');
    expect(prompt).toContain('The addressee is not the speaker');
    // Order: Characters roster → Attribution rules → Chapter body.
    const roster = prompt.indexOf('## Characters (from stage 1)');
    const rules = prompt.indexOf('## Attribution rules');
    const body = prompt.indexOf('## Chapter 1 —');
    expect(roster).toBeGreaterThanOrEqual(0);
    expect(rules).toBeGreaterThan(roster);
    expect(body).toBeGreaterThan(rules);
  });

  it('renders the chunk-variant rules block in the chunk builder (#1758)', () => {
    const prompt = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, null,
    );
    expect(prompt).toContain('## Attribution rules');
    expect(prompt).toContain('within this section'); // the rule-3 rewrite marker
    // Order: roster → rules → preceding-context → section.
    const characters = prompt.indexOf('## Characters (from stage 1)');
    const rules = prompt.indexOf('## Attribution rules');
    const context = prompt.indexOf('## Preceding context');
    const section = prompt.indexOf('## Section to attribute');
    expect(rules).toBeGreaterThan(characters);
    expect(context).toBeGreaterThan(rules);
    expect(section).toBeGreaterThan(context);
  });

  it('renders the last-speaker seed only when lastSpeakerId is provided (#1758)', () => {
    const seeded = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, 'egor',
    );
    expect(seeded).toContain('## Speaker at section start');
    expect(seeded).toContain('`egor`');
    // Seed sits after preceding-context and before the section body.
    expect(seeded.indexOf('## Speaker at section start')).toBeGreaterThan(
      seeded.indexOf('## Preceding context'),
    );
    expect(seeded.indexOf('## Section to attribute')).toBeGreaterThan(
      seeded.indexOf('## Speaker at section start'),
    );

    const unseeded = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null, null,
    );
    expect(unseeded).not.toContain('## Speaker at section start');
  });

  it('renders the first-person block after the seed when both apply (#1758)', () => {
    const prompt = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', 'anton', 'egor',
    );
    const seed = prompt.indexOf('## Speaker at section start');
    const firstPerson = prompt.indexOf('## First-person narrator');
    expect(seed).toBeGreaterThan(0);
    expect(firstPerson).toBeGreaterThan(seed);
  });

  it('still renders the first-person block after the rules block when a first-person id is present', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, 'anton');
    const rules = prompt.indexOf('## Attribution rules');
    const firstPerson = prompt.indexOf('## First-person narrator');
    expect(rules).toBeGreaterThan(0);
    expect(firstPerson).toBeGreaterThan(rules);
    expect(prompt).toContain('`anton`');
  });
});

describe('chunk-variant attribution rules (#1758)', () => {
  // Extract the numbered rule bodies "N. …" up to the next "\nN. " boundary.
  function rule(block: string, n: number): string {
    const m = block.match(new RegExp(`\\n${n}\\. [\\s\\S]*?(?=\\n\\d\\. |$)`));
    return (m?.[0] ?? '').trim();
  }

  it('shares rules 1, 2, 4, 5 byte-for-byte with the chapter block', () => {
    for (const n of [1, 2, 4, 5]) {
      expect(rule(STAGE2_ATTRIBUTION_RULES_CHUNK, n)).toBe(rule(STAGE2_ATTRIBUTION_RULES, n));
      expect(rule(STAGE2_ATTRIBUTION_RULES_CHUNK, n)).not.toBe(''); // guard: regex actually matched
    }
  });

  it('rewrites rule 3 to scope continuation/alternation within the section', () => {
    const chunk3 = rule(STAGE2_ATTRIBUTION_RULES_CHUNK, 3);
    expect(chunk3).not.toBe(rule(STAGE2_ATTRIBUTION_RULES, 3));
    expect(chunk3).toContain('within this section');
    // No unqualified claim that alternation carries in from before the section.
    expect(chunk3).toContain('Do NOT assume');
  });

  it('both blocks start with the same header, and the full header + lead-in span is byte-identical', () => {
    expect(STAGE2_ATTRIBUTION_RULES_CHUNK.startsWith('## Attribution rules')).toBe(true);
    expect(STAGE2_ATTRIBUTION_RULES.startsWith('## Attribution rules')).toBe(true);

    // The entire span before rule 1 (header + lead-in paragraph) must be
    // byte-identical between the two constants — not just share a prefix.
    const leadIn = (block: string) => block.slice(0, block.indexOf('\n1. '));
    expect(leadIn(STAGE2_ATTRIBUTION_RULES_CHUNK)).toBe(leadIn(STAGE2_ATTRIBUTION_RULES));
  });
});

/* #2324 last gap — `attributeChapterStage2`'s `callForBody` closure
   (analysis.ts, just above `runStage2ChapterChunked`) is the wiring that
   carries the per-call `callSeq` runStage2ChapterChunked generates onto the
   `StageCall.stage2CallSeq` field the two engines' `runStage2Chapter` read
   (see ollama.test.ts / gemini.test.ts "#2342 item 3"). The chunker's own
   callSeq generation is covered in stage2-chunk.test.ts; the engines' READ
   of `call.stage2CallSeq` is covered in ollama.test.ts/gemini.test.ts. This
   is the one link nothing else exercises: the spread
   `{ ...opts.stageCall, stage2CallSeq: callSeq }` vs. plain `opts.stageCall`.
   Reverting that line to plain `opts.stageCall` leaves every other stage-2
   suite green (verified) — this test is written to fail on that revert. */
describe('attributeChapterStage2 — per-call stage2CallSeq wiring (#2324 final gap)', () => {
  const originalCharBudget = process.env.STAGE2_CHUNK_CHAR_BUDGET;
  const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;

  afterEach(() => {
    if (originalCharBudget === undefined) delete process.env.STAGE2_CHUNK_CHAR_BUDGET;
    else process.env.STAGE2_CHUNK_CHAR_BUDGET = originalCharBudget;
    if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
  });

  // 'xx' has no conventions table — a plain pass-through, same as the
  // structure-engine suite's (e) case, so this test stays about the call
  // wiring and not about the dialogue-structure engine's own behaviour.
  const STAGE1: Stage1Output = { characters: [], chapters: [{ id: 1, title: 'Chapter One' }] };

  function fakeAnalyzer(calls: StageCall[]): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () => Promise.reject(new Error('not used')),
      runStage2Chapter: (_manuscriptId, chapterId, _prompt, call) => {
        calls.push(call);
        return Promise.resolve({
          sentences: [
            { id: calls.length, chapterId, characterId: 'narrator', text: 'lorem ipsum dolor sit amet consectetur.' },
          ],
        });
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.resolve(null),
    };
  }

  it("a chunked chapter's calls carry distinct stage2CallSeq values on their StageCall", async () => {
    // Coverage retries off: keeps the call count pinned to exactly one call
    // per section regardless of the fake sentences' coverage verdict — the
    // sequencing under test, not coverage scoring, is the point here.
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    // Small enough that two ~60-char paragraphs can't share a chunk.
    process.env.STAGE2_CHUNK_CHAR_BUDGET = '100';
    const calls: StageCall[] = [];
    const body =
      'The old sailor walked slowly along the misty harbor at dawn.\n\n' +
      'Gulls cried overhead as the fishing boats began to stir awake.';

    await attributeChapterStage2({
      analyzer: fakeAnalyzer(calls),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body },
      stageCall: { language: 'xx' } as StageCall,
    });

    expect(calls).toHaveLength(2); // sanity: the body really did chunk
    expect(calls[0].stage2CallSeq).toBe(1);
    expect(calls[1].stage2CallSeq).toBe(2);
  });

  it("the single-call (unchunked) path's call carries NO stage2CallSeq", async () => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    delete process.env.STAGE2_CHUNK_CHAR_BUDGET; // default 9000 — far over this short body
    const calls: StageCall[] = [];
    const body = 'The old sailor walked slowly along the misty harbor at dawn.';

    await attributeChapterStage2({
      analyzer: fakeAnalyzer(calls),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body },
      stageCall: { language: 'xx' } as StageCall,
    });

    expect(calls).toHaveLength(1); // sanity: the body really did NOT chunk
    expect(calls[0].stage2CallSeq).toBeUndefined();
  });
});

describe('runMainAnalyzerJob — the remap never retires a LIVE prior id (#2040 Wave 2 final review, finding 1)', () => {
  /* End-to-end proof for the Critical the whole-branch review found, driven
     through the REAL route with real file I/O and no mocked history.

     The shape (verified by the reviewer against the running algorithm):
       history  {"brann-w": "brann"}          — correct; those frozen segments
                                                are Brann's
       prior    {id:'brann', name:'Brann'}    voiced V1
                {id:'brann-weir', name:'Brann Weir'}  voiced V2
       fresh    {id:'brann', name:'Brann Weir'}  — the analyzer flips the id
                                                   onto the OTHER character's
                                                   name (spec §1.2's rename)

     `dedupePriorCastByName` does not collapse the prior pair (normaliseNameKey
     gives `brann` / `brannweir`), so both rows are live going in and both are
     live in the cast.json this run writes. `remapFreshToPriorIds` name-matches
     the fresh row to prior 'brann-weir' and — before the fix — emitted
     `brann -> brann-weir`, a retirement of an id a different, live character
     still holds. `retireCharacterId` then repointed EVERY entry whose value
     was 'brann', so 'brann-w' followed, and Brann's frozen segments would
     render in Brann Weir's V2 from then on. The end-of-run
     `dropSupersededIdsReclaimedByLiveCast` removes the reclaimed 'brann' KEY
     and never the collateral repoint, so the damage is silent and permanent.

     Paths that could otherwise satisfy these assertions (checked, so this is
     not another green-but-inert pin):
       - Site 1 (applyRewriteToPriorCast) needs 'brann' to be a key in
         composeRewrites(dd.rewrites, folded.rewrites). The fresh roster has a
         single "Brann Weir" row (no same-name collision to dedupe) with 3
         attributed lines (>= MIN_LINES_DEFAULT, so no fold) — both tables are
         empty for it.
       - Site 2 (dedupePriorCastByName) cannot fire: the two prior name keys
         differ, as above.
       - Site 3 (mergeAnalysisResultWithExistingCast's name-fallback) only runs
         under `if (!old)`; the fresh 'brann' row matches prior 'brann' by
         EXACT id, so the fallback branch is never entered.
     Site 4 — this remap — is therefore the only producer of a 'brann'
     retirement in this fixture. */
  const CHAPTER_BODY = '“Are you sure this will work,” Brann asked.\n\nOlga nodded and looked away.';

  function stage1RosterForChapter(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'brann',
        name: 'Brann Weir',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Brann asked' }],
      },
    ];
  }

  function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'brann',
        confidence: 0.9,
        text: 'Are you sure this will work',
      },
    ];
  }

  function buildPhase0Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        return { characters: stage1RosterForChapter() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        return { sentences: mockAttributionSentencesForChapter(chapterId) };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () =>
        Promise.reject(new Error('no flagged windows — escalation should never be called')),
    };
  }

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }

  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-live-id-retire-e2e-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(bookDir: string, manuscriptId: string): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_live_id_retire_e2e_test',
        manuscriptId,
        title: 'Live Id Retire E2E Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function registerManuscript(manuscriptId: string, bookDir: string): void {
    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Live Id Retire E2E Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });
  }

  it(
    "an analyzer id flip onto another live character's name leaves the unrelated history chain pointing where it did",
    async () => {
      const manuscriptId = `test-live-id-retire-e2e-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      seedStateJson(bookDir, manuscriptId);
      registerManuscript(manuscriptId, bookDir);

      // Correct, working history from an earlier run: 'brann-w' is Brann.
      await retireCharacterId(bookDir, 'brann-w', 'brann');

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            { id: 'brann', name: 'Brann', voiceState: 'locked', voiceUuid: 'U-brann-1' },
            {
              id: 'brann-weir',
              name: 'Brann Weir',
              voiceState: 'locked',
              voiceUuid: 'U-brann-weir-2',
            },
          ],
        }),
      );

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
        controller: new AbortController(),
        subscribers: new Set(),
        manuscriptId,
        kind: 'main',
        bookDir,
        engine: 'gemini',
        replay: {
          logs: [],
          lastPhase: null,
          lastEta: null,
          lastCastUpdate: null,
          failedByChapterId: new Map(),
          lastSeriesPrior: null,
          warnings: new Map(),
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // Fixture sanity: BOTH prior rows are still live in the cast.json this
        // run wrote, which is exactly what makes retiring either of them
        // illegitimate. If this fails the fixture has drifted, not the fix.
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; name: string }> };
        const idsAfter = castAfter.characters.map((c) => c.id);
        expect(idsAfter).toContain('brann');
        expect(idsAfter).toContain('brann-weir');

        const history = await loadCastIdHistory(bookDir);
        // THE property: Brann's frozen segments still resolve to Brann.
        expect(history.supersededBy).toHaveProperty('brann-w', 'brann');
        // And no retirement of the live 'brann' id was recorded at all —
        // neither as a surviving entry nor as one the end-of-run drop had to
        // clean up (which would have left the repoint behind).
        expect(history.supersededBy).not.toHaveProperty('brann');
        expect(history.displaced ?? {}).not.toHaveProperty('brann');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});
/* Task 6c (#2246) — the analyzer path stops substituting 'en' for a book that
   never declared a language (the no-op trap). Three required moves:
     (a) the POST handler answers a real HTTP 409 `{ error: 'language_unset' }`
         BEFORE the SSE stream opens / the job detaches;
     (b) the `located === null` (pre-confirm, no book on disk yet) carve-out
         still resolves 'en' (covered in analysis-language.test.ts);
     (c) the detached loop (no `res` to answer with) surfaces an unset language
         as an SSE `error` with code `language_unset` — the same endJob
         broadcast mechanism classifyAnalysisFailure uses for lock-contention —
         and the body carries NO filesystem path.
   Driven through the mocked ../workspace/scan.js findBookByManuscriptId: the
   `__analysis_test_book_language_unset` hook returns the located-but-absent
   book so requireBookStateLanguage throws under test without touching a real
   BOOKS_ROOT tree. */
describe('Task 6c (#2246) - the analyzer path stops defaulting to en', () => {
  it('(a) POST /:id/analysis answers a real 409 { error: "language_unset" } before the stream opens', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-lang-unset-gate-${Date.now()}-${Math.random()}`;
    const g = globalThis as Record<string, unknown>;
    if (!Array.isArray(g.__analysis_test_book_language_unset)) g.__analysis_test_book_language_unset = [];
    (g.__analysis_test_book_language_unset as string[]).push(manuscriptId);
    try {
      const res = await supertest(app).post(`/api/manuscripts/${manuscriptId}/analysis`).send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'language_unset' });
    } finally {
      const arr = g.__analysis_test_book_language_unset as string[];
      const i = arr.indexOf(manuscriptId);
      if (i >= 0) arr.splice(i, 1);
    }
  });

  it('(a) control: a book WITH a language is NOT a 409 - it reaches the SSE stream', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-lang-present-gate-${Date.now()}-${Math.random()}`;
    (globalThis as Record<string, unknown>).__analysis_test_book_language_override = {
      manuscriptId,
      language: 'ru',
    };
    try {
      // No stub manuscript is registered, so the handler proceeds past the
      // gate and answers with the SSE `unknown_manuscript` error (200) - the
      // point is it must NOT 409 at the language gate.
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');
      expect(res.text).not.toContain('language_unset');
    } finally {
      delete (globalThis as Record<string, unknown>).__analysis_test_book_language_override;
    }
  });

  it('(c) main loop: an unset language emits an SSE error code language_unset with no filesystem path', async () => {
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const manuscriptId = `test-lang-unset-loop-${Date.now()}-${Math.random()}`;
    const g = globalThis as Record<string, unknown>;
    if (!Array.isArray(g.__analysis_test_book_language_unset)) g.__analysis_test_book_language_unset = [];
    (g.__analysis_test_book_language_unset as string[]).push(manuscriptId);

    const events: unknown[] = [];
    const job = {
      controller: new AbortController(),
      subscribers: new Set([{ send: (ev: unknown) => events.push(ev) }]),
      manuscriptId,
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;

    try {
      await runMainAnalyzerJob(job, undefined as never, undefined as never, {
        requestedFresh: false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const err = events.find(
        (e) => (e as { kind?: string }).kind === 'error',
      ) as { kind: string; code?: string; message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.code).toBe('language_unset');
      expect(err?.message).toBeDefined();
      // Both halves: assert the ABSENCE of a filesystem path, do not eyeball it.
      expect(err?.message).not.toMatch(/[A-Za-z]:[\\/]/); // no drive-letter path
      expect(err?.message).not.toMatch(/(^|[\\/])books[\\/]/i); // no workspace /books/ tree
      expect(err?.message).not.toMatch(/[\\/]\.audiobook[\\/]/); // no .audiobook dir
    } finally {
      const arr = g.__analysis_test_book_language_unset as string[];
      const i = arr.indexOf(manuscriptId);
      if (i >= 0) arr.splice(i, 1);
    }
  });

  it('(c) subset loop: an unset language emits the same path-free language_unset SSE error', async () => {
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const manuscriptId = `test-lang-unset-subset-${Date.now()}-${Math.random()}`;
    const g = globalThis as Record<string, unknown>;
    if (!Array.isArray(g.__analysis_test_book_language_unset)) g.__analysis_test_book_language_unset = [];
    (g.__analysis_test_book_language_unset as string[]).push(manuscriptId);

    const events: unknown[] = [];
    const job = {
      controller: new AbortController(),
      subscribers: new Set([{ send: (ev: unknown) => events.push(ev) }]),
      manuscriptId,
      kind: 'subset',
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;

    try {
      await runSubsetAnalyzerJob(
        job,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        true,
      );

      const err = events.find(
        (e) => (e as { kind?: string }).kind === 'error',
      ) as { kind: string; code?: string; message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.code).toBe('language_unset');
      expect(err?.message).toMatch(/Book settings/); // the curated client-facing sentence
      expect(err?.message).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(err?.message).not.toMatch(/(^|[\\/])books[\\/]/i);
    } finally {
      const arr = g.__analysis_test_book_language_unset as string[];
      const i = arr.indexOf(manuscriptId);
      if (i >= 0) arr.splice(i, 1);
    }
  });

  it('#3004 — rejoin-miss event fires after a terminal job outcome, with the persisted error payload', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const { putManuscript } = await import('../store/manuscripts.js');

    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-rejoin-miss-${Date.now()}-${Math.random()}`;
    const g = globalThis as Record<string, unknown>;

    // Set up a manuscript so it passes the initial lookup
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Test Rejoin Miss Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: 'Test body',
      chapterHints: [{ id: 1, title: 'Chapter One', body: 'Test body' }],
      bookDir: null,
    });

    // Set language in the override to pass the pre-flight gate,
    // then mark it for failure in the main loop.
    g.__analysis_test_book_language_override = {
      manuscriptId,
      language: 'en',
    };
    if (!Array.isArray(g.__analysis_test_book_language_unset)) g.__analysis_test_book_language_unset = [];
    (g.__analysis_test_book_language_unset as string[]).push(manuscriptId);

    try {
      // Make the initial POST to start an analysis job that will fail with language_unset
      const startRes = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);

      expect(startRes.status).toBe(200);

      // Parse the SSE response to find the error event
      const lines = startRes.text.split('\n');
      let foundError = false;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if ((data as Record<string, unknown>).kind === 'error') {
              foundError = true;
              const errorCode = (data as Record<string, unknown>).code as string;
              expect(errorCode).toBe('language_unset');
            }
          } catch {
            // Skip lines that aren't valid JSON
          }
        }
      }

      expect(foundError).toBe(true, 'should have received an error event in the first response');

      // Small delay to allow the outcome file to be written
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now make a rejoin POST and check for rejoin-miss event
      const rejoinRes = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);

      expect(rejoinRes.status).toBe(200);

      // Parse the rejoin response
      const rejoinLines = rejoinRes.text.split('\n');
      let foundRejoinMiss = false;

      for (const line of rejoinLines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if ((data as Record<string, unknown>).kind === 'rejoin-miss') {
              foundRejoinMiss = true;
              // Should contain the persisted error outcome
              const priorOutcome = (data as Record<string, unknown>).priorOutcome as Record<string, unknown> | undefined;
              expect(priorOutcome).toBeDefined();
              expect(priorOutcome?.kind).toBe('error');
              expect(priorOutcome?.code).toBe('language_unset');
            }
          } catch {
            // Skip lines that aren't valid JSON
          }
        }
      }

      expect(foundRejoinMiss).toBe(true, 'should have received a rejoin-miss event in the rejoin response');
    } finally {
      delete g.__analysis_test_book_language_override;
      const arr = g.__analysis_test_book_language_unset as string[];
      const i = arr.indexOf(manuscriptId);
      if (i >= 0) arr.splice(i, 1);
    }
  });
});
