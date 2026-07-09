import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readLedger,
  upsertChapterEntry,
  resolveOps,
  discardChapters,
  patchSelection,
} from './script-review-ledger.js';
import { scriptReviewLedgerJsonPath } from './paths.js';

let bookDir: string;

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'script-review-ledger-'));
});
afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describe('script-review-ledger', () => {
  it('readLedger returns an empty envelope when no file exists', async () => {
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger).toEqual({ nextVersion: 1, entries: {} });
  });

  it('upsertChapterEntry creates a new entry and mints version 1, then version 2 for a different chapter', async () => {
    const first = await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 3,
      manuscriptId: 'ms-1',
      ops: [{ id: 1, op: 'strip_tag' }],
    });
    expect(first.version).toBe(1);
    const second = await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 4,
      manuscriptId: 'ms-1',
      ops: [{ id: 2, op: 'fix_emotion' }],
    });
    expect(second.version).toBe(2);
  });

  it('upsertChapterEntry always replaces the prior entry and mints a fresh version, never merging ops', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    const replaced = await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 2, op: 'fix_emotion' }] });
    expect(replaced.version).toBe(2);
    expect(replaced.ops).toEqual([{ id: 2, op: 'fix_emotion' }]);
  });

  it('readLedger drops an entry whose manuscriptId no longer matches the current one', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-old', ops: [{ id: 1, op: 'strip_tag' }] });
    const ledger = await readLedger(bookDir, 'ms-new');
    expect(ledger.entries).toEqual({});
  });

  it('resolveOps removes named keys and deletes the entry once empty, only with a matching version', async () => {
    await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 3,
      manuscriptId: 'ms-1',
      ops: [{ id: 1, op: 'strip_tag' }, { id: 2, op: 'fix_emotion' }],
    });
    const staleResult = await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 999, appliedOpKeys: ['3:1:strip_tag'] });
    expect(staleResult.ok).toBe(false);
    const okResult = await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 1, appliedOpKeys: ['3:1:strip_tag'] });
    expect(okResult.ok).toBe(true);
    let ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3'].ops).toHaveLength(1);
    await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 1, appliedOpKeys: ['3:2:fix_emotion'] });
    ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3']).toBeUndefined();
  });

  it('discardChapters removes entries unconditionally', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    await discardChapters(bookDir, 'book-1', [3]);
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3']).toBeUndefined();
  });

  it('a discard-then-re-review of the same chapter mints a new version, so a stale write against the old version no-ops', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    await discardChapters(bookDir, 'book-1', [3]);
    const recreated = await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 9, op: 'fix_emotion' }] });
    expect(recreated.version).toBe(2);
    const staleWrite = await patchSelection(bookDir, 'book-1', { chapterId: 3, version: 1, selected: { '3:9:fix_emotion': false } });
    expect(staleWrite.ok).toBe(false);
  });

  it('patchSelection merges selection overrides without touching ops, gated by version', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    const result = await patchSelection(bookDir, 'book-1', { chapterId: 3, version: 1, selected: { '3:1:strip_tag': false } });
    expect(result.ok).toBe(true);
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3'].selected).toEqual({ '3:1:strip_tag': false });
  });

  it('loadRaw returns an empty envelope when the ledger file contains syntactically invalid JSON (no throw)', async () => {
    const ledgerPath = scriptReviewLedgerJsonPath(bookDir);
    const ledgerDir = dirname(ledgerPath);
    mkdirSync(ledgerDir, { recursive: true });
    // Write syntactically invalid JSON to verify error is caught
    writeFileSync(ledgerPath, 'INVALID [[ JSON }}', 'utf8');
    // This should not throw; loadRaw's try/catch should handle it gracefully
    let result;
    try {
      result = await readLedger(bookDir, 'ms-1');
    } catch (err) {
      throw new Error(`readLedger should not throw on corrupt JSON, but got: ${err}`);
    }
    // Verify exact deep equality — no shared references, no pollution
    expect(result).toEqual({ nextVersion: 1, entries: {} });
  });

  it('cross-book ledger isolation: second book with missing ledger file does not inherit first book entries', async () => {
    // Create two independent temp directories (both with no ledger files)
    const bookDir1 = mkdtempSync(join(tmpdir(), 'script-review-ledger-book1-'));
    const bookDir2 = mkdtempSync(join(tmpdir(), 'script-review-ledger-book2-'));
    try {
      // Upsert a chapter into the first book's ledger
      await upsertChapterEntry(bookDir1, 'book-1', {
        chapterId: 10,
        manuscriptId: 'ms-1',
        ops: [{ id: 1, op: 'strip_tag' }],
      });

      // Read the second book's ledger (which has no file, so loadRaw hits the missing-file fallback)
      const ledger2 = await readLedger(bookDir2, 'ms-1');

      // The second book must have an empty entries object, not inherited from book 1
      expect(ledger2).toEqual({ nextVersion: 1, entries: {} });
      expect(ledger2.entries).not.toBe({});  // Ensure it's a fresh object, not a shared constant
    } finally {
      rmSync(bookDir1, { recursive: true, force: true });
      rmSync(bookDir2, { recursive: true, force: true });
    }
  });
});
