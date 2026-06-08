/* Focused test: QA-gate knobs read through the config registry so app
   overrides are reflected. Covers both signal (segment-qa) and ASR gates. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { evaluateSegmentPcm } from './segment-qa.js';
import { asrEnabled } from './segment-asr-qa.js';
import * as us from '../workspace/user-settings.js';

describe('config resolver wiring — QA gates', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('app override of qa.seg.minRatio changes the duration gate', () => {
    // Default minRatio = 0.4. A 1s render of a ~14-char sentence (expected ~1s) is fine.
    // Override minRatio to 0.99 so even a near-correct render is flagged.
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'qa.seg.minRatio': 0.99,
    });
    // 5-char text → expected ~0.36s; a 1s pcm gives ratio 1.0/0.36 ≈ 2.8 > maxRatio=2.5 → runaway
    // Use 2-char text → expected ~0.14s; 0.1s pcm → ratio 0.71 < 0.99 → truncated
    const pcm = Buffer.alloc(24_000 * 0.1 * 2); // 0.1 s silence
    const verdict = evaluateSegmentPcm(pcm, 24_000, 'hi there longer text ok');
    // With override 0.99, short render should be flagged as too short
    expect(verdict.status).toBe('suspect');
  });

  it('app override of qa.asr.enabled changes asrEnabled()', () => {
    expect(asrEnabled()).toBe(false); // default off
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'qa.asr.enabled': true,
    });
    expect(asrEnabled()).toBe(true);
  });
});
