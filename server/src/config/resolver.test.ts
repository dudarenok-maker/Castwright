import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

vi.mock('../gpu/gpu-device-list-state.js', () => ({
  getLastKnownGpuDevices: vi.fn(() => []),
}));

import {
  resolveKnob,
  resolveKnobForSidecarEnv,
  coerceAndValidate,
  configValue,
  isEnvValueRejected,
} from './resolver.js';
import { getKnob } from './registry.js';
import * as us from '../workspace/user-settings.js';
import * as gds from '../gpu/gpu-device-list-state.js';

const KEY = 'analyzer.stage2.minCoverage'; // number, env STAGE2_MIN_COVERAGE, default 0.6

describe('resolver precedence', () => {
  beforeEach(() => {
    delete process.env.STAGE2_MIN_COVERAGE;
    (us.readConfigOverrides as any).mockReturnValue({});
  });

  it('falls back to shipped default', () => {
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.6, source: 'default', locked: false, overridden: false });
  });

  it('app override beats default', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.55, source: 'override', locked: false, overridden: true });
  });

  it('env beats override and locks', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    process.env.STAGE2_MIN_COVERAGE = '0.7';
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.7, source: 'env', locked: true, overridden: false });
  });

  it('coerceAndValidate enforces type and range', () => {
    const knob = getKnob(KEY)!;
    expect(coerceAndValidate(knob, '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(coerceAndValidate(knob, '2').ok).toBe(false); // > max 1
    expect(coerceAndValidate(knob, 'nope').ok).toBe(false);
  });

  it('an invalid env value is ignored — falls through to override/default', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    process.env.STAGE2_MIN_COVERAGE = 'not-a-number';
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.55, source: 'override', locked: false });
  });

  it('coerces boolean env values', () => {
    const knob = getKnob('qa.asr.enabled')!; // boolean, env SEG_ASR_ENABLED
    expect(coerceAndValidate(knob, 'true')).toEqual({ ok: true, value: true });
    expect(coerceAndValidate(knob, '1')).toEqual({ ok: true, value: true });
    expect(coerceAndValidate(knob, 'off')).toEqual({ ok: true, value: false });
    expect(coerceAndValidate(knob, 'maybe').ok).toBe(false);
  });

  it('validates enum options', () => {
    // tts.accelerator stays an enum exemplar (tts.coqui.device widened to string in Wave 1)
    expect(coerceAndValidate(getKnob('tts.accelerator')!, 'nvidia')).toEqual({ ok: true, value: 'nvidia' });
    expect(coerceAndValidate(getKnob('tts.accelerator')!, 'tpu').ok).toBe(false);
  });

  it('configValue throws on an unknown key', () => {
    expect(() => configValue('no.such.knob')).toThrow(/unknown config key/);
  });

  // #2180 correction 1 — qa.asr.device is free-form `type: 'string'` with no
  // `options` array, so `cuda`, `cuda:1`, and a typo like `cuda1` were all
  // equally "valid" at the coercion layer. Constrained to
  // cpu | auto | cuda | cuda:<n> via a new general `pattern` capability on
  // the knob shape (coerceAndValidate's string/default case). Widened by
  // #2224 — see the dedicated grammar suite below for the full mps/rocm story.
  it('qa.asr.device is constrained to cpu | auto | cuda | cuda:<n> via a pattern', () => {
    const knob = getKnob('qa.asr.device')!;
    expect(coerceAndValidate(knob, 'cpu')).toEqual({ ok: true, value: 'cpu' });
    expect(coerceAndValidate(knob, 'auto')).toEqual({ ok: true, value: 'auto' });
    expect(coerceAndValidate(knob, 'cuda')).toEqual({ ok: true, value: 'cuda' });
    expect(coerceAndValidate(knob, 'cuda:1')).toEqual({ ok: true, value: 'cuda:1' });
    expect(coerceAndValidate(knob, 'CUDA:1')).toEqual({ ok: true, value: 'CUDA:1' }); // case-insensitive
    expect(coerceAndValidate(knob, 'cuda1').ok).toBe(false); // the typo shape named in the decision comment
    expect(coerceAndValidate(knob, 'gpu').ok).toBe(false);
  });

  /* #2224 — the #2180 pattern above was too narrow: it rejected "mps" and
     "rocm", both of which `_parse_device` (main.py:3269-3281) and
     `_engine_env_pin` (main.py:3355-3369) treat as first-class, MEANINGFUL
     device families for both "asr" and "spk" — main.py:10712/:10787 gate GPU
     capacity admission on `_parse_device(...)[0] in ("cuda", "rocm")`. A Mac
     (ASR_DEVICE=mps) or AMD (ASR_DEVICE=rocm) operator had their pin silently
     rejected and downgraded to cpu — a regression #2180/#2205 shipped, found
     while investigating #2224. This suite ties the pattern to what main.py
     ACTUALLY parses as meaningful, not to a hand-typed list: every accepted
     form is one this suite's own comment traces to a main.py line, and the
     two forms deliberately excluded (see registry.ts's pattern comment) are
     asserted rejected here too, so the exclusion can't silently erode. */
  describe('qa.asr.device / qa.speaker.device grammar, derived from main.py (#2224)', () => {
    const KNOBS = ['qa.asr.device', 'qa.speaker.device'] as const;

    it.each(KNOBS)('%s accepts every device family main.py parses as meaningful', (key) => {
      const knob = getKnob(key)!;
      // cpu/auto: _parse_device's own explicit branches (main.py:3274-3277).
      expect(coerceAndValidate(knob, 'cpu')).toEqual({ ok: true, value: 'cpu' });
      expect(coerceAndValidate(knob, 'auto')).toEqual({ ok: true, value: 'auto' });
      // mps: _parse_device's explicit `p in ("cpu", "mps")` branch (:3276-3277).
      expect(coerceAndValidate(knob, 'mps')).toEqual({ ok: true, value: 'mps' });
      expect(coerceAndValidate(knob, 'MPS')).toEqual({ ok: true, value: 'MPS' }); // case-insensitive
      // cuda / cuda:<n>: the startswith("cuda") branch (:3278-3280).
      expect(coerceAndValidate(knob, 'cuda')).toEqual({ ok: true, value: 'cuda' });
      expect(coerceAndValidate(knob, 'cuda:1')).toEqual({ ok: true, value: 'cuda:1' });
      expect(coerceAndValidate(knob, 'CUDA:1')).toEqual({ ok: true, value: 'CUDA:1' });
      // bare rocm: falls through _parse_device's catch-all (:3281) to family
      // "rocm" exactly (only because the whole trimmed/lowercased string IS
      // "rocm") — the form main.py:10712/:10787's `in ("cuda","rocm")` checks
      // actually match, and this repo ships a real amd-rocm torch overlay.
      expect(coerceAndValidate(knob, 'rocm')).toEqual({ ok: true, value: 'rocm' });
      expect(coerceAndValidate(knob, 'ROCM')).toEqual({ ok: true, value: 'ROCM' });
    });

    it.each(KNOBS)('%s still rejects a genuinely malformed value — the pattern exists to catch typos, not to accept everything', (key) => {
      const knob = getKnob(key)!;
      expect(coerceAndValidate(knob, 'cuda1').ok).toBe(false); // the original #2207 typo case
      expect(coerceAndValidate(knob, 'gpu').ok).toBe(false);
    });

    it.each(KNOBS)('%s rejects an indexed rocm pin ("rocm:1") — main.py cannot actually place it', (key) => {
      // _parse_device's catch-all only splits an index off a string that
      // STARTS WITH "cuda" (:3278-3280); a non-cuda-prefixed string comes
      // back as its own whole "family", so "rocm:1" parses as family
      // "rocm:1" (not "rocm"), which fails every `in ("cuda","rocm")` check
      // main.py has. Accepting it here would pass a value through the
      // resolver that main.py cannot place on any device.
      const knob = getKnob(key)!;
      expect(coerceAndValidate(knob, 'rocm:1').ok).toBe(false);
    });

    it.each(KNOBS)('%s rejects a cuda-uuid pin — WhisperEngine/SpeakerEngine read the raw env var directly, bypassing uuid resolution', (key) => {
      // Unlike tts.coqui.device/tts.kokoro.device/tts.qwen.device (type:
      // 'device', whose engine constructors read via `_read_device_env`,
      // which DOES resolve a "cuda-uuid:<uuid>" pin, main.py:3341-3352),
      // WhisperEngine/SpeakerEngine read `os.environ.get("ASR_DEVICE"/
      // "SPK_DEVICE", "cpu")` directly at construction (main.py:7148, :7488)
      // — the resolving reader is used only by `_engine_env_pin`, which
      // feeds the capacity ledger's PIN METADATA, not actual device
      // placement. A uuid form would resolve correctly for capacity
      // bookkeeping and WRONGLY for where the model actually loads, so it's
      // excluded — consistent with these two knobs being `type: 'string'`,
      // not `type: 'device'` (only 'device' knobs get resolveKnobInner's
      // uuid-reconcile branch).
      const knob = getKnob(key)!;
      expect(coerceAndValidate(knob, 'cuda-uuid:GPU-1').ok).toBe(false);
    });
  });

  /* Independent review of PR #2205, finding F4 — coerceAndValidate matched
     the pattern against s.trim() but returned the UNTRIMMED raw string, so
     '  CUDA:1  ' passed validation (the trimmed form matches the pattern)
     yet persisted — and reached the sidecar's spawn env — with its
     whitespace intact. The persisted/returned value must be the same
     trimmed form the pattern was actually checked against. */
  it('trims a pattern-matched string knob value before returning it (persisted value has no stray whitespace)', () => {
    const knob = getKnob('qa.asr.device')!;
    expect(coerceAndValidate(knob, '  cuda:1  ')).toEqual({ ok: true, value: 'cuda:1' });
    expect(coerceAndValidate(knob, '  CUDA:1  ')).toEqual({ ok: true, value: 'CUDA:1' }); // trims, keeps case
    expect(coerceAndValidate(knob, '\tcpu\n')).toEqual({ ok: true, value: 'cpu' });
  });

  it('a pattern-less string knob keeps its historical no-trim behaviour', () => {
    const knob = getKnob('qa.asr.model')!; // free-form string, no pattern
    expect(coerceAndValidate(knob, '  base  ')).toEqual({ ok: true, value: '  base  ' });
  });
});

