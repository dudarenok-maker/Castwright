import { describe, it, expect } from 'vitest';
import { describeVramBlockers } from './describe-vram-blockers.js';

describe('describeVramBlockers', () => {
  it('does not list Coqui — admission auto-evicts an idle one (#1894)', () => {
    expect(describeVramBlockers({ coquiLoaded: true })).toEqual([]);
  });

  it('names Kokoro with the preload-setting remedy when Preload Kokoro IS on', () => {
    /* Kokoro DOES have a Stop pill (Task 10, #1839) — but when it's the
       eagerly-resident fallback gated by the "Preload Kokoro at startup"
       setting, stopping it only frees the VRAM until the sidecar next
       restarts. The durable, actionable remedy is the setting, not the
       button. */
    const out = describeVramBlockers({ kokoroLoaded: true, kokoroPreload: true });
    expect(out).toEqual([
      { model: 'Kokoro', remedy: 'Turn off "Preload Kokoro at startup" in settings.' },
    ]);
  });

  it('#4066: never tells the user to turn off Preload Kokoro when it is already off — names the Stop control instead', () => {
    /* Kokoro loads on demand (a render that fell back to it) with preload
       off — the default. The old copy said "Turn off Preload Kokoro" anyway. */
    for (const kokoroPreload of [false, undefined]) {
      const out = describeVramBlockers({ kokoroLoaded: true, kokoroPreload });
      expect(out).toHaveLength(1);
      expect(out[0].remedy).not.toMatch(/Preload Kokoro/);
      expect(out[0].remedy).toBe('Press "Stop Kokoro" in the "Voice engines loaded" row under the top bar.');
    }
  });

  it('#4066: does not name a CPU-resident Kokoro — it holds no GPU memory', () => {
    expect(describeVramBlockers({ kokoroLoaded: true, kokoroDevice: 'cpu' })).toEqual([]);
  });

  it('#4066: names the standard Qwen model as in use by a render when a render is in flight', () => {
    /* The auto-free declines during a render (it would unload the model the
       render is using), so the honest remedy is to wait or pause. */
    const out = describeVramBlockers({ qwenLoaded: true, generationActive: true });
    expect(out).toEqual([
      {
        model: 'The standard Qwen voice model',
        remedy: 'It is in use by the chapter render in progress — wait for the render to finish, or pause it, then try again.',
      },
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
