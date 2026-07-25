import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('./embed-client.js', () => ({ embedSegment: vi.fn() }));
import { embedSegment } from './embed-client.js';
import { assessCloneFidelity, CLONE_FIDELITY_MIN } from './clone-fidelity.js';

afterEach(() => vi.resetAllMocks());

describe('assessCloneFidelity', () => {
  it('returns a high cosine with no warning for near-identical embeddings', async () => {
    (embedSegment as ReturnType<typeof vi.fn>).mockResolvedValue(Float32Array.from([1, 0, 0]));
    const res = await assessCloneFidelity(Buffer.from([1]), Buffer.from([2]), 24000);
    expect(res.cosine).toBeCloseTo(1, 5);
    expect(res.warning).toBeUndefined();
  });

  it('warns (non-blocking) when the cosine is below the threshold', async () => {
    (embedSegment as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(Float32Array.from([1, 0, 0]))
      .mockResolvedValueOnce(Float32Array.from([0, 1, 0])); // orthogonal → cosine 0
    const res = await assessCloneFidelity(Buffer.from([1]), Buffer.from([2]), 24000);
    expect(res.cosine).toBeLessThan(CLONE_FIDELITY_MIN);
    expect(res.warning).toMatch(/loosely/i);
  });
});