/* Independent review of PR #2219, finding F6 — isEnvValueRejected (consumed
   by buildSidecarEnv, #2207) had no direct unit test; its null/empty/
   whitespace/falsy-but-valid edges were unpinned.

   Two categories, deliberately kept separate:
   (1) a legitimately falsy PARSED value (boolean `false`, numeric `0`) must
       not misfire the `parseEnv(...) == null` check — `==null` only matches
       null/undefined in JS, not other falsy values, but that correctness
       is exactly the kind of thing a later "simplify this to `!v`" edit
       could silently break, so it's pinned here explicitly.
   (2) a blank/whitespace-only RAW value is a SEPARATE case, decided by
       finding F3 in the same review round: resolveKnobInner already treats
       blank identically to "no env var at all" (falls through to override/
       default without validating or warning), so isEnvValueRejected now
       returns true for it too — the same thesis this whole predicate is
       built on (the resolver didn't use the ambient text, so a consumer
       forwarding it verbatim disagrees with the resolver either way).
       NOTE: this supersedes the review's own F6 wording ("false, 0 and ''
       must NOT read as rejected") for the '' case specifically — after F3,
       a blank raw ('' or whitespace) DOES read as rejected. Category (1)'s
       "false, 0" guidance stands unchanged; the '' third of that list is
       the part F3 overrides, and this suite tests the current, F3-
       authorized behaviour rather than the pre-F3 wording. */
