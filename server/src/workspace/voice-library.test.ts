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
