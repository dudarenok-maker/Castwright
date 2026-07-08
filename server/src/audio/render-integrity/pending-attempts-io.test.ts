import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPendingAttempts, writePendingAttempts } from './pending-attempts-io.js';

describe('pending-attempts-io', () => {
  it('returns null when no file has been written yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    expect(await readPendingAttempts(dir)).toBeNull();
  });

  it('round-trips a counts map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    await writePendingAttempts(dir, { ren: 2, mairin: 1 });
    expect(await readPendingAttempts(dir)).toEqual({ ren: 2, mairin: 1 });
  });

  it('overwrites the full map on each write (not a merge)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    await writePendingAttempts(dir, { ren: 1 });
    await writePendingAttempts(dir, { mairin: 1 });
    expect(await readPendingAttempts(dir)).toEqual({ mairin: 1 });
  });
});
