/* Stage-1 roster coverage guard. Pins the detector that catches a speaker the
   per-chapter detection model dropped from a chapter's roster despite the prose
   tagging them (the 2026-06-05 The Drowning Bell ch19 "Lessom" bug — 10+ dialogue
   tags, never on the roster, every line dumped on the narrator). The prompt was
   also strengthened, but a prompt can't be unit-tested deterministically — this
   guard is the regression guarantee. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  validateRosterCoverage,
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

/* The shape of the canonical bug, abbreviated: Aldous (on the roster) talks to
   Lessom (NOT on the roster), whose replies are tagged but uncast. */
const Lessom_BODY = [
  '"Because I have a proposition for the most talented Keeper I’ve ever met."',
  '"The most talented," Lessom repeated, tucking his dreadlocks behind his ears.',
  '"That is some heavy flattery," Lessom said slowly.',
  '"We aren’t," Aldous agreed.',
  '"And you trust them?" Lessom asked, turning to face him.',
].join(' ');

describe('validateRosterCoverage', () => {
  it('flags a tagged speaker absent from the roster (the Lessom/ch19 regression)', () => {
    const v = validateRosterCoverage(Lessom_BODY, ['Aldous', 'Wren Sparrow']);
    expect(v.ok).toBe(false);
    const names = v.missingSpeakers.map((s) => s.name);
    expect(names).toContain('Lessom');
    const Lessom = v.missingSpeakers.find((s) => s.name === 'Lessom')!;
    expect(Lessom.id).toBe('Lessom');
    expect(Lessom.tagCount).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a speaker already on the roster', () => {
    const v = validateRosterCoverage(Lessom_BODY, ['Aldous', 'Lessom']);
    expect(v.ok).toBe(true);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('matches by FIRST name — "Wren said" covers roster entry "Wren Sparrow"', () => {
    // Regression: tags use the first name but the roster stores the full name.
    // Indexing only the last token mis-flagged every main-cast member as missing
    // (caught by the live The Drowning Bell audit).
    const body = '"Wait," Wren said. "Now," Wren asked. "Fine," Hart agreed.';
    const v = validateRosterCoverage(body, ['Wren Sparrow', 'Hart Vale']);
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
    const v = validateRosterCoverage(body, ['Aldous']);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('bounds false positives: a single non-quote-adjacent hit is dropped', () => {
    // "the Council agreed" with no nearby quote, appearing once → not flagged.
    const body = 'After a long debate that lasted hours, the Council agreed on a new policy for the realm.';
    const v = validateRosterCoverage(body, ['Aldous']);
    expect(v.missingSpeakers.map((s) => s.name)).not.toContain('Council');
  });

  it('flags a candidate that recurs (>= 2 tags) even without a quote nearby', () => {
    const body = 'Then Bram said the words. Later, Bram said them again, far from any dialogue.';
    const v = validateRosterCoverage(body, ['Aldous']);
    expect(v.missingSpeakers.map((s) => s.name)).toContain('Bram');
  });

  it('honors ROSTER_GUARD_IGNORE_NAMES', () => {
    process.env.ROSTER_GUARD_IGNORE_NAMES = 'Lessom';
    const v = validateRosterCoverage(Lessom_BODY, ['Aldous']);
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
      { characters: [{ id: 'Aldous', name: 'Aldous' }] }, // misses Lessom
      { characters: [{ id: 'Aldous', name: 'Aldous' }, { id: 'Lessom', name: 'Lessom' }] },
    ];
    let i = 0;
    const call = vi.fn(async () => calls[i++]);
    const res = await runStage1WithRosterGuard({
      body: Lessom_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(res.verdict.ok).toBe(true);
    expect(res.autoAdded).toHaveLength(0);
    expect(res.result.characters.map((c) => c.id)).toContain('Lessom');
  });

  it('auto-adds the missing speaker when retries still miss', async () => {
    const call = vi.fn(async () => ({ characters: [{ id: 'Aldous', name: 'Aldous' }] }));
    const onAutoAdd = vi.fn();
    const res = await runStage1WithRosterGuard({
      body: Lessom_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
      onAutoAdd,
    });
    expect(call).toHaveBeenCalledTimes(2); // 1 + 1 retry
    expect(res.autoAdded.map((m) => m.id)).toContain('Lessom');
    const Lessom = res.result.characters.find((c) => c.id === 'Lessom')!;
    expect(Lessom.name).toBe('Lessom');
    expect(onAutoAdd).toHaveBeenCalledOnce();
  });

  it('does not retry or add when coverage is already clean', async () => {
    const call = vi.fn(async () => ({
      characters: [{ id: 'Aldous', name: 'Aldous' }, { id: 'Lessom', name: 'Lessom' }],
    }));
    const res = await runStage1WithRosterGuard({
      body: Lessom_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.autoAdded).toHaveLength(0);
  });

  it('respects maxRetries=0 (no retry, straight to auto-add)', async () => {
    const call = vi.fn(async () => ({ characters: [{ id: 'Aldous', name: 'Aldous' }] }));
    const res = await runStage1WithRosterGuard({
      body: Lessom_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 0,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.autoAdded.map((m) => m.id)).toContain('Lessom');
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
    expect(toKebabId('Mr. Casper')).toBe('mr-Casper');
    expect(toKebabId('Lessom')).toBe('Lessom');
  });
});
