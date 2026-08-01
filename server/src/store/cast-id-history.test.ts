import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCastIdHistory, retireCharacterId } from './cast-id-history.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cih-')); });

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
});
