import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadCastIdHistory,
  retireCharacterId,
  castIdHistoryPath,
  dropSupersededIdsReclaimedByLiveCast,
} from './cast-id-history.js';

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

  describe('dropSupersededIdsReclaimedByLiveCast (#2040 Task 14, spec §4.4 closing paragraph)', () => {
    it('drops a history entry whose key is now a live cast id, and reports it', async () => {
      await retireCharacterId(dir, 'unknown-male', 'timkin');
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['unknown-male', 'narrator']);
      expect(dropped).toEqual([{ id: 'unknown-male', supersededBy: 'timkin' }]);
      const history = await loadCastIdHistory(dir);
      expect(history.supersededBy).toEqual({});
      // Review item 2b — the dropped pair is not discarded, it moves to
      // `displaced`. Losing it here would be the same loss the review
      // flagged: the pair would be unrecoverable, not just unreported.
      expect(history.displaced).toEqual({ 'unknown-male': 'timkin' });
    });

    it('leaves an entry whose key is NOT live untouched', async () => {
      await retireCharacterId(dir, 'old-eliza', 'eliza');
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['eliza', 'narrator']);
      // 'eliza' is the entry's VALUE, not its key — a live target is exactly
      // what tier-2 resolution is supposed to do, and is not what this
      // function drops. Only 'old-eliza' (the key) reclaiming liveness would
      // qualify, and it hasn't here.
      expect(dropped).toEqual([]);
      const history = await loadCastIdHistory(dir);
      expect(history.supersededBy).toEqual({ 'old-eliza': 'eliza' });
      // Nothing dropped, so nothing displaced.
      expect(history.displaced).toBeUndefined();
    });

    it('drops the reclaimed entry while an unrelated entry survives untouched, in the same call', async () => {
      await retireCharacterId(dir, 'unknown-male', 'timkin');
      await retireCharacterId(dir, 'old-eliza', 'eliza');
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['unknown-male']);
      expect(dropped).toEqual([{ id: 'unknown-male', supersededBy: 'timkin' }]);
      const history = await loadCastIdHistory(dir);
      expect(history.supersededBy).toEqual({ 'old-eliza': 'eliza' });
      expect(history.displaced).toEqual({ 'unknown-male': 'timkin' });
    });

    it('accumulates displaced entries across multiple drop calls rather than overwriting', async () => {
      await retireCharacterId(dir, 'unknown-male', 'timkin');
      await dropSupersededIdsReclaimedByLiveCast(dir, ['unknown-male']);
      await retireCharacterId(dir, 'unknown-female', 'sela');
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['unknown-female']);
      expect(dropped).toEqual([{ id: 'unknown-female', supersededBy: 'sela' }]);
      const history = await loadCastIdHistory(dir);
      // Both drops survive — the second call's write must not clobber the
      // first call's entry.
      expect(history.displaced).toEqual({ 'unknown-male': 'timkin', 'unknown-female': 'sela' });
    });

    it('returns [] and still writes when nothing needs dropping (#2040 Task 14 review item 3)', async () => {
      await retireCharacterId(dir, 'old-eliza', 'eliza');
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['some-other-live-id']);
      expect(dropped).toEqual([]);
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ 'old-eliza': 'eliza' });
    });

    it('writes a history file (empty supersededBy, no displaced) for a book that never had one, even though nothing is dropped', async () => {
      expect(existsSync(castIdHistoryPath(dir))).toBe(false);
      const dropped = await dropSupersededIdsReclaimedByLiveCast(dir, ['unknown-male']);
      expect(dropped).toEqual([]);
      // The guard that skipped this write when nothing was dropped is gone
      // (review item 3) — prove it by checking the file actually landed,
      // not just that loadCastIdHistory's content looks the same either way.
      expect(existsSync(castIdHistoryPath(dir))).toBe(true);
      const history = await loadCastIdHistory(dir);
      expect(history).toEqual({ schema: 1, supersededBy: {} });
    });
  });

  describe('displaced backwards-compatibility (#2040 Task 14 review item 2b)', () => {
    it('loads a pre-Task-14 file with no `displaced` key at all', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }));
      const result = await loadCastIdHistory(dir);
      expect(result.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(result.displaced).toBeUndefined();
    });

    it('returns empty history rather than throwing when `displaced` is malformed', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: {}, displaced: 'not-an-object' }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });
  });
});
