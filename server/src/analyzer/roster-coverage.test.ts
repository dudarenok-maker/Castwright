/* Stage-1 roster coverage guard. Pins the detector that catches a speaker the
   per-chapter detection model dropped from a chapter's roster despite the prose
   tagging them (the 2026-06-05 The Drowning Bell ch19 "Lessom" bug — 10+ dialogue
   tags, never on the roster, every line dumped on the narrator). The prompt was
   also strengthened, but a prompt can't be unit-tested deterministically — this
   guard is the regression guarantee. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  validateRosterCoverage,
  validateAttributionCoverage,
  runStage1WithRosterGuard,
  chapterDriftExceeded,
  toKebabId,
  type MissingSpeaker,
} from './roster-coverage.js';

afterEach(() => {
  delete process.env.ROSTER_GUARD_IGNORE_NAMES;
  delete process.env.ROSTER_MIN_HITS_NO_QUOTE;
  delete process.env.ROSTER_QUOTE_PROXIMITY;
});

/* The shape of the canonical bug, abbreviated: Kenric (on the roster) talks to
   Lessom (NOT on the roster), whose replies are tagged but uncast. */
const LESSOM_BODY = [
  '"Because I have a proposition for the most talented Keeper I’ve ever met."',
  '"The most talented," Lessom repeated, tucking his dreadlocks behind his ears.',
  '"That is some heavy flattery," Lessom said slowly.',
  '"We aren’t," Kenric agreed.',
  '"And you trust them?" Lessom asked, turning to face him.',
].join(' ');