describe('isEnvValueRejected (independent review of PR #2219, F6)', () => {
  const NUM_KEY = 'analyzer.stage2.minCoverage'; // number, min 0 max 1, env STAGE2_MIN_COVERAGE
  const BOOL_KEY = 'qa.asr.enabled'; // boolean, env SEG_ASR_ENABLED

  beforeEach(() => {
    delete process.env.STAGE2_MIN_COVERAGE;
    delete process.env.SEG_ASR_ENABLED;
  });

  it('no ambient env var at all (undefined) is not rejected', () => {
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(false);
  });

  it('a knob with no `env` name at all (a prompt knob, env: "") is never rejected', () => {
    expect(isEnvValueRejected(getKnob('prompt.castDetection')!)).toBe(false);
  });

  it('an empty-string ambient value IS rejected (F3 — treated the same as unset by the resolver)', () => {
    process.env.STAGE2_MIN_COVERAGE = '';
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(true);
  });

  it('a whitespace-only ambient value IS rejected (F3 — same reasoning as empty-string)', () => {
    process.env.STAGE2_MIN_COVERAGE = '   ';
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(true);
  });

  it('a falsy-but-VALID numeric value ("0") is not rejected', () => {
    process.env.STAGE2_MIN_COVERAGE = '0'; // within [0,1] — a genuinely valid value
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(false);
  });

  it('a falsy-but-VALID boolean value ("false") is not rejected', () => {
    process.env.SEG_ASR_ENABLED = 'false';
    expect(isEnvValueRejected(getKnob(BOOL_KEY)!)).toBe(false);
  });

  it('an out-of-range value IS rejected', () => {
    process.env.STAGE2_MIN_COVERAGE = '2'; // > max 1
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(true);
  });

  it('a genuinely valid non-falsy value is not rejected', () => {
    process.env.STAGE2_MIN_COVERAGE = '0.7';
    expect(isEnvValueRejected(getKnob(NUM_KEY)!)).toBe(false);
  });
});

