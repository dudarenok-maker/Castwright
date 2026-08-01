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
