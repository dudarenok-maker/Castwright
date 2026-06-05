/* Stage-1 roster coverage guard. Pins the detector that catches a speaker the
   per-chapter detection model dropped from a chapter's roster despite the prose
   tagging them (the 2026-06-05 Stellarlune ch19 "Prentice" bug — 10+ dialogue
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

/* The shape of the canonical bug, abbreviated: Kenric (on the roster) talks to
   Prentice (NOT on the roster), whose replies are tagged but uncast. */
const PRENTICE_BODY = [
  '"Because I have a proposition for the most talented Keeper I’ve ever met."',
  '"The most talented," Prentice repeated, tucking his dreadlocks behind his ears.',
  '"That is some heavy flattery," Prentice said slowly.',
  '"We aren’t," Kenric agreed.',
  '"And you trust them?" Prentice asked, turning to face him.',
].join(' ');

describe('validateRosterCoverage', () => {
  it('flags a tagged speaker absent from the roster (the Prentice/ch19 regression)', () => {
    const v = validateRosterCoverage(PRENTICE_BODY, ['Kenric', 'Sophie Foster']);
    expect(v.ok).toBe(false);
    const names = v.missingSpeakers.map((s) => s.name);
    expect(names).toContain('Prentice');
    const prentice = v.missingSpeakers.find((s) => s.name === 'Prentice')!;
    expect(prentice.id).toBe('prentice');
    expect(prentice.tagCount).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a speaker already on the roster', () => {
    const v = validateRosterCoverage(PRENTICE_BODY, ['Kenric', 'Prentice']);
    expect(v.ok).toBe(true);
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('matches by FIRST name — "Sophie said" covers roster entry "Sophie Foster"', () => {
    // Regression: tags use the first name but the roster stores the full name.
    // Indexing only the last token mis-flagged every main-cast member as missing
    // (caught by the live Stellarlune audit).
    const body = '"Wait," Sophie said. "Now," Sophie asked. "Fine," Dex agreed.';
    const v = validateRosterCoverage(body, ['Sophie Foster', 'Dex Dizznee']);
    expect(v.ok).toBe(true);
  });

  it('matches by last token so a title-prefixed roster name covers a bare tag', () => {
    const body = '"Indeed," Forkle said. "Indeed," Forkle agreed.';
    const v = validateRosterCoverage(body, ['Mr. Forkle']);
    expect(v.ok).toBe(true);
  });

  it('does not flag contractions like "I’ve" / "You’ve" before a verb', () => {
    const body = '"Hi," Sophie said. I’ve agreed to this. You’ve repeated it twice.';
    const v = validateRosterCoverage(body, ['Sophie']);
    expect(v.missingSpeakers.map((s) => s.name.toLowerCase())).not.toContain("i've");
    expect(v.missingSpeakers).toHaveLength(0);
  });

  it('ignores possessives — "Sophie’s" resolves to the rostered "Sophie"', () => {
    const body = "Sophie's plan said everything. \"Hi,\" Sophie said.";
    const v = validateRosterCoverage(body, ['Sophie']);
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
    const body = 'Then Brant said the words. Later, Brant said them again, far from any dialogue.';
    const v = validateRosterCoverage(body, ['Kenric']);
    expect(v.missingSpeakers.map((s) => s.name)).toContain('Brant');
  });

  it('honors ROSTER_GUARD_IGNORE_NAMES', () => {
    process.env.ROSTER_GUARD_IGNORE_NAMES = 'prentice';
    const v = validateRosterCoverage(PRENTICE_BODY, ['Kenric']);
    expect(v.missingSpeakers.map((s) => s.name)).not.toContain('Prentice');
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
      { characters: [{ id: 'kenric', name: 'Kenric' }] }, // misses Prentice
      { characters: [{ id: 'kenric', name: 'Kenric' }, { id: 'prentice', name: 'Prentice' }] },
    ];
    let i = 0;
    const call = vi.fn(async () => calls[i++]);
    const res = await runStage1WithRosterGuard({
      body: PRENTICE_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(res.verdict.ok).toBe(true);
    expect(res.autoAdded).toHaveLength(0);
    expect(res.result.characters.map((c) => c.id)).toContain('prentice');
  });

  it('auto-adds the missing speaker when retries still miss', async () => {
    const call = vi.fn(async () => ({ characters: [{ id: 'kenric', name: 'Kenric' }] }));
    const onAutoAdd = vi.fn();
    const res = await runStage1WithRosterGuard({
      body: PRENTICE_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 1,
      onAutoAdd,
    });
    expect(call).toHaveBeenCalledTimes(2); // 1 + 1 retry
    expect(res.autoAdded.map((m) => m.id)).toContain('prentice');
    const prentice = res.result.characters.find((c) => c.id === 'prentice')!;
    expect(prentice.name).toBe('Prentice');
    expect(onAutoAdd).toHaveBeenCalledOnce();
  });

  it('does not retry or add when coverage is already clean', async () => {
    const call = vi.fn(async () => ({
      characters: [{ id: 'kenric', name: 'Kenric' }, { id: 'prentice', name: 'Prentice' }],
    }));
    const res = await runStage1WithRosterGuard({
      body: PRENTICE_BODY,
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
      body: PRENTICE_BODY,
      rosterNamesFor: (r) => r.characters.map((c) => c.name),
      call,
      makeCharacter: makeChar,
      maxRetries: 0,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.autoAdded.map((m) => m.id)).toContain('prentice');
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
    expect(toKebabId('Mr. Forkle')).toBe('mr-forkle');
    expect(toKebabId('Prentice')).toBe('prentice');
  });
});
