import { describe, it, expect } from 'vitest';
import { PAIR_RULES, assertPairRulesResolvable } from './pair-rules.js';

/* Independent review of PR #2205, finding F7 — a PairRule referencing a
   deleted/typo'd knob key used to silently mis-validate (values[k] left
   unset -> stringified to "undefined" -> asrDeviceFamily("undefined")
   resolves to 'cpu') instead of failing. assertPairRulesResolvable is the
   guard: it's called at pair-rules.ts's own module load against the real
   PAIR_RULES (so a stale table fails the moment the process/test imports
   it), and is exported so that invariant is independently testable here
   against a deliberately-broken table too — not just observed to not-throw
   for the real one. */
describe('assertPairRulesResolvable (#2205 review F7)', () => {
  it('throws when a rule references a knob key the registry does not have', () => {
    expect(() =>
      assertPairRulesResolvable([
        { keys: ['no.such.knob', 'qa.asr.computeType'], check: () => null },
      ]),
    ).toThrow(/no\.such\.knob/);
  });

  it('throws naming whichever of the two keys is unresolvable, not just the first', () => {
    expect(() =>
      assertPairRulesResolvable([
        { keys: ['qa.asr.device', 'no.such.knob.either'], check: () => null },
      ]),
    ).toThrow(/no\.such\.knob\.either/);
  });

  it('does not throw for a rule whose keys both resolve', () => {
    expect(() =>
      assertPairRulesResolvable([
        { keys: ['qa.asr.device', 'qa.asr.computeType'], check: () => null },
      ]),
    ).not.toThrow();
  });

  it('the real, exported PAIR_RULES table resolves against the live registry (defence against a future #2177-shaped deletion)', () => {
    expect(() => assertPairRulesResolvable(PAIR_RULES)).not.toThrow();
    // Called with no argument at all, PAIR_RULES is the default.
    expect(() => assertPairRulesResolvable()).not.toThrow();
  });
});
