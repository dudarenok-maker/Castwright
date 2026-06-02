/* fs-1 — generic per-file schema-versioning seam for the workspace JSON files
   that don't yet have one (cast.json, manuscript-edits.json, revisions.json,
   listen-progress.json, and the workspace-level voices.json).

   state.json got its own bespoke seam in plan 27 (state-migrate.ts) and keeps
   it — it carries the load-bearing rotating-backup contract. The files here are
   cheaper to re-derive on loss, so they share ONE generic migrator instead of
   five near-identical copies of the state-migrate.ts shape.

   The contract mirrors state-migrate.ts exactly:
     - A doc with no `schema` field is interpreted as v1 (every file written
       before this seam landed lacks it — absence-means-v1 keeps them loading).
     - A doc at the current schema is a no-op (identity).
     - A doc with schema > current throws UnsupportedSchemaError — the server
       refuses to read a file a newer version wrote, rather than silently
       dropping fields it doesn't understand on the next edit.
     - A doc with schema < current routes to a registered transform. Today every
       seam is at CURRENT = 1, so there is nothing older than v1 and no transform
       exists yet — this is the plumbing where the FIRST non-additive change to
       any of these files plugs in (per the plan-27 rename-vs-add policy).

   NB (fs-1 scope decision): writers do NOT yet route through stampSchema — the
   path resolvers are used at ~24 call sites and threading a stamp through all of
   them is out of scope for the v1 plumbing. Because absence-means-v1, an
   unstamped file still migrates correctly. When the first real schema bump
   lands, that change adds the writer-side stamp alongside its transform (where
   it's actually load-bearing and testable against a real migration). */

export type SchemaSeamKind = 'book' | 'workspace';

export interface SchemaSeam {
  /** Human label used in errors + the migration log, e.g. 'cast.json'. */
  label: string;
  /** The schema version this server understands. Bump when a non-additive
      change lands, and add the transform branch in migrateSeamDoc below. */
  current: number;
  /** Whether the file lives per-book (under each .audiobook/) or once at the
      workspace root. Drives how the coordinator enumerates it. */
  kind: SchemaSeamKind;
}

/** The five seams fs-1 introduces. All at v1 today (identity migrations). */
export const SCHEMA_SEAMS: SchemaSeam[] = [
  { label: 'cast.json', current: 1, kind: 'book' },
  { label: 'manuscript-edits.json', current: 1, kind: 'book' },
  { label: 'revisions.json', current: 1, kind: 'book' },
  { label: 'listen-progress.json', current: 1, kind: 'book' },
  { label: 'voices.json', current: 1, kind: 'workspace' },
];

export class UnsupportedSchemaError extends Error {
  constructor(
    public readonly label: string,
    public readonly observedSchema: number,
    public readonly currentSchema: number,
  ) {
    super(
      `${label} declares schema=${observedSchema} but this server only understands up to schema=${currentSchema}. ` +
        `Refusing to read it — upgrade the server before editing this book.`,
    );
    this.name = 'UnsupportedSchemaError';
  }
}

/** Result of running one doc through the seam. `changed` is true only when the
    migrator produced a doc that differs from disk (a real transform), so the
    coordinator can skip rewriting files it didn't actually migrate. */
export interface MigrateOutcome {
  doc: Record<string, unknown>;
  changed: boolean;
}

/** Run a raw parsed document through a seam. Pure. Throws on a future schema or
    an unregistered older one. At CURRENT = 1 every well-formed doc is identity. */
export function migrateSeamDoc(seam: SchemaSeam, raw: unknown): MigrateOutcome {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(`${seam.label}: expected a JSON object at the top level`);
  }
  const doc = raw as { schema?: unknown } & Record<string, unknown>;
  const declared = typeof doc.schema === 'number' ? doc.schema : 1;

  if (declared === seam.current) {
    // Identity. Only a doc MISSING the stamp would change (gain schema), but we
    // report changed=false there too — see the writer-stamp scope note above;
    // re-stamping every file on every boot is churn for no current benefit.
    return { doc, changed: false };
  }
  if (declared > seam.current) {
    throw new UnsupportedSchemaError(seam.label, declared, seam.current);
  }
  // declared < current — the first real migration plugs in here:
  //   if (seam.label === 'cast.json' && declared === 1) { ...v1→v2...; changed = true }
  throw new Error(
    `No migration registered for ${seam.label} schema=${declared} → ${seam.current}. ` +
      `Add a transform in server/src/workspace/schema-migrate.ts.`,
  );
}

/** Stamp the current schema on a doc before writing. The writer-side seam —
    wired in by the first real schema bump (see scope note above). */
export function stampSeamSchema(seam: SchemaSeam, doc: Record<string, unknown>): Record<string, unknown> {
  return { ...doc, schema: seam.current };
}
