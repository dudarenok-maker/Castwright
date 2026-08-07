/* Cross-field validation for PUT /api/config (#2180).

   coerceAndValidate (resolver.ts) validates one knob against its own patch
   value in isolation — it has no view of any OTHER knob, so a patch that sets
   qa.asr.device=cpu while qa.asr.computeType is already pinned to
   int8_float16 (a cuda-only compute type) succeeds today and 500s every
   /transcribe. This module is the small, declarative mechanism the PUT route
   applies AFTER every per-key coercion in a patch has already succeeded: each
   rule names the knob keys it cares about and a `check` over the RESULTING
   EFFECTIVE values (the patch value where the patch touches that key,
   otherwise the value already in effect) — never just the incoming patch.

   Built for exactly one rule; a second cross-field rule joins this same
   array rather than growing a general constraint engine. */

import { getKnob } from './registry.js';

export interface PairRule {
  /** The knob keys this rule reads. The route only runs a rule when the
      patch touches at least one of them. */
  keys: [string, string];
  /** Returns an error string (400 body) when the pair is invalid, or null
      when it's fine. Receives the resulting EFFECTIVE value for each of
      `keys` (patch value if patched, else the value already in effect). */
  check: (values: Record<string, number | boolean | string>) => string | null;
}

/* CTranslate2 compute types WhisperModel actually accepts per device family.
   get_supported_compute_types() is BUILD- and HARDWARE-dependent — this is
   one box's measured answer (ctranslate2 4.8.0, this dev box, 2026-08), not a
   spec, and would need re-measuring on a different CT2 build. Deliberately a
   narrow allowlist per family rather than trying to derive it generically: a
   false rejection is recoverable (hand-edit server/.env, which bypasses
   save-time validation by design); a false acceptance is the defect being
   fixed here, so the table errs toward rejecting.

   'int16' is a registered enum option on qa.asr.computeType but is NOT in
   either set below — it was measured to fail on both cpu and cuda on this
   box, so it's correctly rejected by the pair rule regardless of device
   (removing it from the enum entirely is a separate, out-of-scope change). */
const CT2_SUPPORTED_COMPUTE_TYPES: Record<'cpu' | 'cuda', ReadonlySet<string>> = {
  cpu: new Set(['float32', 'int8', 'int8_float32']),
  cuda: new Set(['bfloat16', 'float16', 'float32', 'int8', 'int8_bfloat16', 'int8_float16', 'int8_float32']),
};

/* Sentinels are self-negotiating and can never raise CT2's "device or backend
   do not support efficient X computation" error — admitted on every device.
   'sidecar-default' is main.py's own unset/empty stand-in (_compute_type);
   'auto' and 'default' are CT2's own vocabulary. */
const ASR_COMPUTE_TYPE_SENTINELS = new Set(['sidecar-default', 'auto', 'default']);

/** cpu | auto | cuda | cuda:<n> -> the CT2 device family it loads on.
    'auto' resolves to CPU for Whisper specifically — main.py's `_ct2_kwargs`
    maps family 'auto' to device='cpu' (unlike Kokoro/Qwen's own 'auto',
    which genuinely device-selects) — so it shares the cpu allowlist. */
function asrDeviceFamily(device: string): 'cpu' | 'cuda' {
  return device.trim().toLowerCase().startsWith('cuda') ? 'cuda' : 'cpu';
}

const ASR_DEVICE_COMPUTE_TYPE_RULE: PairRule = {
  keys: ['qa.asr.device', 'qa.asr.computeType'],
  check: (values) => {
    const device = String(values['qa.asr.device']);
    const computeType = String(values['qa.asr.computeType']);
    if (ASR_COMPUTE_TYPE_SENTINELS.has(computeType)) return null;
    const family = asrDeviceFamily(device);
    const supported = CT2_SUPPORTED_COMPUTE_TYPES[family];
    if (supported.has(computeType)) return null;
    return (
      `qa.asr.device=${device} + qa.asr.computeType=${computeType} is an unsupported pair — `
      + `${computeType} is not available on ${family === 'cuda' ? 'a cuda' : 'a cpu (or auto)'} device. `
      + `Supported compute types here: ${[...supported].join(', ')} `
      + `(or the sentinels: ${[...ASR_COMPUTE_TYPE_SENTINELS].join(', ')}).`
    );
  },
};

export const PAIR_RULES: PairRule[] = [ASR_DEVICE_COMPUTE_TYPE_RULE];

/* Independent review of PR #2205, finding F7: `PUT`'s pass 2 (and now
   `POST /reset`'s mirror of it) silently skips a rule key when `getKnob(k)`
   returns undefined, leaving that key unset in `values` — `check()` then
   stringifies the missing entry to the literal string `"undefined"`, and
   `asrDeviceFamily("undefined")` resolves that to `'cpu'`, so the rule
   quietly validates against the WRONG family instead of failing. That shape
   is not hypothetical: #2177 deleted a `qa.asr.*` key in this very PR. A rule
   referencing a knob key the registry no longer has is a stale table, not a
   user-input problem, so it fails at IMPORT time instead of waiting to
   mis-validate the next request. Exported (not a bare top-level statement)
   so it's independently unit-testable against a deliberately-broken table,
   not just observed to not-throw for the real one. */
export function assertPairRulesResolvable(rules: PairRule[] = PAIR_RULES): void {
  for (const rule of rules) {
    for (const key of rule.keys) {
      if (!getKnob(key)) {
        throw new Error(
          `[pair-rules] PairRule references "${key}", which has no matching knob in the registry — the rule went stale.`,
        );
      }
    }
  }
}
assertPairRulesResolvable();
