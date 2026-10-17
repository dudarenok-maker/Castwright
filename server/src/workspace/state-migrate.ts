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
 * docs/features/archive/27-book-state-persistence.md):
 *   - Adding an OPTIONAL field is backwards-compatible. No schema bump.
 *     The old reader ignores the new field; the new writer keeps writing
 *     it. This is the common case.
 *   - Renaming a field, removing a field that older clients still read,
 *     or changing the semantics of a field (e.g. units, encoding, type
 *     widening) breaks readers. Bump CURRENT_STATE_SCHEMA and add a
 *     migration branch below.
 *
 * Pairs with docs/features/archive/27-book-state-persistence.md. */

import type { BookStateJson } from './scan.js';
import { writeJsonAtomic, readJsonWithRecovery } from './state-io.js';
import { withStateJsonLock } from './file-lock.js';

/** The shape writeStateJsonAtomic accepts. Identical to BookStateJson except
 *  `language` is REQUIRED and explicitly nullable: a writer must state the
 *  language or state that there isn't one. `undefined` — "I didn't think about
 *  it" — is not expressible, which is the whole point. BookStateJson keeps
 *  `language?: string` because that is the truth about disk. */
export type BookStateJsonWrite = Omit<BookStateJson, 'language'> & { language: string | null };

export const CURRENT_STATE_SCHEMA = 1;

/** Thrown when state.json declares a schema newer than the server's
 *  CURRENT_STATE_SCHEMA. The server refuses to interpret it to avoid
 *  silently dropping fields a newer client wrote. The caller should
 *  surface this to the user as "please upgrade the server" rather than
 *  retrying. */
export class UnsupportedStateSchemaError extends Error {
  constructor(
    public readonly observedSchema: number,
    public readonly currentSchema: number,
  ) {
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
export async function writeStateJsonAtomic(path: string, state: BookStateJsonWrite): Promise<void> {
  await writeJsonAtomic(
    path,
    /* Stamp the schema inline (not via stampStateSchema): a writer's explicit
       `language: null` — "stated absence" — must survive to disk verbatim
       (Task 3 relies on a surrendered book being written with a literal
       `null`, key present; stampStateSchema's `T extends BookStateJson`
       constraint rejects `language: string | null`). */
    { ...state, schema: CURRENT_STATE_SCHEMA },
    {
      rotate: { keep: STATE_BACKUP_KEEP },
    },
  );
}

/** #3700 — the ONE locked read-modify-write of state.json for call sites that
 *  patch a field or two onto whatever is on disk. Takes the per-book
 *  `state-json` leaf lock, re-reads state.json INSIDE it (never the caller's
 *  earlier snapshot, which a sibling chapter render may have stamped past),
 *  hands that fresh document to `mutate`, and writes the result. `mutate`
 *  returning `null` means "nothing to change" and skips the write. When the
 *  file is absent nothing is written (a delete/move raced us) and the result is
 *  `null` — "absent" is its own outcome, so a mutating caller must refuse
 *  (404) rather than answer success for a write that did not happen, while a
 *  read-path caller may fall back to its own snapshot. Leaf lock: `mutate` must not take
 *  another lock or call something that does. Returns the document that is on
 *  disk afterwards (the mutated one, or the fresh read when `mutate` declined),
 *  or `null` when state.json is absent. */
export async function updateStateJsonLocked(
  path: string,
  mutate: (fresh: BookStateJson) => BookStateJson | null | Promise<BookStateJson | null>,
  /** Runs inside the lock, only once state.json is known present and `mutate`
   *  has produced a change, immediately before the write. For a caller whose
   *  other disk writes must not happen unless the book is still there. */
  beforeWrite?: () => Promise<void>,
): Promise<BookStateJson | null> {
  return withStateJsonLock(path, async () => {
    const onDisk = await readStateJsonWithRecovery(path);
    /* Absent means the book was deleted or moved after the caller resolved it:
       writing would recreate `.audiobook/` (writeJsonAtomic mkdirs) and bring
       a deleted book back. Skip the write and report absence as `null`. */
    if (!onDisk) return null;
    const fresh = onDisk;
    const next = await mutate(fresh);
    if (!next) return fresh;
    if (beforeWrite) await beforeWrite();
    await writeStateJsonAtomic(path, { ...next, language: next.language ?? null });
    return next;
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
export async function readStateJsonWithRecovery(path: string): Promise<BookStateJson | null> {
  return readJsonWithRecovery<BookStateJson>(path, { keep: STATE_BACKUP_KEEP });
}
