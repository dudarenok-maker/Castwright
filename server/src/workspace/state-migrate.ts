/* state.json schema versioning + migration seam.
 *
 * Every persisted-state system that skipped versioning regrets it on the
 * first non-additive change. This module stamps `schema: 1` on every
 * write, asserts the read-side doesn't mistake a future-version file for
 * a v1 file, and provides the seam where a real 1 → 2 migration would
 * land if the field set ever shifts in a non-additive way.
 *
 * Today CURRENT_STATE_SCHEMA = 1. Reads of legacy files that lack the
 * field at all are treated as v1 by default (back-compat for every
 * state.json on disk before this seam landed). Reads of explicitly
 * v1-stamped files are no-ops. Reads of `schema > 1` throw
 * UnsupportedStateSchemaError — the server will not silently read a
 * file written by a newer version it doesn't understand, because doing
 * so risks dropping fields it doesn't know about when the user next
 * edits the book.
 *
 * Rename-vs-add policy (documented in
 * docs/features/27-book-state-persistence.md):
 *   - Adding an OPTIONAL field is backwards-compatible. No schema bump.
 *     The old reader ignores the new field; the new writer keeps writing
 *     it. This is the common case.
 *   - Renaming a field, removing a field that older clients still read,
 *     or changing the semantics of a field (e.g. units, encoding, type
 *     widening) breaks readers. Bump CURRENT_STATE_SCHEMA and add a
 *     migration branch below.
 *
 * Pairs with docs/features/27-book-state-persistence.md. */

import type { BookStateJson } from './scan.js';
import { writeJsonAtomic, readJsonWithRecovery } from './state-io.js';

export const CURRENT_STATE_SCHEMA = 1;

/** Thrown when state.json declares a schema newer than the server's
 *  CURRENT_STATE_SCHEMA. The server refuses to interpret it to avoid
 *  silently dropping fields a newer client wrote. The caller should
 *  surface this to the user as "please upgrade the server" rather than
 *  retrying. */
export class UnsupportedStateSchemaError extends Error {
  constructor(public readonly observedSchema: number, public readonly currentSchema: number) {
    super(
      `state.json declares schema=${observedSchema} but this server only understands up to schema=${currentSchema}. ` +
      `Refusing to read the file — upgrade the server to a version that knows schema=${observedSchema} before editing this book.`,
    );
    this.name = 'UnsupportedStateSchemaError';
  }
}

/** Run a raw parsed state.json document through the migration seam.
 *  Returns a BookStateJson stamped with CURRENT_STATE_SCHEMA on success.
 *  Throws for unrecognised input or unsupported future versions.
 *
 *  Legacy back-compat: a doc without the `schema` field is interpreted
 *  as v1 (the original format). Every state.json written by a server
 *  before this seam landed will lack the field; treating them as v1 lets
 *  them load unchanged.
 *
 *  Future migrations: when CURRENT_STATE_SCHEMA bumps to 2, add a
 *  branch that transforms v1 → v2 (renaming / encoding / etc.). The
 *  caller path (readers in book-state.ts, scan.ts, etc.) stays
 *  unchanged because they always get back a doc stamped at the current
 *  schema. */
export function migrateStateJson(raw: unknown): BookStateJson & { schema: number } {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('state.json: expected a JSON object at the top level');
  }
  const doc = raw as { schema?: unknown } & Record<string, unknown>;

  /* Pre-seam files have no `schema` field — they're all v1 by
     construction (there was only one shape). Treat absence as v1
     rather than throwing so existing books keep loading. */
  const declared = typeof doc.schema === 'number' ? doc.schema : 1;

  if (declared === CURRENT_STATE_SCHEMA) {
    return { ...(doc as unknown as BookStateJson), schema: CURRENT_STATE_SCHEMA };
  }
  if (declared > CURRENT_STATE_SCHEMA) {
    throw new UnsupportedStateSchemaError(declared, CURRENT_STATE_SCHEMA);
  }
  /* declared < CURRENT_STATE_SCHEMA — a real migration would route
     here. When schema 2 ships, this branch becomes the v1 → v2
     transform. Today there's no path because there's nothing older
     than v1 (we treat field-absent as v1 above). */
  throw new Error(
    `No migration registered from state.json schema=${declared} to ${CURRENT_STATE_SCHEMA}. ` +
    `Add a transform in server/src/workspace/state-migrate.ts.`,
  );
}

/** Stamp the current schema on a state.json document before writing.
 *  All writers must route through this — without the stamp, a fresh
 *  v1 file would be indistinguishable from a legacy field-absent file,
 *  defeating the seam the moment we bump to v2. */
export function stampStateSchema<T extends BookStateJson>(state: T): T & { schema: number } {
  return { ...state, schema: CURRENT_STATE_SCHEMA };
}

/** How many prior `state.json` snapshots to keep on disk per book.
 *  Three slots cover the realistic recovery window: the last completed
 *  write, the one before it, and one earlier — enough to undo a
 *  schema-migration bug or a torn OneDrive write without ballooning
 *  workspace size. Tune up only with a clear motivating incident. */
export const STATE_BACKUP_KEEP = 3;

/** Stamp + atomic-write state.json with rotating backups. Use at every
 *  state.json write site — the cheapest insurance against a torn write,
 *  a schema-migration bug, or an OneDrive race that survives
 *  rename-retry. Other .audiobook/*.json files (cast.json,
 *  revisions.json, ...) stay on the bare `writeJsonAtomic` shape:
 *  they're cheaper to re-derive on loss and not worth the disk
 *  multiplier. */
export async function writeStateJsonAtomic(path: string, state: BookStateJson): Promise<void> {
  await writeJsonAtomic(path, stampStateSchema(state), {
    rotate: { keep: STATE_BACKUP_KEEP },
  });
}

/** Read state.json with backup recovery. On a torn / corrupt main
 *  file, the next-newest backup parses and the read succeeds with a
 *  single warning logged. Use at any read site that already wants the
 *  read to succeed against best-effort recovery (the library scan
 *  helpers in scan.ts — corrupt state.json there silently hides a
 *  book today; recovery lets the book stay visible). Direct strict
 *  reads via `readJson` are still valid for callers that prefer the
 *  fast-fail diagnostic. */
export async function readStateJsonWithRecovery(
  path: string,
): Promise<BookStateJson | null> {
  return readJsonWithRecovery<BookStateJson>(path, { keep: STATE_BACKUP_KEEP });
}
