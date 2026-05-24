import { describe, it, expect } from 'vitest';
import { selectPrincipalCast } from './principal-cast';

describe('selectPrincipalCast', () => {
  it('excludes the narrator even when it has the most lines', () => {
    const chars = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ];
    const lines = { narrator: 1000, a: 80, b: 20 };
    const result = selectPrincipalCast(chars, lines);
    expect(result.has('narrator')).toBe(false);
    /* 80% of (80+20)=100 → target 80. Alice (80) reaches it alone. */
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
  });

  it('excludes a narrator detected by name (non-canonical id)', () => {
    const chars = [
      { id: 'char-99', name: 'Narrator' },
      { id: 'a', name: 'Alice' },
    ];
    const lines = { 'char-99': 500, a: 100 };
    const result = selectPrincipalCast(chars, lines);
    expect(result.has('char-99')).toBe(false);
    expect(result.has('a')).toBe(true);
  });

  it('accumulates the smallest set covering 80% of non-narrator lines', () => {
    const chars = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
    ];
    /* total 100; target 80. a(50)+b(30)=80 ≥ 80 → stop. */
    const lines = { a: 50, b: 30, c: 15, d: 5 };
    const result = selectPrincipalCast(chars, lines);
    expect([...result].sort()).toEqual(['a', 'b']);
  });

  it('keeps pulling speakers in until the threshold is reached (<80% concentrated)', () => {
    const chars = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    /* Evenly spread 20 each; total 100; target 80. Need 4 of 5. */
    const lines = { a: 20, b: 20, c: 20, d: 20, e: 20 };
    const result = selectPrincipalCast(chars, lines);
    expect(result.size).toBe(4);
  });

  it('breaks ties by id for deterministic ordering', () => {
    const chars = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    const lines = { a: 40, b: 40, c: 20 };
    /* target 80; a and b tie at 40. id-sorted → a first, then b → both
       selected (40+40=80 ≥ 80). c excluded. */
    const result = selectPrincipalCast(chars, lines);
    expect([...result].sort()).toEqual(['a', 'b']);
  });

  it('returns an empty set when there are no non-narrator lines', () => {
    const chars = [{ id: 'narrator', name: 'Narrator' }, { id: 'a' }];
    const lines = { narrator: 100, a: 0 };
    expect(selectPrincipalCast(chars, lines).size).toBe(0);
  });

  it('ignores zero-line speakers — they cannot advance coverage', () => {
    const chars = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    /* a alone is 100% of lines; b and c are silent. */
    const lines = { a: 100, b: 0, c: 0 };
    const result = selectPrincipalCast(chars, lines);
    expect([...result]).toEqual(['a']);
  });

  it('honours a custom thresholdPct', () => {
    const chars = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const lines = { a: 50, b: 30, c: 20 };
    /* target 50% of 100 = 50. a(50) ≥ 50 alone. */
    const result = selectPrincipalCast(chars, lines, { thresholdPct: 0.5 });
    expect([...result]).toEqual(['a']);
  });

  it('clamps an out-of-range thresholdPct', () => {
    const chars = [{ id: 'a' }, { id: 'b' }];
    const lines = { a: 60, b: 40 };
    /* thresholdPct > 1 clamps to 1 → must cover everyone. */
    expect(selectPrincipalCast(chars, lines, { thresholdPct: 2 }).size).toBe(2);
    /* thresholdPct < 0 clamps to 0 → target 0, no one needed. */
    expect(selectPrincipalCast(chars, lines, { thresholdPct: -1 }).size).toBe(0);
  });
});
