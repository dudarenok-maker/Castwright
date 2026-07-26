import { describe, it, expect } from 'vitest';
import { describeVramBlockers } from './describe-vram-blockers.js';

describe('describeVramBlockers', () => {
  it('names Coqui with the top-bar-pill remedy', () => {
    const out = describeVramBlockers({ coquiLoaded: true });
    expect(out).toEqual([
      { model: 'Coqui XTTS', remedy: 'Stop it from its pill in the top bar.' },
    ]);
  });

  it('names Kokoro with the preload-setting remedy, not "stop it"', () => {
    /* Kokoro DOES have a Stop pill (Task 10, #1839) — but it's the
       eagerly-resident fallback gated by the "Preload Kokoro at startup"
       setting, so stopping it only frees the VRAM until the sidecar next
       restarts. The durable, actionable remedy is the setting, not the
       button. */
    const out = describeVramBlockers({ kokoroLoaded: true });
    expect(out).toEqual([
      { model: 'Kokoro', remedy: 'Turn off "Preload Kokoro at startup" in settings.' },
    ]);
  });

  it('lists both when both are resident', () => {
    expect(describeVramBlockers({ coquiLoaded: true, kokoroLoaded: true })).toHaveLength(2);
  });

  it('never names a Qwen base — admission frees those itself', () => {
    /* Task 8's lever already handles an idle Qwen tier, so telling the user to go
       do it by hand would be noise. */
    expect(describeVramBlockers({ qwenLoaded: true, qwenBase17Loaded: true })).toEqual([]);
  });

  it('returns nothing when the sidecar reported nothing resident', () => {
    expect(describeVramBlockers({})).toEqual([]);
  });
});
