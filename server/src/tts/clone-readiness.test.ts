/* Plan 276 (fs-cast-readiness), Decision 3 — fixture table for the
   purpose-built `cloneReadiness` predicate. Every case here is
   mutation-verified against the producer (see the commit message for the
   mutation table); never mutate an assertion to "prove" a case — mutate
   `clone-readiness.ts` and confirm the case reddens, then revert. */

import { describe, it, expect } from 'vitest';
import { cloneReadiness, type CloneReadinessInput, type CloneUnready } from './clone-readiness.js';

interface Case {
  name: string;
  input: CloneReadinessInput;
  expected: CloneUnready | null;
}

/* A fully healthy Coqui input: entry found, consent intact, no derive
   pending yet (slotStatus undefined), master + transcript present, and the
   character carries its own coqui cast slot. */
const base: CloneReadinessInput = {
  libraryUuidResolvable: true,
  entryFound: true,
  consentRevoked: false,
  slotStatus: undefined,
  hasMaster: true,
  transcript: 'a transcript',
  engine: 'coqui',
  characterHasSlot: true,
};

const cases: Case[] = [
  {
    // Rule 1 (#2912). A cloned slot with no libraryUuid at all — the render
    // classifies this as `misconfigured` (clone-voice-resolver.ts `!libraryUuid`
    // check). Mutation: delete rule 1 -> red (falls through to null or another
    // rule, since the rest of this input is otherwise healthy).
    name: 'unresolvable-uuid: libraryUuidResolvable:false -> unresolvable-uuid regardless of every other field',
    input: {
      ...base,
      libraryUuidResolvable: false,
      entryFound: true,
      consentRevoked: true,
      slotStatus: 'failed',
      hasMaster: false,
      transcript: '',
      characterHasSlot: false,
    },
    expected: 'unresolvable-uuid',
  },
  {
    // Rule 1 outranks rule 2 — a missing UUID fires before consent is even
    // inspected, because there is nothing to look the consent up against.
    name: 'unresolvable-uuid outranks entryFound:false (no UUID means no lookup at all)',
    input: { ...base, libraryUuidResolvable: false, entryFound: false },
    expected: 'unresolvable-uuid',
  },
  {
    // Rule 8. The most important case: rev 1's fatal bug (borrowing
    // `classifyClonedVoice`, which reads the wrong slot) and the ordinary
    // "first render on the second clone-capable engine" path both hinge on
    // this staying silent.
    name: 'rule 8 silence: no derive yet, master + transcript present, coqui cast slot present, Coqui -> null',
    input: { ...base },
    expected: null,
  },
  {
    // Rule 7, qwen direction.
    name: 'no-transcript: not-ready slot + blank transcript + qwen cast slot, engine=qwen -> no-transcript',
    input: { ...base, engine: 'qwen', transcript: '', characterHasSlot: true },
    expected: 'no-transcript',
  },
  {
    // Rule 7 is qwen-only. Same input, engine=coqui -> null. #1933 shipped
    // ten instances of "engine-parameterised behaviour pinned in one
    // direction only" — this is the other direction, pinned explicitly.
    name: 'identical input on Coqui -> null (rule 7 is qwen-only)',
    input: { ...base, engine: 'coqui', transcript: '', characterHasSlot: true },
    expected: null,
  },
  {
    // Rule 7 gate. Mutation: ungate rule 7 (drop `slotStatus !== 'ready'`)
    // -> this must go red.
    name: "slotStatus 'ready' + blank transcript + Qwen -> null (a ready slot with no transcript is healthy, not a defect)",
    input: { ...base, engine: 'qwen', slotStatus: 'ready', transcript: '', characterHasSlot: true },
    expected: null,
  },
  {
    // Rule 6 gate. Mutation: ungate rule 6 (drop `slotStatus !== 'ready'`)
    // -> this must go red.
    name: "slotStatus 'ready' + hasMaster:false -> null (a ready slot with no master is healthy, not a defect)",
    input: { ...base, engine: 'qwen', slotStatus: 'ready', hasMaster: false, characterHasSlot: true },
    expected: null,
  },
  {
    // Rules 6/7 must NOT treat "not failed" as "healthy" — only an actual
    // 'ready' status exempts. "Insert rev 2's dead short-circuit" is INERT
    // here: `slotStatus === 'ready'` is false for a 'stale' input by
    // construction, so that mutation can never redden this fixture (plan
    // 276's [R4] correction). The mutation that actually targets this case
    // is narrowing rule 7's gate from `slotStatus !== 'ready'` to
    // `slotStatus === undefined` (i.e. "only warn if never derived") ->
    // this must go red, because a 'stale' slot (not `undefined`) would then
    // skip rule 7 and fall through to null instead of `no-transcript`.
    name: "slotStatus 'stale' + blank transcript + Qwen -> no-transcript",
    input: { ...base, engine: 'qwen', slotStatus: 'stale', transcript: '', characterHasSlot: true },
    expected: 'no-transcript',
  },
  /* The three cases below pin that rules 3, 5 and 6 EXIST — each asserts a
     verdict no other fixture produces. Without them all of this plan's
     named mutations still pass while the rule is deleted outright, because
     every named mutation probes a gate or an ordering and none probes
     existence. Verified: deleting any one of these three rules reddens
     exactly its own case and nothing else. */
  {
    // Rule 3. Mutation: delete rule 3 -> red (falls through to null, since
    // the rest of this input is healthy).
    name: 'consentRevoked -> revoked (on an otherwise healthy input)',
    input: { ...base, consentRevoked: true },
    expected: 'revoked',
  },
  {
    // Rule 5. Mutation: delete rule 5 -> red (a failed slot with a master
    // and a transcript otherwise falls through to null).
    name: "slotStatus 'failed' -> derive-failed (on an otherwise healthy input)",
    input: { ...base, slotStatus: 'failed' },
    expected: 'derive-failed',
  },
  {
    // Rule 6. Mutation: delete rule 6 -> red. Coqui deliberately, so the
    // verdict cannot be reached by rule 7 (qwen-only) instead — on Qwen a
    // blank-transcript variant of this input would report 'no-transcript'
    // and the case would pass with rule 6 gone.
    name: 'not-ready slot + hasMaster:false on Coqui -> missing-master',
    input: { ...base, engine: 'coqui', hasMaster: false },
    expected: 'missing-master',
  },
  {
    // Rule 2 outranks everything below it, including a maximally-broken remainder.
    name: 'entryFound:false -> missing-entry regardless of every other field',
    input: {
      ...base,
      entryFound: false,
      consentRevoked: true,
      slotStatus: 'failed',
      hasMaster: false,
      transcript: '',
      characterHasSlot: false,
    },
    expected: 'missing-entry',
  },
  {
    // Rule 4 vs rule 5 precedence, doubly-broken: the engine itself is not
    // clone-capable (rule 4) AND the slot is 'failed' (rule 5). With a
    // healthy slot this precedence is untested and a rule-4/rule-5
    // order-swap still passes — this fixture is the one that catches it.
    // Mutation: swap the order of rules 4 and 5 -> this must go red
    // (would report 'derive-failed' instead of 'wrong-engine').
    name: 'wrong-engine outranks slot status on a doubly-broken input (not clone-capable AND a failed slot)',
    input: { ...base, engine: 'kokoro', slotStatus: 'failed', characterHasSlot: true },
    expected: 'wrong-engine',
  },
];

describe('cloneReadiness', () => {
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(cloneReadiness(input)).toBe(expected);
    });
  }
});
