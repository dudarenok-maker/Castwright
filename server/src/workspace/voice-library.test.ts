/* fs-38 Wave 1, Task 3 — voice-library manifest store. Each entry lives at
   `<WORKSPACE_ROOT>/voice-library/<voiceUuid>/voice.json`. Mirrors the
   temp-workspace-root fixture pattern used across workspace/*.test.ts
   (device-tokens.test.ts): mkdtempSync + WORKSPACE_DIR env + vi.resetModules()
   so paths.ts re-reads WORKSPACE_ROOT fresh per test. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let vl: typeof import('./voice-library.js');

function makeEntry(
  overrides: Partial<import('./voice-library.js').VoiceLibraryEntry> = {},
): import('./voice-library.js').VoiceLibraryEntry {
  return {
    voiceUuid: 'uuid-1',
    name: 'Test Voice',
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-voicelib-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules(); // re-read WORKSPACE_ROOT at module load
  vl = await import('./voice-library.js');
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('voice-library manifest store', () => {
  it('round-trips write -> read', async () => {
    const entry = makeEntry();
    await vl.writeEntry(entry);
    const read = await vl.readEntry(entry.voiceUuid);
    expect(read).not.toBeNull();
    expect(read?.voiceUuid).toBe(entry.voiceUuid);
    expect(read?.name).toBe(entry.name);
    expect(read?.provenance).toBe(entry.provenance);
  });

  it('readEntry returns null for a missing uuid', async () => {
    expect(await vl.readEntry('does-not-exist')).toBeNull();
  });

  it('writeEntry stamps a fresh updatedAt on every write', async () => {
    const entry = makeEntry({ updatedAt: '2020-01-01T00:00:00.000Z' });
    await vl.writeEntry(entry);
    const first = await vl.readEntry(entry.voiceUuid);
    expect(first).not.toBeNull();
    expect(first!.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');

    // A second write with a stale updatedAt still gets re-stamped.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vl.writeEntry({ ...entry, updatedAt: '1999-01-01T00:00:00.000Z' });
    const second = await vl.readEntry(entry.voiceUuid);
    expect(second!.updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(new Date(second!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first!.updatedAt).getTime(),
    );
  });

  it('listEntries returns valid entries and skips a dir with corrupt JSON', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'good-1', name: 'Good One' }));
    await vl.writeEntry(makeEntry({ voiceUuid: 'good-2', name: 'Good Two' }));

    const badDir = join(vl.voiceLibraryDir(), 'bad-uuid');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'voice.json'), '{ not valid json', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = await vl.listEntries();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.voiceUuid).sort()).toEqual(['good-1', 'good-2']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('removeEntryDir deletes the entry directory recursively', async () => {
    const entry = makeEntry({ voiceUuid: 'to-remove' });
    await vl.writeEntry(entry);
    expect(await vl.readEntry(entry.voiceUuid)).not.toBeNull();

    await vl.removeEntryDir(entry.voiceUuid);
    expect(await vl.readEntry(entry.voiceUuid)).toBeNull();
  });
});

/* fs-38 Wave 3c, Task 14 — `updateEntry`/the per-uuid lock it's built on
   (`withEntryLock`, not exported — exercised only through `updateEntry`
   here) close the voice-library's read-modify-write race: two concurrent
   callers each reading a stale snapshot, mutating their own copy, and
   writing back must not let the second writer's stale snapshot clobber the
   first writer's change. A mutex around only the final `writeEntry` call
   does NOT close this — it just serializes two already-stale snapshots, and
   the second one still wins. These tests exercise the REAL, non-mocked
   module (same real fs the production routes/resolver use via this same
   `updateEntry` export) so a regression here is a regression every caller
   inherits. */
