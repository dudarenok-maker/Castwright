/* Unit tests for detectKokoroInstalledOnDisk — mocks model-paths.js
   (kokoroWeightPaths + totalSizeBytes) and asserts the fileCount > 0 predicate.
   Also tests kokoroPackageInstalled + detectKokoroInstallStateOnDisk using a
   real temp-dir venv tree (same pattern as qwen-install-detect.test.ts). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./model-paths.js', () => ({
  kokoroWeightPaths: vi.fn(() => [] as string[]),
  totalSizeBytes: vi.fn(() => ({ bytes: 0, fileCount: 0 })),
}));

import {
  detectKokoroInstalledOnDisk,
  kokoroPackageInstalled,
  detectKokoroInstallStateOnDisk,
} from './kokoro-install-detect.js';
import { kokoroWeightPaths, totalSizeBytes } from './model-paths.js';

const mockKokoroWeightPaths = vi.mocked(kokoroWeightPaths);
const mockTotalSizeBytes = vi.mocked(totalSizeBytes);

beforeEach(() => {
  mockKokoroWeightPaths.mockReturnValue([]);
  mockTotalSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
});

describe('detectKokoroInstalledOnDisk', () => {
  it('returns false when fileCount is 0 (no weight files found)', () => {
    mockTotalSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
    expect(detectKokoroInstalledOnDisk('/repo')).toBe(false);
  });

  it('returns true when fileCount is 2 (both weight files present)', () => {
    mockKokoroWeightPaths.mockReturnValue(['/repo/kokoro-v1.0.onnx', '/repo/voices-v1.0.bin']);
    mockTotalSizeBytes.mockReturnValue({ bytes: 500_000_000, fileCount: 2 });
    expect(detectKokoroInstalledOnDisk('/repo')).toBe(true);
  });

  it('returns true when fileCount is 1 (partial install still counts as present)', () => {
    mockKokoroWeightPaths.mockReturnValue(['/repo/kokoro-v1.0.onnx']);
    mockTotalSizeBytes.mockReturnValue({ bytes: 300_000_000, fileCount: 1 });
    expect(detectKokoroInstalledOnDisk('/repo')).toBe(true);
  });

  it('passes the weight paths from kokoroWeightPaths into totalSizeBytes', () => {
    const paths = ['/repo/kokoro-v1.0.onnx', '/repo/voices-v1.0.bin'];
    mockKokoroWeightPaths.mockReturnValue(paths);
    mockTotalSizeBytes.mockReturnValue({ bytes: 500_000_000, fileCount: 2 });
    detectKokoroInstalledOnDisk('/repo');
    expect(mockTotalSizeBytes).toHaveBeenCalledWith(paths);
  });
});

/* ── kokoroPackageInstalled + detectKokoroInstallStateOnDisk ─────────────────
   Real-filesystem tests (temp-dir venv tree). The model-paths.js mock is still
   active here: totalSizeBytes returns { fileCount: 0 } by default (beforeEach),
   so detectKokoroInstalledOnDisk(root) → false, giving us 'weights-missing'
   whenever the package is present but we haven't seeded weights. */

/** Create a temp repoRoot with the given relative paths created under
    <root>/server/tts-sidecar/.venv/. Keys are forward-slash relative paths;
    values unused (only dirs are created). Returns the repoRoot. */
function makeVenvTree(dirs: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'kokoro-test-'));
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

describe('kokoroPackageInstalled', () => {
  it('kokoroPackageInstalled true when kokoro_onnx dir present', () => {
    const root = makeTemp({ 'Lib/site-packages/kokoro_onnx': {} });
    expect(kokoroPackageInstalled(root)).toBe(true);
  });

  it('kokoroPackageInstalled false when absent', () => {
    expect(kokoroPackageInstalled(makeTemp({}))).toBe(false);
  });
});

describe('detectKokoroInstallStateOnDisk', () => {
  it('detectKokoroInstallStateOnDisk: package present, weights absent → weights-missing', () => {
    const root = makeTemp({ 'Lib/site-packages/kokoro_onnx': {} }); // no weights
    expect(detectKokoroInstallStateOnDisk(root)).toBe('weights-missing');
  });

  it('detectKokoroInstallStateOnDisk: no package → not-installed', () => {
    expect(detectKokoroInstallStateOnDisk(makeTemp({}))).toBe('not-installed');
  });
});
