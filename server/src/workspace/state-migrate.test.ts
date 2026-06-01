/* Pairs with docs/features/archive/27-book-state-persistence.md.
 *
 * Pins the migration seam contract: CURRENT_STATE_SCHEMA is 1 today;
 * legacy files without the field load as v1; explicitly v1-stamped
 * files no-op; v2-stamped files throw UnsupportedStateSchemaError
 * (forward-incompatibility guard).
 *
 * The round-trip "write → read raw → schema present" assertion lives
 * in book-state.test.ts (it needs the route + filesystem); this file
 * stays pure-unit. */

import { describe, it, expect } from 'vitest';
import {
  CURRENT_STATE_SCHEMA,
  migrateStateJson,
  stampStateSchema,
  UnsupportedStateSchemaError,
} from './state-migrate.js';
import type { BookStateJson } from './scan.js';

const baseState: BookStateJson = {
  bookId: 'b1',
  manuscriptId: 'm1',
  title: 'T',
  author: 'A',
  series: 'S',
  seriesPosition: 1,
  isStandalone: false,
  manuscriptFile: 'manuscript.epub',
  castConfirmed: false,
  chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
  coverGradient: ['#000', '#fff'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('CURRENT_STATE_SCHEMA', () => {
  it('is 1', () => {
    /* Sanity check — bumping this constant requires adding a real
       migration branch in migrateStateJson AND updating plan 27's
       rename-vs-add policy doc. */
    expect(CURRENT_STATE_SCHEMA).toBe(1);
  });
});

describe('stampStateSchema', () => {
  it('stamps the current schema on a fresh state', () => {
    const result = stampStateSchema(baseState);
    expect(result.schema).toBe(1);
  });

  it('overwrites a stale schema field on write (defends against re-writing a v2 doc with the wrong stamp)', () => {
    /* If a future version somehow round-trips through stampStateSchema
       with a different schema value, the stamp must win. Stamping is
       the only path to the on-disk file; it always reflects what the
       writer thinks it's producing. */
    const result = stampStateSchema({ ...baseState, schema: 99 } as BookStateJson);
    expect(result.schema).toBe(1);
  });

  it('preserves every other field unchanged', () => {
    const result = stampStateSchema(baseState);
    expect(result.bookId).toBe(baseState.bookId);
    expect(result.chapters).toEqual(baseState.chapters);
    expect(result.coverGradient).toEqual(baseState.coverGradient);
  });
});

describe('migrateStateJson', () => {
  it('treats a legacy file (no schema field) as v1 and stamps the current schema', () => {
    /* Every state.json written before this seam landed has no schema
       field. Treating absence as v1 lets them load unchanged. */
    const legacy = { ...baseState };
    const result = migrateStateJson(legacy);
    expect(result.schema).toBe(1);
    expect(result.bookId).toBe('b1');
  });

  it('returns a v1-stamped doc unchanged (no-op migration)', () => {
    const v1 = { ...baseState, schema: 1 };
    const result = migrateStateJson(v1);
    expect(result.schema).toBe(1);
  });

  it('throws UnsupportedStateSchemaError on a deliberately-bumped v2 fixture', () => {
    /* The seam: the migration function must REJECT future-version
       files rather than silently dropping fields it doesn't know
       about. The first non-additive change bumps CURRENT_STATE_SCHEMA
       to 2 and adds a real v1 → v2 branch; until then v2 reads are
       hard errors. */
    const v2 = { ...baseState, schema: 2 };
    expect(() => migrateStateJson(v2)).toThrow(UnsupportedStateSchemaError);
    /* Error carries both versions so the surfaced message can ask the
       user to upgrade. */
    try {
      migrateStateJson(v2);
    } catch (e) {
      expect((e as UnsupportedStateSchemaError).observedSchema).toBe(2);
      expect((e as UnsupportedStateSchemaError).currentSchema).toBe(1);
    }
  });

  it('throws for non-object input (defensive against malformed JSON)', () => {
    expect(() => migrateStateJson(null)).toThrow();
    expect(() => migrateStateJson('not an object')).toThrow();
    expect(() => migrateStateJson(42)).toThrow();
  });

  it('throws for a schema older than CURRENT (no migration registered yet)', () => {
    /* No path exists today because field-absent already covers the
       only pre-v1 case. A schema = 0 would be a user-corrupted file. */
    expect(() => migrateStateJson({ ...baseState, schema: 0 })).toThrow(/No migration registered/);
  });

  it('preserves the fs-2 language field without bumping the schema (additive field)', () => {
    /* `language` is an additive optional field — per the plan-27 rename-vs-add
       policy it does NOT bump CURRENT_STATE_SCHEMA. A legacy file with no
       language still loads (reads back 'en' at the bookStateLanguage seam);
       a 'ru' value round-trips through migrate + stamp unchanged. */
    const legacy = migrateStateJson({ ...baseState });
    expect(legacy.language).toBeUndefined();
    expect(legacy.schema).toBe(1);

    const russian = stampStateSchema(migrateStateJson({ ...baseState, language: 'ru' }));
    expect(russian.language).toBe('ru');
    expect(russian.schema).toBe(1);
  });
});
