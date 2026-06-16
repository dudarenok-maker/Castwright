/* Unit tests for whisperPackageInstalled + detectWhisperInstallStateOnDisk.
   Mirrors kokoro-install-detect.test.ts: model-paths.js is mocked so the
   weights-present probe can be controlled without a real HF cache. The venv
   package probe uses a real temp-dir tree (makeVenvTree helper). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./model-paths.js', () => ({
  whisperRepoDir: vi.fn(() => '/fake/whisper-repo'),
  dirSizeBytes: vi.fn(() => ({ bytes: 0, fileCount: 0 })),
}));

import {
  whisperPackageInstalled,
  whisperWeightsPresent,
  detectWhisperInstallStateOnDisk,
} from './whisper-install-detect.js';
import { dirSizeBytes } from './model-paths.js';

const mockDirSizeBytes = vi.mocked(dirSizeBytes);

beforeEach(() => {
  mockDirSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
});

/* ── whisperWeightsPresent ───────────────────────────────────────────────── */

describe('whisperWeightsPresent', () => {
  it('returns false when dirSizeBytes returns 0 bytes', () => {
    mockDirSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
    expect(whisperWeightsPresent()).toBe(false);
  });

  it('returns true when dirSizeBytes returns non-zero bytes', () => {
    mockDirSizeBytes.mockReturnValue({ bytes: 100_000_000, fileCount: 5 });
    expect(whisperWeightsPresent()).toBe(true);
  });
});

/* ── venv package probe (real temp-dir tree) ─────────────────────────────
   model-paths.js mock is still active; dirSizeBytes returns {bytes:0}
   by default (beforeEach), so whisperWeightsPresent() -> false, giving
   'weights-missing' whenever the package is present but weights aren't. */

/** Create a temp repoRoot with given paths under
    <root>/server/tts-sidecar/.venv/. Keys are forward-slash relative paths. */
function makeVenvTree(dirs: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'whisper-test-'));
  for (const rel of Object.keys(dirs)) {
    mkdirSync(join(root, 'server', 'tts-sidecar', '.venv', ...rel.split('/')), {
      recursive: true,
    });
  }
  return root;
}

const tempRoots: string[] = [];

afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function makeTemp(dirs: Record<string, unknown>): string {
  const r = makeVenvTree(dirs);
  tempRoots.push(r);
  return r;
}

describe('whisperPackageInstalled', () => {
  it('whisperPackageInstalled true when faster_whisper present', () => {
    expect(
      whisperPackageInstalled(makeTemp({ 'Lib/site-packages/faster_whisper': {} })),
    ).toBe(true);
  });

  it('whisperPackageInstalled false when absent', () => {
    expect(whisperPackageInstalled(makeTemp({}))).toBe(false);
  });
});

describe('detectWhisperInstallStateOnDisk', () => {
  it('detectWhisperInstallStateOnDisk: no package -> not-installed', () => {
    expect(detectWhisperInstallStateOnDisk(makeTemp({}))).toBe('not-installed');
  });

  it('detectWhisperInstallStateOnDisk: package present, weights absent -> weights-missing', () => {
    // dirSizeBytes returns {bytes:0} by default -> whisperWeightsPresent() false
    const root = makeTemp({ 'Lib/site-packages/faster_whisper': {} });
    expect(detectWhisperInstallStateOnDisk(root)).toBe('weights-missing');
  });

  it('detectWhisperInstallStateOnDisk: package + weights present -> ready', () => {
    mockDirSizeBytes.mockReturnValue({ bytes: 150_000_000, fileCount: 3 });
    const root = makeTemp({ 'Lib/site-packages/faster_whisper': {} });
    expect(detectWhisperInstallStateOnDisk(root)).toBe('ready');
  });
});