describe('resolveKnob — device UUID reconcile (Plan 2 §2.1)', () => {
  beforeEach(() => {
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
  });

  it('translates a stored cuda-uuid override back to cuda:N when the card is currently visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([{ uuid: 'GPU-1', idx: 1 }]);
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda:1');
    expect(st.staleReason).toBeUndefined();
  });

  it('flags uuid_unresolved when the stored uuid matches no currently-visible card', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.staleReason).toBe('uuid_unresolved');
  });
});

describe('resolveKnobForSidecarEnv — deliberately does NOT reconcile (#1857)', () => {
  beforeEach(() => {
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    (us.readConfigOverrides as any).mockReturnValue({});
    delete process.env.QWEN_DEVICE;
  });

  /* The sidecar resolves 'cuda-uuid:' itself against LIVE enumeration on every
     spawn (main.py:1873 _read_device_env). Handing it a pre-translated index
     instead freezes a mapping that buildOpts re-emits on every respawn, which a
     vanished or renumbered card can no longer correct. So this entry point must
     emit the uuid form even when the cache COULD translate it. */
  it('passes a cuda-uuid override through even when the card IS visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([{ uuid: 'GPU-1', idx: 1 }]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GPU-1');
    expect(st.staleReason).toBeUndefined();
  });

  it('passes a cuda-uuid override through when no card matches, WITHOUT flagging stale', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GONE');
    // staleReason is a UI concept; the sidecar decides liveness for itself.
    expect(st.staleReason).toBeUndefined();
  });

  it('is identical to resolveKnob for a non-uuid device value', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda:1' });
    const knob = getKnob('tts.qwen.device')!;
    expect(resolveKnobForSidecarEnv(knob)).toEqual(resolveKnob(knob));
  });

  it('is identical to resolveKnob for a non-device knob', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.9 });
    const knob = getKnob(KEY)!;
    expect(resolveKnobForSidecarEnv(knob)).toEqual(resolveKnob(knob));
  });

  it('still honours an env-locked value', () => {
    process.env.QWEN_DEVICE = 'cpu';
    try {
      const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
      expect(st.effective).toBe('cpu');
      expect(st.source).toBe('env');
      expect(st.locked).toBe(true);
    } finally {
      delete process.env.QWEN_DEVICE;
    }
  });

  it('still falls through to the registry default when nothing is set', () => {
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('auto');
    expect(st.source).toBe('default');
  });
});
