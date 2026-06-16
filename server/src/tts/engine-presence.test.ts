/* Unit tests for anyTtsEnginePresent — mocks all three detectors and
   asserts the OR matrix (all absent → false; each individually present → true).
   Also tests readinessSeverity (fail-open severity helper). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./model-paths.js', () => ({
  kokoroWeightPaths: vi.fn(() => [] as string[]),
  totalSizeBytes: vi.fn(() => ({ bytes: 0, fileCount: 0 })),
}));

vi.mock('./coqui-install-detect.js', () => ({
  coquiWeightsPresent: vi.fn(() => false),
  detectCoquiInstallStateOnDisk: vi.fn(() => 'not-installed' as const),
}));

vi.mock('./qwen-install-detect.js', () => ({
  detectQwenInstallStateOnDisk: vi.fn(() => 'not-installed' as const),
}));

import { anyTtsEnginePresent, readinessSeverity } from './engine-presence.js';
import { totalSizeBytes } from './model-paths.js';
import { detectCoquiInstallStateOnDisk } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';

const mockTotalSizeBytes = vi.mocked(totalSizeBytes);
const mockDetectCoqui = vi.mocked(detectCoquiInstallStateOnDisk);
const mockDetectQwen = vi.mocked(detectQwenInstallStateOnDisk);

beforeEach(() => {
  mockTotalSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
  mockDetectCoqui.mockReturnValue('not-installed');
  mockDetectQwen.mockReturnValue('not-installed');
});

/* ── temp-tree helpers (for Kokoro package presence, which is a real-FS check) ── */

const tempRoots: string[] = [];

afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

/** Create a temp repoRoot with kokoro_onnx package dir present under
    server/tts-sidecar/.venv/Lib/site-packages/ (Windows layout). */
function makeRepoWithKokoroPackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'ep-test-'));
  tempRoots.push(root);
  mkdirSync(
    join(root, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'kokoro_onnx'),
    { recursive: true },
  );
  return root;
}

/** Create a temp repoRoot with NO kokoro_onnx package dir. */
function makeRepoWithoutKokoroPackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'ep-test-'));
  tempRoots.push(root);
  return root;
}

describe('anyTtsEnginePresent', () => {
  it('returns false when all engines are absent', () => {
    expect(anyTtsEnginePresent(makeRepoWithoutKokoroPackage())).toBe(false);
  });

  it('returns true when Kokoro package + weights are both present', () => {
    mockTotalSizeBytes.mockReturnValue({ bytes: 1_000_000, fileCount: 3 });
    expect(anyTtsEnginePresent(makeRepoWithKokoroPackage())).toBe(true);
  });

  it('returns true when only Coqui is ready', () => {
    mockDetectCoqui.mockReturnValue('ready');
    expect(anyTtsEnginePresent(makeRepoWithoutKokoroPackage())).toBe(true);
  });

  it('returns true when only Qwen state is ready', () => {
    mockDetectQwen.mockReturnValue('ready');
    expect(anyTtsEnginePresent(makeRepoWithoutKokoroPackage())).toBe(true);
  });

  it('anyTtsEnginePresent requires ready (package+weights), not weights alone', () => {
    // Kokoro WEIGHTS are present (fileCount > 0) but the kokoro_onnx PACKAGE is absent → false
    mockTotalSizeBytes.mockReturnValue({ bytes: 1_000_000, fileCount: 3 });
    const repoKokoroWeightsNoPackage = makeRepoWithoutKokoroPackage();
    expect(anyTtsEnginePresent(repoKokoroWeightsNoPackage)).toBe(false);
  });

  it('a fresh box reaches ready once Kokoro package + weights are present', () => {
    mockTotalSizeBytes.mockReturnValue({ bytes: 1_000_000, fileCount: 3 });
    const repoKokoroReady = makeRepoWithKokoroPackage();
    expect(anyTtsEnginePresent(repoKokoroReady)).toBe(true);
  });
});

describe('readinessSeverity', () => {
  it('ready state → ok', () => {
    expect(readinessSeverity({ engine: 'kokoro', state: 'ready', sidecarConfirmed: false })).toBe('ok');
  });

  it('loaded state → ok', () => {
    expect(readinessSeverity({ engine: 'kokoro', state: 'loaded', sidecarConfirmed: false })).toBe('ok');
  });

  it('package-missing warns unless sidecar-confirmed', () => {
    expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: false })).toBe('warn');
    expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: true })).toBe('block');
  });

  it('weights-missing → warn', () => {
    expect(readinessSeverity({ engine: 'kokoro', state: 'weights-missing', sidecarConfirmed: false })).toBe('warn');
  });

  it('not-installed secondary engine is info', () => {
    expect(readinessSeverity({ engine: 'coqui', state: 'not-installed', sidecarConfirmed: false })).toBe('info');
  });

  it('not-installed standard engine is warn', () => {
    expect(readinessSeverity({ engine: 'kokoro', state: 'not-installed', sidecarConfirmed: false })).toBe('warn');
  });
});
