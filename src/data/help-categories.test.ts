import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES } from './help-categories';
import { HELP_FAILURE_ENTRIES, type CategoryId } from './help-failures';
import { HELP_TOPICS } from './help-topics';

const IDS = new Set<CategoryId>(HELP_CATEGORIES.map((c) => c.id));

describe('help categories', () => {
  it('every failure entry has a category in HELP_CATEGORIES', () => {
    for (const e of HELP_FAILURE_ENTRIES) {
      expect(IDS.has(e.category), `${e.code} -> ${e.category}`).toBe(true);
    }
  });
  it('every topic has a category in HELP_CATEGORIES', () => {
    for (const t of HELP_TOPICS) {
      expect(IDS.has(t.category), `${t.id} -> ${t.category}`).toBe(true);
    }
  });
  it('every category id is unique and non-empty', () => {
    expect(IDS.size).toBe(HELP_CATEGORIES.length);
    expect(HELP_CATEGORIES.every((c) => c.label.length > 0)).toBe(true);
  });
  it('has exactly 45 items (19 failures + 26 topics)', () => {
    expect(HELP_FAILURE_ENTRIES.length + HELP_TOPICS.length).toBe(45);
  });
});