describe('validateRosterCoverage', () => {
  it('flags a tagged speaker absent from the roster (the Lessom/ch19 regression)', () => {
    const v = validateRosterCoverage(LESSOM_BODY, ['Kenric', 'Wren Sparrow']);
    expect(v.ok).toBe(false);
    const names = v.missingSpeakers.map((s) => s.name);
    expect(names).toContain('Lessom');
    const lessom = v.missingSpeakers.find((s) => s.name === 'Lessom')!;
    expect(lessom.id).toBe('lessom');
    expect(lessom.tagCount).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a speaker already on the roster', () => {
    const v = validateRosterCoverage(LESSOM_BODY, ['Kenric', 'Lessom']);
    expect(v.ok).toBe(true);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('matches by FIRST name — "Wren said" covers roster entry "Wren Sparrow"', () => {
    // Regression: tags use the first name but the roster stores the full name.
    // Indexing only the last token mis-flagged every main-cast member as missing
    // (caught by the live The Drowning Bell audit).
    const body = '"Wait," Wren said. "Now," Wren asked. "Fine," Hart agreed.';
    const v = validateRosterCoverage(body, ['Wren Sparrow', 'Hart Dizznee']);
    expect(v.ok).toBe(true);
  });

  it('matches by last token so a title-prefixed roster name covers a bare tag', () => {
    const body = '"Indeed," Casper said. "Indeed," Casper agreed.';
    const v = validateRosterCoverage(body, ['Mr. Casper']);
    expect(v.ok).toBe(true);
  });

  it('does not flag contractions like "I’ve" / "You’ve" before a verb', () => {
    const body = '"Hi," Wren said. I’ve agreed to this. You’ve repeated it twice.';
    const v = validateRosterCoverage(body, ['Wren']);
    expect(v.missingSpeakers.map((s) => s.name.toLowerCase())).not.toContain("i've");
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('ignores possessives — "Wren’s" resolves to the rostered "Wren"', () => {
    const body = "Wren's plan said everything. \"Hi,\" Wren said.";
    const v = validateRosterCoverage(body, ['Wren']);
    expect(v.ok).toBe(true);
  });

  it('does not flag pronoun openers like "She said" / "They agreed"', () => {
    const body = '"Hello," she said. "Fine," they agreed. "Now," He asked.';
    const v = validateRosterCoverage(body, ['Kenric']);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('bounds false positives: a single non-quote-adjacent hit is dropped', () => {
    // "the Council agreed" with no nearby quote, appearing once → not flagged.
    const body = 'After a long debate that lasted hours, the Council agreed on a new policy for the realm.';
    const v = validateRosterCoverage(body, ['Kenric']);
    expect(v.missingSpeakers.map((s) => s.name)).not.toContain('Council');
  });

  it('flags a candidate that recurs (>= 2 tags) even without a quote nearby', () => {
    const body = 'Then Bram said the words. Later, Bram said them again, far from any dialogue.';
    const v = validateRosterCoverage(body, ['Kenric']);
    expect(v.missingSpeakers.map((s) => s.name)).toContain('Bram');
  });

  it('does not flag collective / group nouns ("Councillors agreed", "Coaches shouted")', () => {
    const body = '"Now," the Councillors agreed. "Move," the Coaches shouted. "Go," Pyrokinetics yelled.';
    const v = validateRosterCoverage(body, ['Kenric']);
    const flagged = v.missingSpeakers.map((s) => s.name.toLowerCase());
    expect(flagged).not.toContain('councillors');
    expect(flagged).not.toContain('coaches');
    expect(flagged).not.toContain('pyrokinetics');
  });

  it('does not flag disguise-alias tokens ("Marlow-as-Lady-Gisela said")', () => {
    const body = '"Hello," Marlow-as-Lady-Gisela said. "Indeed," Marlow-as-Lady-Gisela agreed.';
    const v = validateRosterCoverage(body, ['Wren']);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('resolves a bare disguise name via a hyphenated roster entry', () => {
    const body = '"Hello," Gisela said. "Indeed," Gisela agreed.';
    const v = validateRosterCoverage(body, ['Marlow-as-Lady-Gisela']);
    expect(v.ok).toBe(true);
  });

  it('honors ROSTER_GUARD_IGNORE_NAMES', () => {
    process.env.ROSTER_GUARD_IGNORE_NAMES = 'lessom';
    const v = validateRosterCoverage(LESSOM_BODY, ['Kenric']);
    expect(v.missingSpeakers.map((s) => s.name)).not.toContain('Lessom');
  });
});

// Minimal character shape — the guard only requires { id, name } on C. (The
// production wiring's makeRecoveredCharacter returns a full CharacterOutput.)
const makeChar = (m: MissingSpeaker): { id: string; name: string } => ({
  id: m.id,
  name: m.name,
});

describe('runStage1WithRosterGuard', () => {
  it('retries once, then keeps the cleaner take', async () => {
    const calls = [
      { characters: [{ id: 'kenric', name: 'Kenric' }] }, // misses Lessom
      { characters: [{ id: 'kenric', name: 'Kenric' }, { id: 'lessom', name: 'Lessom' }] },
    ];
    let i = 0;
    const call = vi.fn(async () => calls[i++]);
    const res = await runStage1WithRosterGuard({
      body: LESSOM_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(res.verdict.ok).toBe(true);
    expect(res.autoAdded).toHaveLength(0);
    expect(res.result.characters.map((c) => c.id)).toContain('lessom');
  });

  it('auto-adds the missing speaker when retries still miss', async () => {
    const call = vi.fn(async () => ({ characters: [{ id: 'kenric', name: 'Kenric' }] }));
    const onAutoAdd = vi.fn();
    const res = await runStage1WithRosterGuard({
      body: LESSOM_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
      onAutoAdd,
    });
    expect(call).toHaveBeenCalledTimes(2); // 1 + 1 retry
    expect(res.autoAdded.map((m) => m.id)).toContain('lessom');
    const lessom = res.result.characters.find((c) => c.id === 'lessom')!;
    expect(lessom.name).toBe('Lessom');
    expect(onAutoAdd).toHaveBeenCalledOnce();
  });

  it('does not retry or add when coverage is already clean', async () => {
    const call = vi.fn(async () => ({
      characters: [{ id: 'kenric', name: 'Kenric' }, { id: 'lessom', name: 'Lessom' }],
    }));
    const res = await runStage1WithRosterGuard({
      body: LESSOM_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.autoAdded).toHaveLength(0);
  });

  it('respects maxRetries=0 (no retry, straight to auto-add)', async () => {
    const call = vi.fn(async () => ({ characters: [{ id: 'kenric', name: 'Kenric' }] }));
    const res = await runStage1WithRosterGuard({
      body: LESSOM_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 0,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.autoAdded.map((m) => m.id)).toContain('lessom');
  });
});

describe('chapterDriftExceeded', () => {
  it('catches an in-chapter demotion spike that the book-wide gate dilutes', () => {
    // 30 of 40 chapter sentences demoted → 75% in-chapter.
    expect(chapterDriftExceeded(30, 40)).toBe(true);
  });

  it('does not fire on a small sample', () => {
    expect(chapterDriftExceeded(10, 15)).toBe(false);
  });

  it('does not fire on a low rate', () => {
    expect(chapterDriftExceeded(2, 100)).toBe(false);
  });
});

describe('toKebabId', () => {
  it('kebab-cases names like the analyzer convention', () => {
    expect(toKebabId('Mr. Casper')).toBe('mr-casper');
    expect(toKebabId('Lessom')).toBe('lessom');
  });
});

describe('validateAttributionCoverage (#529 half-state)', () => {
  const roster = [
    { id: 'lessom', name: 'Lessom' },
    { id: 'kenric', name: 'Kenric' },
  ];

  it('flags a rostered, prose-tagged speaker with 0 attributed lines (Lessom/ch19 half-state)', () => {
    /* Lessom is in the roster but every line landed on narrator (interrupted
       re-analysis). Kenric is tagged once but has a line, so he's fine. */
    const sentences = [
      { characterId: 'narrator' },
      { characterId: 'narrator' },
      { characterId: 'kenric' },
      { characterId: 'narrator' },
    ];
    const v = validateAttributionCoverage(LESSOM_BODY, roster, sentences);
    expect(v.ok).toBe(false);
    expect(v.halfStateSpeakers.map((s) => s.id)).toContain('lessom');
    expect(v.halfStateSpeakers.map((s) => s.id)).not.toContain('kenric');
    const lessom = v.halfStateSpeakers.find((s) => s.id === 'lessom')!;
    expect(lessom.attributedLines).toBe(0);
    expect(lessom.narratorLines).toBe(3);
    expect(lessom.tagCount).toBeGreaterThanOrEqual(2);
  });

  it('does NOT flag rostered speakers who already have attributed lines', () => {
    /* Both tagged speakers (Lessom + Kenric) carry a line, so neither is a
       half-state — even though most of the chapter is narration. */
    const sentences = [
      { characterId: 'lessom' },
      { characterId: 'kenric' },
      { characterId: 'narrator' },
    ];
    const v = validateAttributionCoverage(LESSOM_BODY, roster, sentences);
    expect(v.ok).toBe(true);
    expect(v.halfStateSpeakers).toHaveLength(0);
  });

  it('never flags the narrator or an unknown-* bucket (minor speakers fold in as aliases)', () => {
    const body = '"Indeed," Bronte said. "Quite," Bronte agreed firmly.';
    const bucketRoster = [{ id: 'unknown-male', name: 'Unknown Male', aliases: ['Bronte'] }];
    // Bucket has 0 lines in this chapter, yet must NOT flag (it's a bucket).
    const v = validateAttributionCoverage(body, bucketRoster, [{ characterId: 'narrator' }]);
    expect(v.ok).toBe(true);
  });

  it('respects the single-hit quote-adjacency bound (no false positive)', () => {
    const body =
      'Far from any dialogue, Lessom agreed with the assessment completely and utterly.';
    const v = validateAttributionCoverage(body, [{ id: 'lessom', name: 'Lessom' }], [
      { characterId: 'narrator' },
    ]);
    expect(v.ok).toBe(true); // one tag, no nearby quote → below the flag threshold
  });
});
