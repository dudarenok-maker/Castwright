/* fs-38 Wave 3b2, Task 2 — purgeCloneArtifacts erases every consent-scoped
   Qwen clone artifact for a voice: base .pt/.json, the 1.7B variant (the gap
   the ad-hoc cleanup this replaces used to miss), and any staged preview —
   then evicts the sidecar's in-memory cache, files first. Mirrors the
   tempdir-workspace fixture pattern used across workspace/*.test.ts
   (voice-library.test.ts): mkdtempSync + WORKSPACE_DIR env +
   vi.resetModules() so paths.ts re-reads WORKSPACE_ROOT fresh per test.

   purgeVoiceSamples / removeEntryDir / getResolvedSidecarUrl are spied via
   the importOriginal-merge pattern (not full-replaced) — routes/qwen-voice.js
   (needed here for the real qwenVoicePtPath sanitizer/containment logic) and
   its own transitive imports pull in other named exports from those same
   modules, so a full replace would silently undefine them. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { purgeVoiceSamples } = vi.hoisted(() => ({ purgeVoiceSamples: vi.fn() }));
vi.mock('../tts/voice-sample-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/voice-sample-cache.js')>();
  return { ...actual, purgeVoiceSamples };
});

const { removeEntryDir } = vi.hoisted(() => ({ removeEntryDir: vi.fn() }));
vi.mock('./voice-library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-library.js')>();
  return { ...actual, removeEntryDir };
});

const { getResolvedSidecarUrl } = vi.hoisted(() => ({ getResolvedSidecarUrl: vi.fn() }));
vi.mock('./user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./user-settings.js')>();
  return { ...actual, getResolvedSidecarUrl };
});

let dir: string;
let purge: typeof import('./purge-clone-artifacts.js');
let paths: typeof import('./paths.js');
let vl: typeof import('./voice-library.js');
let fetchMock: ReturnType<typeof vi.fn>;

function seed(name: string, ext: 'pt' | 'json' | 'wav'): string {
  const p = join(paths.qwenVoicesDir(), `${name}.${ext}`);
  writeFileSync(p, ext === 'json' ? '{}' : 'binary-stub');
  return p;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-purge-clone-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();

  purgeVoiceSamples.mockReset();
  removeEntryDir.mockReset().mockResolvedValue(undefined);
  getResolvedSidecarUrl.mockReset().mockReturnValue('http://127.0.0.1:9000');

  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);

  // Sequential, not Promise.all: `voice-library.js` must finish resolving
  // through its mock factory (importOriginal-merge) BEFORE
  // `purge-clone-artifacts.js` (which statically imports from it) does —
  // importing them concurrently raced the mock factory against itself and
  // left `purge`'s internal `removeEntryDir` reference desynced from this
  // test file's mocked one.
  vl = await import('./voice-library.js');
  purge = await import('./purge-clone-artifacts.js');
  paths = await import('./paths.js');

  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('purgeCloneArtifacts', () => {
  it('erases the base, 1.7B, manifest, preview, and master-clip artifacts, and purges samples', async () => {
    const key = 'qwen-u1';
    const ptFile = seed(key, 'pt');
    const jsonFile = seed(key, 'json');
    const pt17bFile = seed(`${key}__1.7b`, 'pt'); // the gap this closes
    const previewPtFile = seed(`${key}-preview`, 'pt');
    const previewJsonFile = seed(`${key}-preview`, 'json');
    // M2 (review) — the preview's own 1.7B variant; the same gap as the base
    // key's `__1.7b.pt`, just for `-preview`.
    const previewPt17bFile = seed(`${key}-preview__1.7b`, 'pt');
    const masterWavFile = seed(`${key}__master`, 'wav'); // §2.3 designed-voice reference clip
    // Fix wave (consent-erasure gap) — the PREVIEW design writes its own
    // `<key>-preview__master.wav` clip; nothing erased it before this fix.
    const previewMasterWavFile = seed(`${key}-preview__master`, 'wav');

    await purge.purgeCloneArtifacts('u1');

    for (const f of [
      ptFile,
      jsonFile,
      pt17bFile,
      previewPtFile,
      previewJsonFile,
      previewPt17bFile,
      masterWavFile,
      previewMasterWavFile,
    ]) {
      expect(existsSync(f)).toBe(false);
    }
    expect(purgeVoiceSamples).toHaveBeenCalledWith(key);
    expect(removeEntryDir).not.toHaveBeenCalled();
  });

  it('removes the entry dir only when deleteEntryDir is set', async () => {
    await purge.purgeCloneArtifacts('u1');
    expect(removeEntryDir).not.toHaveBeenCalled();

    await purge.purgeCloneArtifacts('u1', { deleteEntryDir: true });
    expect(removeEntryDir).toHaveBeenCalledWith('u1');
  });

  it('evicts the sidecar cache for both the base and -preview voice keys, after the files are gone', async () => {
    const ptFile = seed('qwen-u1', 'pt');
    let ptFileExistedAtFirstEvict: boolean | null = null;
    fetchMock.mockImplementationOnce(async () => {
      ptFileExistedAtFirstEvict = existsSync(ptFile);
      return { ok: true };
    });

    await purge.purgeCloneArtifacts('u1');

    // M2 (review) — evicts BOTH the base key and its `-preview` sidecar so a
    // `-preview` clone-prompt can't linger resident after "every artifact"
    // was supposedly erased.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9000/qwen/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'qwen-u1' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9000/qwen/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'qwen-u1-preview' }),
      }),
    );
    expect(ptFileExistedAtFirstEvict).toBe(false);
  });

  it('does not throw when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(purge.purgeCloneArtifacts('u1')).resolves.toBeUndefined();
  });

  it('a base-key evict failure does not skip the -preview evict', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });

    await purge.purgeCloneArtifacts('u1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* User-directed fix — revoke must also erase the person's original
   recording (the entry-dir clip), not just the derived engine artifacts.
   `deleteMasterClip` is the mechanism: unlike `deleteEntryDir` (delete),
   this keeps the manifest + entry dir, erasing only the clip file itself
   and clearing the manifest's `master` field so it never points at a
   deleted file. */
