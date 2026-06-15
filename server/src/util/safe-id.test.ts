/* Canonical, deterministic, filename-safe id generation (plan 219).

   The pre-219 slugifiers (`toKebabId`, `bookIdFromTitle`, the cross-book
   `normaliseToken`s) all normalised with `[^a-z0-9]`, which deletes every
   non-Latin character — so a Cyrillic name collapsed to an empty/colliding id
   or match-key. These pin the replacement seam:
     - ASCII (and accented-Latin) output is byte-identical to the legacy slug, so
       existing English books see ZERO id churn,
     - non-Latin letters are PRESERVED (no lossy transliteration),
     - ids are non-empty, deterministic, and collision-free,
     - the cross-book match key is Unicode-EXACT (distinct Cyrillic names never
       collide). */

import { describe, it, expect } from 'vitest';
import { safeId, safeBookId, normaliseNameKey } from './safe-id.js';

/* The exact legacy toKebabId (roster-coverage.ts pre-219) — the oracle the new
   helper must match for every ASCII / accented-Latin name. */
function legacyToKebabId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('safeId', () => {
  it('is byte-identical to the legacy slug for ASCII names (no English churn)', () => {
    for (const n of ['Master Oduvan', 'Wren', 'Tam Hollis', 'Coalfall Dragon', "Mr. O'Brien"]) {
      expect(safeId(n)).toBe(legacyToKebabId(n));
    }
  });

  it('is byte-identical to the legacy slug for accented-Latin names', () => {
    for (const n of ['André', 'Renée', 'Zoë', 'Núñez']) {
      expect(safeId(n)).toBe(legacyToKebabId(n));
    }
  });

  it('is idempotent', () => {
    for (const n of ['Master Oduvan', 'Анна', 'André', '李雷']) {
      expect(safeId(safeId(n))).toBe(safeId(n));
    }
  });

  it('preserves Cyrillic letters instead of erasing them', () => {
    expect(safeId('Анна')).toBe('анна');
    expect(safeId('Мастер Одуван')).toBe('мастер-одуван');
  });

  it('gives two distinct Cyrillic names two distinct ids', () => {
    expect(safeId('Анна')).not.toBe(safeId('Мария'));
  });

  it('falls back to a stable non-empty id for an unrenderable / punctuation-only name', () => {
    const a = safeId('!!!');
    expect(a).toMatch(/^char-[a-z0-9]+$/);
    expect(safeId('!!!')).toBe(a); // stable across calls
    const cjk = safeId('李雷'); // CJK letters ARE \p{L}, so this is preserved, not hashed
    expect(cjk).toBe('李雷');
  });

  it('disambiguates a collision deterministically (name-keyed, not order-keyed)', () => {
    const taken = new Set(['anna']);
    const first = safeId('Anna!', { taken }); // kebabs to "anna", already taken
    const again = safeId('Anna!', { taken }); // same inputs → same suffix
    expect(first).not.toBe('anna');
    expect(first).toBe(again);
    expect(first.startsWith('anna-')).toBe(true);
  });

  it('honours a custom fallback prefix', () => {
    expect(safeId('???', { prefix: 'book' })).toMatch(/^book-[a-z0-9]+$/);
  });
});

describe('safeBookId', () => {
  it('matches the legacy book slug for ASCII titles, capped at 32', () => {
    expect(safeBookId('The Coalfall Commission')).toBe('the-coalfall-commission');
    expect(safeBookId('')).toBe('book');
  });

  it('never cuts mid-token into a trailing hyphen at the 32-char cap', () => {
    const id = safeBookId('The Extraordinarily Lengthy Adventures of Somebody');
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id.endsWith('-')).toBe(false);
  });

  it('preserves a Cyrillic title instead of collapsing to "book"', () => {
    expect(safeBookId('Война и мир')).not.toBe('book');
    expect(safeBookId('Война и мир')).toBe('война-и-мир');
  });
});

describe('normaliseNameKey', () => {
  it('is byte-identical to the legacy ASCII key', () => {
    const legacy = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const n of ['Master Oduvan', "Mr. O'Brien", 'Wren-Sparrow']) {
      expect(normaliseNameKey(n)).toBe(legacy(n));
    }
  });

  it('bridges casing/punctuation for Cyrillic (same person across books)', () => {
    expect(normaliseNameKey('Анна')).toBe(normaliseNameKey('анна!'));
  });

  it('does NOT merge two distinct Cyrillic names (no lossy transliteration)', () => {
    expect(normaliseNameKey('Анна')).not.toBe(normaliseNameKey('Аня'));
  });

  it('returns empty for nullish / empty input', () => {
    expect(normaliseNameKey(undefined)).toBe('');
    expect(normaliseNameKey('')).toBe('');
  });
});
