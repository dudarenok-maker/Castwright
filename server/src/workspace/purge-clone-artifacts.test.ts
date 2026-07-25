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

  const [purgeMod, pathsMod] = await Promise.all([
    import('./purge-clone-artifacts.js'),
    import('./paths.js'),
  ]);
  purge = purgeMod;
  paths = pathsMod;

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
    const masterWavFile = seed(`${key}__master`, 'wav'); // §2.3 designed-voice reference clip

    await purge.purgeCloneArtifacts('u1');

    for (const f of [ptFile, jsonFile, pt17bFile, previewPtFile, previewJsonFile, masterWavFile]) {
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

  it('evicts the sidecar cache for the voice key, after the files are gone', async () => {
    const ptFile = seed('qwen-u1', 'pt');
    let ptFileExistedAtEvictTime: boolean | null = null;
    fetchMock.mockImplementationOnce(async () => {
      ptFileExistedAtEvictTime = existsSync(ptFile);
      return { ok: true };
    });

    await purge.purgeCloneArtifacts('u1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/qwen/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'qwen-u1' }),
      }),
    );
    expect(ptFileExistedAtEvictTime).toBe(false);
  });

  it('does not throw when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(purge.purgeCloneArtifacts('u1')).resolves.toBeUndefined();
  });
});