describe('updateEntry — per-uuid read-modify-write lock', () => {
  it('a missing entry: mutate is invoked with null, and returning null/undefined skips the write', async () => {
    let seen: unknown;
    const result = await vl.updateEntry('does-not-exist', (entry) => {
      seen = entry;
      return null;
    });
    expect(seen).toBeNull();
    expect(result).toBeNull();
    expect(await vl.readEntry('does-not-exist')).toBeNull();
  });

  it('a present entry: mutate receives the fresh entry, the write persists, and the canonical (re-read) record is returned', async () => {
    const entry = makeEntry({ voiceUuid: 'update-1', name: 'Original' });
    await vl.writeEntry(entry);

    const result = await vl.updateEntry('update-1', (fresh) => {
      expect(fresh?.name).toBe('Original');
      return { ...fresh!, name: 'Renamed' };
    });

    expect(result?.name).toBe('Renamed');
    const onDisk = await vl.readEntry('update-1');
    expect(onDisk?.name).toBe('Renamed');
    // The returned record is the CANONICAL post-write one (re-read), not
    // just the object `mutate` handed back — same convention every route
    // handler relies on (writeEntry-then-readEntry).
    expect(result?.updatedAt).toBe(onDisk?.updatedAt);
  });

  /* THE core proof for Task 14: two interleaved read-modify-write cycles
     touching DIFFERENT engine slots on the SAME entry. Without a lock that
     spans the whole read+mutate+write span (not just the write), this is
     exactly the wave-3c regression described in clone-voice-resolver.ts's
     Task 14 doc comment — A reads {qwen:stale}, derives xtts, writes
     {qwen:stale, xtts:ready}; B, holding its OWN stale pre-A snapshot,
     writes {qwen:ready} — erasing A's xtts slot.

     Determinism: no setTimeout/sleep. Caller A's `mutate` awaits a
     manually-released gate — since `updateEntry` chains the NEXT queued
     caller (B) onto the promise A's own critical section resolves to, B's
     `mutate` (and even B's own `readEntry`) cannot start running until A's
     `mutate` returns and A's write completes — this is guaranteed by the
     promise chain itself, not by timing. B is launched (queued) before A's
     gate is released, so this only passes if the queueing is real. */
  it('serializes two interleaved read-modify-write cycles across DIFFERENT engine slots — both writes survive', async () => {
    const entry = makeEntry({
      voiceUuid: 'race-1',
      engines: { qwen: { status: 'ready', baseModel: 'old' } },
    });
    await vl.writeEntry(entry);

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const order: string[] = [];

    // Caller A — simulates the cloned resolver's post-derive xtts write.
    // Pauses mid-critical-section until we release it below.
    const pA = vl.updateEntry('race-1', async (fresh) => {
      order.push('A-read');
      await gateA;
      order.push('A-write');
      return { ...fresh!, engines: { ...fresh!.engines, xtts: { status: 'ready' } } };
    });

    // Caller B — simulates a concurrent PATCH-style write to the SIBLING
    // engine slot, launched (queued) before A's gate is ever released.
    const pB = vl.updateEntry('race-1', (fresh) => {
      order.push('B-read-and-write');
      return { ...fresh!, engines: { ...fresh!.engines, qwen: { status: 'stale', baseModel: 'old' } } };
    });

    releaseA();
    const [resultA, resultB] = await Promise.all([pA, pB]);

    // B's body must not have run before A's write completed — proof the
    // lock actually queued it, not just that both happened to finish.
    expect(order).toEqual(['A-read', 'A-write', 'B-read-and-write']);

    expect(resultA?.engines.xtts).toEqual({ status: 'ready' });
    expect(resultB?.engines.qwen).toEqual({ status: 'stale', baseModel: 'old' });

    // Assert on the REAL persisted state, not on mock call arguments — the
    // whole point is that BOTH slots survive on disk.
    const final = await vl.readEntry('race-1');
    expect(final?.engines.xtts).toEqual({ status: 'ready' });
    expect(final?.engines.qwen).toEqual({ status: 'stale', baseModel: 'old' });
  });

  it('different voiceUuids never block each other', async () => {
    await vl.writeEntry(makeEntry({ voiceUuid: 'indep-1' }));
    await vl.writeEntry(makeEntry({ voiceUuid: 'indep-2' }));

    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondFinished = false;

    const p1 = vl.updateEntry('indep-1', async (fresh) => {
      await gate;
      return { ...fresh!, name: 'first' };
    });
    const p2 = vl.updateEntry('indep-2', async (fresh) => {
      secondFinished = true;
      return { ...fresh!, name: 'second' };
    });

    await p2; // must resolve WITHOUT waiting on indep-1's still-open gate.
    expect(secondFinished).toBe(true);

    releaseFirst();
    await p1;
  });
});