describe('purgeCloneArtifacts — deleteMasterClip (revoke recording erasure)', () => {
  function makeMaster(overrides: Partial<import('./voice-library.js').VoiceMaster> = {}) {
    return {
      clipFile: 'master.wav',
      sampleRate: 24000,
      durationSeconds: 12,
      transcript: 'hello there',
      transcriptSource: 'whisper' as const,
      captureMethod: 'record' as const,
      ...overrides,
    };
  }

  it('erases the entry-dir recording and clears master, leaving voice.json + consent readable', async () => {
    const voiceUuid = 'r1';
    await vl.writeEntry({
      voiceUuid,
      name: 'Dad',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
        revokedAt: '2026-07-26T00:00:00.000Z',
      },
      master: makeMaster(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const clipPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(clipPath, 'fake-wav-bytes');

    await purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });

    expect(existsSync(clipPath)).toBe(false); // the recording itself is gone
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.master).toBeUndefined(); // cleared — never points at a deleted file
    expect(onDisk?.consent?.revokedAt).toBeTruthy(); // manifest + consent still readable
  });

  it('is a no-op when the entry has no master (nothing to erase)', async () => {
    const voiceUuid = 'r2';
    await vl.writeEntry({
      voiceUuid,
      name: 'No Clip',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'No Clip',
        relationship: 'self',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true }),
    ).resolves.toBeUndefined();
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk?.master).toBeUndefined();
  });

  it('is a no-op when the entry itself does not exist', async () => {
    await expect(
      purge.purgeCloneArtifacts('does-not-exist', { deleteMasterClip: true }),
    ).resolves.toBeUndefined();
  });

  it('leaves the recording untouched when deleteMasterClip is not set (existing revoke path)', async () => {
    const voiceUuid = 'r3';
    await vl.writeEntry({
      voiceUuid,
      name: 'Dad',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
      master: makeMaster(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const clipPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(clipPath, 'fake-wav-bytes');

    await purge.purgeCloneArtifacts(voiceUuid);

    expect(existsSync(clipPath)).toBe(true);
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk?.master).toEqual(makeMaster());
  });
});
