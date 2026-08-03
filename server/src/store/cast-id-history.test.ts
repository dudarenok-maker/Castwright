import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadCastIdHistory, retireCharacterId, castIdHistoryPath } from './cast-id-history.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cih-')); });

function writeTestHistoryFile(content: string): void {
  const path = castIdHistoryPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('cast id history', () => {
  it('returns an empty history when the file does not exist', async () => {
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({});
  });

  it('records a retirement', async () => {
    await retireCharacterId(dir, 'mayrin', 'mairin');
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ mayrin: 'mairin' });
  });

  it('is idempotent', async () => {
    await retireCharacterId(dir, 'mayrin', 'mairin');
    await retireCharacterId(dir, 'mayrin', 'mairin');
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ mayrin: 'mairin' });
  });

  it('no-ops when from === to', async () => {
    await retireCharacterId(dir, 'mairin', 'mairin');
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({});
  });

  it('REPOINTS an existing entry whose target is now retired', async () => {
    await retireCharacterId(dir, 'mayrin', 'mairin');
    await retireCharacterId(dir, 'mairin', 'mairin-final');
    // resolution must stay a single O(1) lookup - no transitive chasing
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({
      mayrin: 'mairin-final',
      mairin: 'mairin-final',
    });
  });

  it('REPOINTS regardless of retirement order - retiring INTO an already-superseded id', async () => {
    await retireCharacterId(dir, 'a', 'b');
    await retireCharacterId(dir, 'c', 'a');
    // 'a' is no longer a live target; 'c' must dereference through to 'b'
    // rather than being left pointing at the now-superseded 'a'.
    expect((await loadCastIdHistory(dir)).supersededBy).toEqual({
      a: 'b',
      c: 'b',
    });
  });

  describe('direct reversal (#2040 Task 8 fix round 1, item 3)', () => {
    it('inverts a same-run reversal instead of collapsing into a dead self-loop — order A (dedupe then remap)', async () => {
      // Reviewer's repro: a dedupe pass records "антон"->"anton", then a
      // later remap in the SAME run records the reverse "anton"->"антон"
      // (the roster ended up live on "антон"). The old code produced
      // {"антон":"anton","anton":"anton"} — a dead self-loop that orphans
      // BOTH ids, since neither target is live.
      await retireCharacterId(dir, 'антон', 'anton');
      await retireCharacterId(dir, 'anton', 'антон');
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ anton: 'антон' });
    });

    it('inverts a same-run reversal — order B (the calls in the opposite order)', async () => {
      await retireCharacterId(dir, 'anton', 'антон');
      await retireCharacterId(dir, 'антон', 'anton');
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ антон: 'anton' });
    });

    it('repoints a THIRD entry that targeted the now-dead id onto the new live id', async () => {
      // 'anton-typo' was retired in favour of 'anton' before the reversal.
      // Once 'anton' itself dies in favour of 'антон', 'anton-typo' must
      // follow it there rather than being left pointing at a dead target.
      await retireCharacterId(dir, 'anton-typo', 'anton');
      await retireCharacterId(dir, 'антон', 'anton');
      await retireCharacterId(dir, 'anton', 'антон');
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({
        'anton-typo': 'антон',
        anton: 'антон',
      });
    });
  });

  describe('never-throws guarantee', () => {
    it('returns empty history for truncated/invalid JSON', async () => {
      // Hits the catch branch in the try/catch
      writeTestHistoryFile('{invalid json');
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for empty file', async () => {
      // Empty file: readFile returns '', JSON.parse rejects it
      writeTestHistoryFile('');
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for JSON with wrong schema version', async () => {
      // Well-formed JSON but schema !== 1
      writeTestHistoryFile(JSON.stringify({ schema: 2, supersededBy: {} }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for JSON missing schema field', async () => {
      // Well-formed JSON but no schema field
      writeTestHistoryFile(JSON.stringify({ supersededBy: {} }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for JSON where supersededBy is not an object', async () => {
      // supersededBy is a string instead of an object
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: 'not-an-object' }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for JSON where supersededBy is null', async () => {
      // supersededBy is null instead of an object
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: null }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history for JSON where supersededBy is an array', async () => {
      // supersededBy is an array instead of an object
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: [] }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history when the file is not an object', async () => {
      // Valid JSON but not an object (e.g., a string)
      writeTestHistoryFile(JSON.stringify('not-an-object'));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('returns empty history when the file is null', async () => {
      // Valid JSON but null instead of an object
      writeTestHistoryFile('null');
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });
  });
});
