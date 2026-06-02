/* fs-1 — pin the generic schema-migration seam. Mirrors state-migrate.test.ts:
   absence-means-v1, identity at current, refuse a future schema, reject a
   non-object. All five seams are v1 today (identity). */

import { describe, it, expect } from 'vitest';
import {
  migrateSeamDoc,
  stampSeamSchema,
  UnsupportedSchemaError,
  SCHEMA_SEAMS,
  type SchemaSeam,
} from './schema-migrate.js';

const cast = SCHEMA_SEAMS.find((s) => s.label === 'cast.json') as SchemaSeam;

describe('migrateSeamDoc', () => {
  it('treats a doc with no schema field as v1 (identity, unchanged)', () => {
    const raw = { characters: [{ id: 'a' }] };
    const out = migrateSeamDoc(cast, raw);
    expect(out.changed).toBe(false);
    expect(out.doc).toBe(raw);
  });

  it('is an identity no-op for a doc already stamped at the current schema', () => {
    const out = migrateSeamDoc(cast, { schema: 1, characters: [] });
    expect(out.changed).toBe(false);
    expect(out.doc.schema).toBe(1);
  });

  it('refuses a schema newer than the server understands', () => {
    expect(() => migrateSeamDoc(cast, { schema: 2 })).toThrow(UnsupportedSchemaError);
    try {
      migrateSeamDoc(cast, { schema: 99 });
    } catch (e) {
      expect((e as UnsupportedSchemaError).label).toBe('cast.json');
      expect((e as UnsupportedSchemaError).observedSchema).toBe(99);
    }
  });

  it('rejects a non-object top level', () => {
    expect(() => migrateSeamDoc(cast, null)).toThrow(/expected a JSON object/);
    expect(() => migrateSeamDoc(cast, [1, 2, 3] as unknown)).not.toThrow(); // arrays are objects; treated as v1
  });
});

describe('stampSeamSchema', () => {
  it('stamps the seam current schema on a doc', () => {
    expect(stampSeamSchema(cast, { characters: [] }).schema).toBe(1);
  });
});

describe('SCHEMA_SEAMS', () => {
  it('covers the five fs-1 files, all at v1 today', () => {
    expect(SCHEMA_SEAMS.map((s) => s.label).sort()).toEqual([
      'cast.json',
      'listen-progress.json',
      'manuscript-edits.json',
      'revisions.json',
      'voices.json',
    ]);
    for (const seam of SCHEMA_SEAMS) expect(seam.current).toBe(1);
  });
});
