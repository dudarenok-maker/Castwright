/* Unit tests for anyTtsEnginePresent — mocks all three detectors and
   asserts the OR matrix (all absent → false; each individually present → true). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./model-paths.js', () => ({
  kokoroWeightPaths: vi.fn(() => [] as string[]),
  totalSizeBytes: vi.fn(() => ({ bytes: 0, fileCount: 0 })),
}));

vi.mock('./coqui-install-detect.js', () => ({
  coquiWeightsPresent: vi.fn(() => false),
}));

vi.mock('./qwen-install-detect.js', () => ({
  detectQwenInstallStateOnDisk: vi.fn(() => 'not-installed'),
}));

import { anyTtsEnginePresent } from './engine-presence.js';
import { totalSizeBytes } from './model-paths.js';
import { coquiWeightsPresent } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';

const mockTotalSizeBytes = vi.mocked(totalSizeBytes);
const mockCoquiWeightsPresent = vi.mocked(coquiWeightsPresent);
const mockDetectQwen = vi.mocked(detectQwenInstallStateOnDisk);

beforeEach(() => {
  mockTotalSizeBytes.mockReturnValue({ bytes: 0, fileCount: 0 });
  mockCoquiWeightsPresent.mockReturnValue(false);
  mockDetectQwen.mockReturnValue('not-installed');
});

describe('anyTtsEnginePresent', () => {
  it('returns false when all engines are absent', () => {
    expect(anyTtsEnginePresent('/repo')).toBe(false);
  });

  it('returns true when only Kokoro weights are present (fileCount > 0)', () => {
    mockTotalSizeBytes.mockReturnValue({ bytes: 1_000_000, fileCount: 3 });
    expect(anyTtsEnginePresent('/repo')).toBe(true);
  });

  it('returns true when only Coqui weights are present', () => {
    mockCoquiWeightsPresent.mockReturnValue(true);
    expect(anyTtsEnginePresent('/repo')).toBe(true);
  });

  it('returns true when only Qwen state is ready', () => {
    mockDetectQwen.mockReturnValue('ready');
    expect(anyTtsEnginePresent('/repo')).toBe(true);
  });
});
