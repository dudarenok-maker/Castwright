import { describe, it, expect, vi } from 'vitest';
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
  attributionDriftExceeded,
  stage1ShrinkRefused,
  buildStage1ChapterInbox,
  readPriorCastForMerge,
  trackForReplay,
  replayCatchUp,
  castInFlightEntryToLiveChapter,
} from './analysis.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      replay: { failedByChapterId: new Map(), logs: [] },
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

  it('empty input is a no-op (zero counts, empty output)', () => {
    const result = reconcileSentenceCharacterIds([], new Set(['narrator']));
    expect(result.demotedCount).toBe(0);
    expect(result.sentences).toEqual([]);
    expect(result.demotedByOriginalId.size).toBe(0);
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
      expect(prior.map((c) => c.id)).toEqual(['live']);
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
      expect(prior).toHaveLength(1);
      expect(prior[0]).toMatchObject({ id: 'wren', voiceId: 'wren', voiceState: 'reused' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when neither file exists', async () => {
    const dir = makeBookDir();
    try {
      expect(await readPriorCastForMerge(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
