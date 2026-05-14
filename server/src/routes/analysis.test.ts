import { describe, it, expect, vi } from 'vitest';
import { sortEvidence, normaliseForMatch, verifyEvidenceAgainstSource, mergeRosterChapter } from './analysis.js';
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
