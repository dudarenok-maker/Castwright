import { describe, it, expect } from 'vitest';
import { describeVramBlockers } from './describe-vram-blockers.js';

describe('describeVramBlockers', () => {
  it('does not list Coqui — admission auto-evicts an idle one (#1894)', () => {
    expect(describeVramBlockers({ coquiLoaded: true })).toEqual([]);
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

  it('lists Kokoro only when both Coqui and Kokoro are resident', () => {
    expect(describeVramBlockers({ coquiLoaded: true, kokoroLoaded: true })).toHaveLength(1);
  });

  it('never names a Qwen base — admission frees those itself', () => {
    /* Task 8's lever already handles an idle Qwen tier, so telling the user to go
       do it by hand would be noise. */
    expect(describeVramBlockers({ qwenLoaded: true, qwenBase17Loaded: true })).toEqual([]);
  });

  it('returns nothing when the sidecar reported nothing resident', () => {
    expect(describeVramBlockers({})).toEqual([]);
  });

  it('names an in-progress voice design as a blocker (#2678)', () => {
    /* While genuinely in-flight (a design forward actively computing), there
       is no auto-evict at all — same as a resident Qwen base or Coqui mid-
       forward. Once merely resident-and-idle, the sidecar's own admission
       ladder DOES auto-evict it (ttl 0) as a side effect of the next
       admission attempt — but that's a side effect of a later retry, not of
       the request that has already been denied, so "wait it out" is still
       the whole correct remedy either way. */
    const out = describeVramBlockers({ qwenDesignResident: true });
    expect(out).toEqual([
      {
        model: 'A voice design',
        remedy: 'Wait for the in-progress voice design to finish — it frees automatically once idle.',
      },
    ]);
  });
});
