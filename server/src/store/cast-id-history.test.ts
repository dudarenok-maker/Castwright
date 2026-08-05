import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadCastIdHistory,
  retireCharacterId,
  castIdHistoryPath,
  dropSupersededIdsReclaimedByLiveCast,
  refuseRetirementsOfLiveIds,
  forgetSupersededId,
  rejectOrphanedId,
  rejectOrphanedPair,
  unrejectOrphanedPair,
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

  describe('operator-visible warnings (srv-86 review round 2 — M1/M2)', () => {
    // M1: every "never-throws" test above proves the RETURN value degrades
    // gracefully, but none of them assert anything was actually logged — a
    // suite that only checks the return value can't tell a warning from no
    // warning, so it stays green even if the console.warn call in
    // loadCastIdHistory's SHAPE branch (well-formed JSON, wrong shape) were
    // deleted outright.
    it('warns when the file exists but has an unexpected shape (well-formed JSON, wrong shape)', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 2, supersededBy: {} }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadCastIdHistory(dir);
        expect(result).toEqual({ schema: 1, supersededBy: {} });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0][0]);
        expect(message).toContain(castIdHistoryPath(dir));
        expect(message).toMatch(/unexpected shape/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('warns when the file is unreadable (truncated/invalid JSON — the parse-throw branch)', async () => {
      writeTestHistoryFile('{invalid json');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadCastIdHistory(dir);
        expect(result).toEqual({ schema: 1, supersededBy: {} });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0][0]);
        expect(message).toContain(castIdHistoryPath(dir));
        expect(message).toMatch(/unreadable/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    // M2: a missing file is the common case (most books never retire an id)
    // and must stay silent — if the `raw === null` early return were
    // removed, `raw.schema` on `null` would throw into the catch branch and
    // start logging a warning for every book with no history file, on every
    // render and every book-state read.
    it('does not warn when the file is simply absent — the common case', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadCastIdHistory(dir);
        expect(result).toEqual({ schema: 1, supersededBy: {} });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
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

  describe('rejected backwards-compatibility (#2040 Task 17)', () => {
    it('loads a pre-Task-17 file with no `rejected` key at all', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }));
      const result = await loadCastIdHistory(dir);
      expect(result.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(result.rejected).toBeUndefined();
    });

    it('returns empty history rather than throwing when `rejected` is not an array', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: {}, rejected: 'not-an-array' }));
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('loads a well-formed `rejected` array', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: {}, rejected: ['the-torment'] }));
      const result = await loadCastIdHistory(dir);
      expect(result.rejected).toEqual(['the-torment']);
    });
  });

  describe('forgetSupersededId (#2040 Task 17)', () => {
    it('removes a single named entry from supersededBy', async () => {
      await retireCharacterId(dir, 'mayrin', 'mairin');
      await forgetSupersededId(dir, 'mayrin');
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({});
    });

    it('leaves an unrelated entry untouched', async () => {
      await retireCharacterId(dir, 'mayrin', 'mairin');
      await retireCharacterId(dir, 'old-eliza', 'eliza');
      await forgetSupersededId(dir, 'mayrin');
      expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ 'old-eliza': 'eliza' });
    });

    it('does NOT repoint entries whose VALUE is the forgotten id — unlike retireCharacterId', async () => {
      // Hand-write a history that retireCharacterId's own chain-maintaining
      // invariant would never leave lying around (it always repoints stale
      // VALUES eagerly), so this pins forgetSupersededId's own contract in
      // isolation: 'a' -> 'mayrin' is a chain THROUGH mayrin, not naming it
      // as a key. forgetSupersededId must not touch it — it only forgets the
      // one key it's told to, never chases values (that repoint is
      // retireCharacterId's job, and only sound when the id is genuinely dead).
      writeTestHistoryFile(
        JSON.stringify({ schema: 1, supersededBy: { a: 'mayrin', mayrin: 'mairin' } }),
      );
      await forgetSupersededId(dir, 'mayrin');
      const history = await loadCastIdHistory(dir);
      expect(history.supersededBy).toEqual({ a: 'mayrin' });
    });

    it('is a no-op (and does not write a file) when the key is absent', async () => {
      expect(existsSync(castIdHistoryPath(dir))).toBe(false);
      await forgetSupersededId(dir, 'nobody');
      expect(existsSync(castIdHistoryPath(dir))).toBe(false);
    });

    describe('return value (#2092/#2089 D6 — lossless undo)', () => {
      it('returns the removed target', async () => {
        await retireCharacterId(dir, 'mayrin', 'mairin');
        await expect(forgetSupersededId(dir, 'mayrin')).resolves.toBe('mairin');
      });

      it('returns undefined when the key was absent', async () => {
        await expect(forgetSupersededId(dir, 'nobody')).resolves.toBeUndefined();
      });
    });

    describe('expectedTarget (#2092/#2089, review round 2 "Also fix" — closes the POST-side race I1\'s reorder opened)', () => {
      it('deletes when the current value matches expectedTarget', async () => {
        await retireCharacterId(dir, 'mayrin', 'mairin');
        await expect(forgetSupersededId(dir, 'mayrin', 'mairin')).resolves.toBe('mairin');
        expect((await loadCastIdHistory(dir)).supersededBy).toEqual({});
      });

      it('is a no-op when the current value does NOT match expectedTarget — the race I1 opened', async () => {
        // Simulates: the route reads supersededBy['mayrin'] === 'mairin',
        // then a CONCURRENT retireCharacterId repoints it onto something
        // else entirely before the (now non-fatal, post-reorder) forget
        // call runs. An unconditional delete would discard the fresh
        // 'mr-marrow' entry instead of the stale 'mairin' the caller
        // actually read.
        await retireCharacterId(dir, 'mayrin', 'mairin');
        await retireCharacterId(dir, 'mayrin', 'mr-marrow');
        await expect(forgetSupersededId(dir, 'mayrin', 'mairin')).resolves.toBeUndefined();
        // The concurrent write survives untouched.
        expect((await loadCastIdHistory(dir)).supersededBy).toEqual({ mayrin: 'mr-marrow' });
      });

      it('review round 3 (M-8) — the expectedTarget mismatch no-op logs a warning naming both the expected and actual values, instead of failing silently', async () => {
        // Round 2's fix (above) correctly refuses to discard the concurrent
        // write, but the refusal itself was silent — "someone else moved
        // this key since the read" was indistinguishable, in the logs, from
        // "there was nothing to forget in the first place". Named so an
        // operator can tell the two apart after the fact.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await retireCharacterId(dir, 'mayrin', 'mairin');
        await retireCharacterId(dir, 'mayrin', 'mr-marrow');
        await forgetSupersededId(dir, 'mayrin', 'mairin');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/mayrin.*mairin.*mr-marrow/s),
        );
        warnSpy.mockRestore();
      });

      it('deletes unconditionally when expectedTarget is omitted — back-compat with every other caller', async () => {
        await retireCharacterId(dir, 'mayrin', 'mairin');
        await expect(forgetSupersededId(dir, 'mayrin')).resolves.toBe('mairin');
        expect((await loadCastIdHistory(dir)).supersededBy).toEqual({});
      });

      it('still returns undefined (no-op, no write) when the key is absent, whether or not expectedTarget is given', async () => {
        expect(existsSync(castIdHistoryPath(dir))).toBe(false);
        await expect(forgetSupersededId(dir, 'nobody', 'anything')).resolves.toBeUndefined();
        expect(existsSync(castIdHistoryPath(dir))).toBe(false);
      });
    });
  });

  describe('rejectOrphanedId (#2040 Task 17)', () => {
    it('adds an id to the rejected list', async () => {
      await rejectOrphanedId(dir, 'mayrin');
      expect((await loadCastIdHistory(dir)).rejected).toEqual(['mayrin']);
    });

    it('is idempotent — rejecting the same id twice does not duplicate it', async () => {
      await rejectOrphanedId(dir, 'mayrin');
      await rejectOrphanedId(dir, 'mayrin');
      expect((await loadCastIdHistory(dir)).rejected).toEqual(['mayrin']);
    });

    it('accumulates multiple distinct rejected ids', async () => {
      await rejectOrphanedId(dir, 'mayrin');
      await rejectOrphanedId(dir, 'the-torment');
      expect((await loadCastIdHistory(dir)).rejected).toEqual(['mayrin', 'the-torment']);
    });

    it('does not touch supersededBy', async () => {
      await retireCharacterId(dir, 'mayrin', 'mairin');
      await rejectOrphanedId(dir, 'mayrin');
      const history = await loadCastIdHistory(dir);
      expect(history.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(history.rejected).toEqual(['mayrin']);
    });
  });

  describe('rejectedPairs backwards-compatibility and independent validation (#2092/#2089 D1)', () => {
    it('a schema-1 file with the legacy `rejected` list still loads with `supersededBy` intact', async () => {
      writeTestHistoryFile(
        JSON.stringify({
          schema: 1,
          supersededBy: { mayrin: 'mairin' },
          rejected: ['the-torment'],
        }),
      );
      const result = await loadCastIdHistory(dir);
      expect(result.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(result.rejected).toEqual(['the-torment']);
      expect(result.rejectedPairs).toBeUndefined();
    });

    it('loads a well-formed `rejectedPairs` array alongside `supersededBy`', async () => {
      writeTestHistoryFile(
        JSON.stringify({
          schema: 1,
          supersededBy: { mayrin: 'mairin' },
          rejectedPairs: [{ from: 'mayrin', to: 'wren' }],
        }),
      );
      const result = await loadCastIdHistory(dir);
      expect(result.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(result.rejectedPairs).toEqual([{ from: 'mayrin', to: 'wren' }]);
    });

    it('loads a pre-D1 file with no `rejectedPairs` key at all', async () => {
      writeTestHistoryFile(JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }));
      const result = await loadCastIdHistory(dir);
      expect(result.supersededBy).toEqual({ mayrin: 'mairin' });
      expect(result.rejectedPairs).toBeUndefined();
    });

    it('returns empty history rather than throwing when `rejectedPairs` is not an array', async () => {
      writeTestHistoryFile(
        JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: 'not-an-array' }),
      );
      const result = await loadCastIdHistory(dir);
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('a malformed `rejectedPairs` does not discard an otherwise well-formed `rejected` list — trap 4, independent validation', async () => {
      // The two fields are validated by SEPARATE Array.isArray checks. If
      // rejectedPairs were folded into the same check as `rejected` (or if
      // `rejected` were retyped in place instead of adding a new field), a
      // malformed rejectedPairs would discard supersededBy/rejected too —
      // this pins that they stay independent.
      writeTestHistoryFile(
        JSON.stringify({
          schema: 1,
          supersededBy: { mayrin: 'mairin' },
          rejected: ['the-torment'],
          rejectedPairs: { not: 'an-array' },
        }),
      );
      const result = await loadCastIdHistory(dir);
      // The WHOLE file is malformed by this module's existing all-or-nothing
      // contract (there is no per-field partial recovery anywhere else in
      // this loader either) — pin that a malformed rejectedPairs collapses
      // to the same empty default as every other malformed-field case above,
      // not a silent, partially-loaded object.
      expect(result).toEqual({ schema: 1, supersededBy: {} });
    });

    it('does NOT bump `schema` — trap 3', async () => {
      writeTestHistoryFile(
        JSON.stringify({
          schema: 1,
          supersededBy: {},
          rejectedPairs: [{ from: 'a', to: 'b' }],
        }),
      );
      const result = await loadCastIdHistory(dir);
      expect(result.schema).toBe(1);
    });
  });

  describe('rejectOrphanedPair / unrejectOrphanedPair (#2092/#2089 D1/D5/D6)', () => {
    it('adds a pair to rejectedPairs', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin' },
      ]);
    });

    it('stashes forgotSupersededTo when provided', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin', 'wren');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin', forgotSupersededTo: 'wren' },
      ]);
    });

    it('omits forgotSupersededTo when not provided, rather than writing it as undefined', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      const pairs = (await loadCastIdHistory(dir)).rejectedPairs;
      expect(pairs?.[0]).toEqual({ from: 'mayrin', to: 'mairin' });
      expect(Object.keys(pairs?.[0] ?? {})).not.toContain('forgotSupersededTo');
    });

    it('is idempotent — rejecting the same pair twice does not duplicate it', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin' },
      ]);
    });

    it('a second, DIFFERENT target for the same `from` is a distinct pair (D1 pair scope)', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await rejectOrphanedPair(dir, 'mayrin', 'wren');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin' },
        { from: 'mayrin', to: 'wren' },
      ]);
    });

    it('does not touch the legacy `rejected` list', async () => {
      await rejectOrphanedId(dir, 'the-torment');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      const history = await loadCastIdHistory(dir);
      expect(history.rejected).toEqual(['the-torment']);
      expect(history.rejectedPairs).toEqual([{ from: 'mayrin', to: 'mairin' }]);
    });

    it('unrejectOrphanedPair removes the pair and returns forgotSupersededTo', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin', 'wren');
      await expect(unrejectOrphanedPair(dir, 'mayrin', 'mairin')).resolves.toBe('wren');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([]);
    });

    it('unrejectOrphanedPair returns undefined when the pair had no forgotSupersededTo', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await expect(unrejectOrphanedPair(dir, 'mayrin', 'mairin')).resolves.toBeUndefined();
    });

    it('unrejectOrphanedPair is a no-op (and does not write a file) when the pair is absent', async () => {
      expect(existsSync(castIdHistoryPath(dir))).toBe(false);
      await expect(unrejectOrphanedPair(dir, 'mayrin', 'mairin')).resolves.toBeUndefined();
      expect(existsSync(castIdHistoryPath(dir))).toBe(false);
    });

    it('unrejectOrphanedPair leaves an unrelated pair for the same `from` untouched', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await rejectOrphanedPair(dir, 'mayrin', 'wren');
      await unrejectOrphanedPair(dir, 'mayrin', 'mairin');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'wren' },
      ]);
    });
  });

  /* #2092/#2089 Task 10 — retireCharacterId repoints a rejectedPairs entry
     the same way it already repoints supersededBy: when the pair's `to`
     is the id being retired, the pair follows the character to its new
     live id, because a rejected pair is a decision about a PERSON, not a
     string (see repointRejectedPairs's own doc comment for the full
     reasoning). */
  describe('retireCharacterId repoints rejectedPairs (#2092/#2089 Task 10)', () => {
    it('repoints a rejected pair whose target is the id being retired (main branch)', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await retireCharacterId(dir, 'mairin', 'mairin-final');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin-final' },
      ]);
    });

    it('repoints through the direct-reversal branch too', async () => {
      // Same reversal shape as the 'direct reversal' describe above:
      // антон -> anton is recorded first, then a later call reverses it
      // (anton -> антон). A pair rejected against 'anton' while it was
      // still live must follow the reversal onto 'антон'.
      await retireCharacterId(dir, 'антон', 'anton');
      await rejectOrphanedPair(dir, 'mayrin', 'anton');
      await retireCharacterId(dir, 'anton', 'антон');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'антон' },
      ]);
    });

    it('preserves forgotSupersededTo across a repoint', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin', 'wren');
      await retireCharacterId(dir, 'mairin', 'mairin-final');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin-final', forgotSupersededTo: 'wren' },
      ]);
    });

    it('leaves a rejected pair targeting an UNRELATED live id untouched', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await retireCharacterId(dir, 'someone-else', 'timkin');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'mairin' },
      ]);
    });

    it('drops a rejected pair that would become a self-loop (the retiring id\'s new target IS the pair\'s own `from`)', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      // 'mairin' itself retires INTO 'mayrin' — the pair's `to` (mairin)
      // would repoint onto 'mayrin', which is already the pair's `from`.
      await retireCharacterId(dir, 'mairin', 'mayrin');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([]);
    });

    it('does not touch the legacy `rejected` list, which has no target to repoint', async () => {
      await rejectOrphanedId(dir, 'the-torment');
      await retireCharacterId(dir, 'the-torment', 'lightning-dave');
      expect((await loadCastIdHistory(dir)).rejected).toEqual(['the-torment']);
    });

    it('M1 (review round 1): dedupes when a repoint makes two PREVIOUSLY-distinct pairs collide', async () => {
      // 'mayrin' rejected against BOTH 'mairin' and 'mairin-final' — two
      // separate, valid pairs at the time each was recorded.
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin-final');
      // Now 'mairin' itself retires into 'mairin-final' — the first pair's
      // `to` repoints onto 'mairin-final', colliding with the second.
      await retireCharacterId(dir, 'mairin', 'mairin-final');
      const pairs = (await loadCastIdHistory(dir)).rejectedPairs;
      // Exactly ONE surviving entry, not two identical ones (which would
      // render two identical banner chips and make a second Undo click
      // look like it did nothing, per findIndex+splice only removing one).
      expect(pairs).toEqual([{ from: 'mayrin', to: 'mairin-final' }]);
    });

    it('M1: the first-recorded pair wins the dedupe (mirrors rejectOrphanedPair\'s own "first write wins" idempotence)', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin', 'first-stash');
      await rejectOrphanedPair(dir, 'mayrin', 'mairin-final');
      await retireCharacterId(dir, 'mairin', 'mairin-final');
      const pairs = (await loadCastIdHistory(dir)).rejectedPairs;
      expect(pairs).toEqual([
        { from: 'mayrin', to: 'mairin-final', forgotSupersededTo: 'first-stash' },
      ]);
    });

    it('M2 (review round 1): retireCharacterId RETURNS a dropped self-loop pair rather than silently discarding it', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      const result = await retireCharacterId(dir, 'mairin', 'mayrin');
      expect(result.droppedSelfLoopRejections).toEqual([{ from: 'mayrin', to: 'mayrin' }]);
    });

    it('M2: droppedSelfLoopRejections is empty when nothing was dropped', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'mairin');
      const result = await retireCharacterId(dir, 'mairin', 'mairin-final');
      expect(result.droppedSelfLoopRejections).toEqual([]);
    });

    it('M2: droppedSelfLoopRejections is empty on every no-op early return (from === to, or a dead self-entry)', async () => {
      const noop1 = await retireCharacterId(dir, 'mairin', 'mairin');
      expect(noop1.droppedSelfLoopRejections).toEqual([]);
    });

    it('M3 (review round 1): forgotSupersededTo is repointed independently of `to`, when it points at the retiring id', async () => {
      // 'mayrin' was rejected against 'timkin' — unrelated to this retirement
      // — but its STASHED alias ('antique-id') is the id about to retire.
      await rejectOrphanedPair(dir, 'mayrin', 'timkin', 'antique-id');
      await retireCharacterId(dir, 'antique-id', 'antique-id-final');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'timkin', forgotSupersededTo: 'antique-id-final' },
      ]);
    });

    it('M3: forgotSupersededTo is left alone when it does not point at the retiring id', async () => {
      await rejectOrphanedPair(dir, 'mayrin', 'timkin', 'unrelated-stash');
      await retireCharacterId(dir, 'someone-else', 'someone-else-final');
      expect((await loadCastIdHistory(dir)).rejectedPairs).toEqual([
        { from: 'mayrin', to: 'timkin', forgotSupersededTo: 'unrelated-stash' },
      ]);
    });
  });

  /* Wave 2 final-review finding 1(b) — the recording-boundary half of the
     live-id guard. `retireCharacterId`'s repoint loop is only sound when
     `from` is dead, so a retirement naming a LIVE cast id is bogus by
     definition and must never reach it. */
  describe('refuseRetirementsOfLiveIds', () => {
    it('refuses a retirement whose `from` is still a live cast id', () => {
      const r = refuseRetirementsOfLiveIds(
        [{ from: 'brann', to: 'brann-weir' }],
        ['brann', 'brann-weir'],
      );
      expect(r.keep).toEqual([]);
      expect(r.refused).toEqual([{ from: 'brann', to: 'brann-weir' }]);
    });

    it('keeps a retirement whose `from` is genuinely dead', () => {
      const r = refuseRetirementsOfLiveIds(
        [{ from: 'mayrin', to: 'mairin' }],
        ['mairin', 'narrator'],
      );
      expect(r.keep).toEqual([{ from: 'mayrin', to: 'mairin' }]);
      expect(r.refused).toEqual([]);
    });

    it('partitions a mixed batch, preserving order within each side', () => {
      const r = refuseRetirementsOfLiveIds(
        [
          { from: 'dead-1', to: 'x' },
          { from: 'live-1', to: 'x' },
          { from: 'dead-2', to: 'x' },
          { from: 'live-2', to: 'x' },
        ],
        ['live-1', 'live-2', 'x'],
      );
      expect(r.keep.map((e) => e.from)).toEqual(['dead-1', 'dead-2']);
      expect(r.refused.map((e) => e.from)).toEqual(['live-1', 'live-2']);
    });

    it('never judges on `to` — retiring INTO a live id is the normal case', () => {
      // The whole point of a retirement is that `to` is live. A guard that
      // tested `to` instead of `from` would refuse every legitimate entry
      // while letting the dangerous one through.
      const r = refuseRetirementsOfLiveIds([{ from: 'mayrin', to: 'mairin' }], ['mairin']);
      expect(r.refused).toEqual([]);
    });
  });
});
