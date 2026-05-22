/* .queue.json schema versioning + migration seam (plan 102).
 *
 * Mirrors `state-migrate.ts` shape exactly so the workspace queue file gets
 * the same migrate-vs-reject contract every persisted-state file in the
 * workspace shares.
 *
 * Today CURRENT_QUEUE_SCHEMA = 1. Reads of legacy files (none exist yet —
 * .queue.json is net-new) without the field are treated as v1 by default.
 * Reads of `schema > 1` throw UnsupportedQueueSchemaError so the server
 * refuses to silently drop fields a newer client wrote.
 *
 * Slot intentionally so Must-#1 (in-app upgrade pathway) can pull this into
 * its broader migration family alongside cast-migrate, manuscript-edits-migrate,
 * etc. without re-shaping the queue file. */

import type { QueueFile } from './queue-io.js';
import { writeJsonAtomic, readJson } from './state-io.js';

export const CURRENT_QUEUE_SCHEMA = 1;

export class UnsupportedQueueSchemaError extends Error {
  constructor(
    public readonly observedSchema: number,
    public readonly currentSchema: number,
  ) {
    super(
      `.queue.json declares schema=${observedSchema} but this server only understands up to schema=${currentSchema}. ` +
        `Refusing to read the file — upgrade the server to a version that knows schema=${observedSchema} before mutating the queue.`,
    );
    this.name = 'UnsupportedQueueSchemaError';
  }
}

/** Run a raw parsed .queue.json document through the migration seam.
 *  Returns a QueueFile stamped with CURRENT_QUEUE_SCHEMA on success.
 *  Throws for unsupported future versions. Absence of the `schema` field
 *  is treated as v1 (back-compat). */
export function migrateQueueJson(raw: unknown): QueueFile & { schema: number } {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('.queue.json: expected a JSON object at the top level');
  }
  const doc = raw as { schema?: unknown } & Record<string, unknown>;
  const declared = typeof doc.schema === 'number' ? doc.schema : 1;

  if (declared === CURRENT_QUEUE_SCHEMA) {
    return { ...(doc as unknown as QueueFile), schema: CURRENT_QUEUE_SCHEMA };
  }
  if (declared > CURRENT_QUEUE_SCHEMA) {
    throw new UnsupportedQueueSchemaError(declared, CURRENT_QUEUE_SCHEMA);
  }
  /* declared < CURRENT — no path today (field-absent treated as v1
     above); becomes the v1 → v2 transform when CURRENT bumps. */
  throw new Error(
    `No migration registered from .queue.json schema=${declared} to ${CURRENT_QUEUE_SCHEMA}. ` +
      `Add a transform in server/src/workspace/queue-migrate.ts.`,
  );
}

export function stampQueueSchema<T extends QueueFile>(file: T): T & { schema: number } {
  return { ...file, schema: CURRENT_QUEUE_SCHEMA };
}

/** Read .queue.json, run it through the migration seam, return the stamped
 *  in-memory shape. Returns an empty queue when the file is absent (first
 *  read on a workspace that pre-dates plan 102 — no orphan handling needed
 *  because the file is net-new). */
export async function readQueueFile(path: string): Promise<QueueFile> {
  const raw = await readJson<unknown>(path);
  if (raw == null) {
    return { entries: [], paused: false, schema: CURRENT_QUEUE_SCHEMA };
  }
  return migrateQueueJson(raw);
}

/** Stamp + atomic-write .queue.json. Bare `writeJsonAtomic` (no rotation)
 *  because the queue is cheap to re-derive — losing it sets the queue back
 *  to "what the on-disk audio files say is done"; the user re-enqueues
 *  what they still want. Not worth the rotating-backups multiplier. */
export async function writeQueueFile(path: string, file: QueueFile): Promise<void> {
  await writeJsonAtomic(path, stampQueueSchema(file));
}
