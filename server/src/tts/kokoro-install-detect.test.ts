/* Unit tests for detectKokoroInstalledOnDisk — mocks model-paths.js
   (kokoroWeightPaths + totalSizeBytes) and asserts the fileCount > 0 predicate. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./model-paths.js', () => ({
  kokoroWeightPaths: vi.fn(() => [] as string[]),
  totalSizeBytes: vi.fn(() => ({ bytes: 0, fileCount: 0 })),
}));

import { detectKokoroInstalledOnDisk } from './kokoro-install-detect.js';
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
