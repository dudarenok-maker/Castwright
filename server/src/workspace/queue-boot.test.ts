/* Integration test for the server-boot queue orphan sweep (queue-boot.ts).
 *
 * Drives resetOrphanedQueueEntries against a real .queue.json in an isolated
 * WORKSPACE_DIR, the same harness shape as routes/queue.test.ts. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueFile } from './queue-io.js';

let workspaceRoot: string;
let resetOrphanedQueueEntries: () => Promise<{ reset: number }>;
let readQueueFile: (path: string) => Promise<QueueFile>;
let writeQueueFile: (path: string, file: QueueFile) => Promise<void>;
let queueJsonPath: () => string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'queue-boot-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Import AFTER WORKSPACE_DIR is set so paths.ts captures the override. */
  ({ resetOrphanedQueueEntries } = await import('./queue-boot.js'));
  ({ readQueueFile, writeQueueFile } = await import('./queue-migrate.js'));
  ({ queueJsonPath } = await import('./paths.js'));
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const entry = (id: string, chapterId: number, status: QueueFile['entries'][number]['status']) => ({
  id,
  bookId: 'book-A',
  chapterId,
  scope: 'this' as const,
  addedAt: '2026-05-25T09:12:04.500Z',
  status,
  order: 0,
});

describe('resetOrphanedQueueEntries (boot sweep)', () => {
  it('flips orphaned in_progress entries to queued and reports the count', async () => {
    await writeQueueFile(queueJsonPath(), {
      entries: [
        entry('e2', 2, 'in_progress'),
        entry('e3', 3, 'in_progress'),
        entry('e5', 5, 'in_progress'),
        entry('e6', 6, 'queued'),
        entry('e7', 7, 'queued'),
      ],
      paused: false,
    });

    const result = await resetOrphanedQueueEntries();
    expect(result).toEqual({ reset: 3 });

    const after = await readQueueFile(queueJsonPath());
    expect(after.entries.map((e) => [e.id, e.status])).toEqual([
      ['e2', 'queued'],
      ['e3', 'queued'],
      ['e5', 'queued'],
      ['e6', 'queued'],
      ['e7', 'queued'],
    ]);
    /* Order stays contiguous after the sweep. */
    expect(after.entries.map((e) => e.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('no-ops (reset: 0) when nothing is in_progress', async () => {
    await writeQueueFile(queueJsonPath(), {
      entries: [entry('e6', 6, 'queued'), entry('e7', 7, 'queued')],
      paused: false,
    });
    const result = await resetOrphanedQueueEntries();
    expect(result).toEqual({ reset: 0 });
    const after = await readQueueFile(queueJsonPath());
    expect(after.entries.map((e) => e.status)).toEqual(['queued', 'queued']);
  });

  it('preserves the paused flag while sweeping', async () => {
    await writeQueueFile(queueJsonPath(), {
      entries: [entry('e2', 2, 'in_progress')],
      paused: true,
    });
    await resetOrphanedQueueEntries();
    const after = await readQueueFile(queueJsonPath());
    expect(after.paused).toBe(true);
    expect(after.entries[0].status).toBe('queued');
  });
});
