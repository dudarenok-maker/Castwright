/* Schema-versioning + atomic R/W tests for .queue.json (plan 102). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  CURRENT_QUEUE_SCHEMA,
  UnsupportedQueueSchemaError,
  migrateQueueJson,
  readQueueFile,
  stampQueueSchema,
  writeQueueFile,
} from './queue-migrate.js';
import { writeJsonAtomic } from './state-io.js';
import type { QueueFile } from './queue-io.js';

let workdir: string;
let queuePath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'queue-migrate-'));
  queuePath = join(workdir, '.queue.json');
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('migrateQueueJson', () => {
  it('stamps the current schema on a v1 document', () => {
    const doc = { entries: [], paused: false, schema: 1 };
    const result = migrateQueueJson(doc);
    expect(result.schema).toBe(CURRENT_QUEUE_SCHEMA);
    expect(result.entries).toEqual([]);
  });

  it('treats a field-absent document as v1 (back-compat)', () => {
    const doc = { entries: [], paused: true };
    const result = migrateQueueJson(doc);
    expect(result.schema).toBe(CURRENT_QUEUE_SCHEMA);
    expect(result.paused).toBe(true);
  });

  it('throws UnsupportedQueueSchemaError for a future version', () => {
    const doc = { entries: [], paused: false, schema: 999 };
    expect(() => migrateQueueJson(doc)).toThrow(UnsupportedQueueSchemaError);
  });

  it('rejects non-object inputs', () => {
    expect(() => migrateQueueJson(null)).toThrowError(/expected a JSON object/);
    expect(() => migrateQueueJson('queue')).toThrowError(/expected a JSON object/);
    expect(() => migrateQueueJson(42)).toThrowError(/expected a JSON object/);
  });
});

describe('stampQueueSchema', () => {
  it('always writes the current schema, overwriting any existing schema field', () => {
    const stamped = stampQueueSchema({ entries: [], paused: false, schema: 999 });
    expect(stamped.schema).toBe(CURRENT_QUEUE_SCHEMA);
  });
});

describe('readQueueFile / writeQueueFile round-trip', () => {
  it('returns an empty queue when the file is absent', async () => {
    const file = await readQueueFile(queuePath);
    expect(file.entries).toEqual([]);
    expect(file.paused).toBe(false);
    expect(file.schema).toBe(CURRENT_QUEUE_SCHEMA);
  });

  it('writes + reads round-trip, stamping schema on write', async () => {
    const payload: QueueFile = {
      entries: [
        {
          id: 'e1',
          bookId: 'book-A',
          chapterId: 3,
          scope: 'this',
          addedAt: '2026-05-23T00:00:00.000Z',
          status: 'queued',
          order: 0,
        },
      ],
      paused: false,
    };
    await writeQueueFile(queuePath, payload);

    /* Inspect the raw on-disk JSON to confirm schema is stamped. */
    const raw = JSON.parse(await readFile(queuePath, 'utf8'));
    expect(raw.schema).toBe(CURRENT_QUEUE_SCHEMA);

    const read = await readQueueFile(queuePath);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0].id).toBe('e1');
    expect(read.schema).toBe(CURRENT_QUEUE_SCHEMA);
  });

  it('refuses to read a file declaring a future schema', async () => {
    await writeJsonAtomic(queuePath, { entries: [], paused: false, schema: 999 });
    await expect(readQueueFile(queuePath)).rejects.toThrow(UnsupportedQueueSchemaError);
  });
});
