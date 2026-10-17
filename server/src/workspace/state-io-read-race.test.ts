/* #3700 — readJson / readJsonWithRecovery must treat a file that disappears
   between the existence check and the read (a sibling write renaming over it,
   on Windows) as "missing", not throw ENOENT. `existsSync` is forced to lie
   ("it's there") so the only thing that can answer correctly is the read's own
   ENOENT handling. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

import { readJson, readJsonWithRecovery } from './state-io.js';

describe('state-io reads survive the exists-then-read race (#3700)', () => {
  it('readJson returns null when the file vanishes after the existence check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-io-race-'));
    try {
      await expect(readJson(join(dir, 'state.json'))).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readJsonWithRecovery returns null when the file vanishes after the existence check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-io-race-'));
    try {
      await expect(readJsonWithRecovery(join(dir, 'state.json'), { keep: 3 })).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readJson still surfaces a corrupt file as a parse error, not null', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'state-io-race-'));
    try {
      writeFileSync(join(dir, 'state.json'), '{not json');
      await expect(readJson(join(dir, 'state.json'))).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
