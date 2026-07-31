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
    // Rule 7. The most important case: rev 1's fatal bug (borrowing
    // `classifyClonedVoice`, which reads the wrong slot) and the ordinary
    // "first render on the second clone-capable engine" path both hinge on
    // this staying silent.
    name: 'rule 7 silence: no derive yet, master + transcript present, coqui cast slot present, Coqui -> null',
    input: { ...base },
    expected: null,
  },
  {
    // Rule 6, qwen direction.
    name: 'no-transcript: not-ready slot + blank transcript + qwen cast slot, engine=qwen -> no-transcript',
    input: { ...base, engine: 'qwen', transcript: '', characterHasSlot: true },
    expected: 'no-transcript',
  },
  {
    // Rule 6 is qwen-only. Same input, engine=coqui -> null. #1933 shipped
    // ten instances of "engine-parameterised behaviour pinned in one
    // direction only" — this is the other direction, pinned explicitly.
    name: 'identical input on Coqui -> null (rule 6 is qwen-only)',
    input: { ...base, engine: 'coqui', transcript: '', characterHasSlot: true },
    expected: null,
  },
  {
    // Rule 6 gate. Mutation: ungate rule 6 (drop `slotStatus !== 'ready'`)
    // -> this must go red.
    name: "slotStatus 'ready' + blank transcript + Qwen -> null (a ready slot with no transcript is healthy, not a defect)",
    input: { ...base, engine: 'qwen', slotStatus: 'ready', transcript: '', characterHasSlot: true },
    expected: null,
  },
  {
    // Rule 5 gate. Mutation: ungate rule 5 (drop `slotStatus !== 'ready'`)
    // -> this must go red.
    name: "slotStatus 'ready' + hasMaster:false -> null (a ready slot with no master is healthy, not a defect)",
    input: { ...base, engine: 'qwen', slotStatus: 'ready', hasMaster: false, characterHasSlot: true },
    expected: null,
  },
  {
    // Rules 5/6 must NOT treat "not failed" as "healthy" — only an actual
    // 'ready' status exempts. Mutation: insert rev 2's dead short-circuit
    // (`if (slotStatus === 'ready') return null;` right after rule 2) ->
    // this must go red, because 'stale' would then also short-circuit if
    // the short-circuit were instead written as "not ready is fine"; more
    // directly, this pins that 'stale' (distinct from 'ready') still falls
    // through to rule 6.
    name: "slotStatus 'stale' + blank transcript + Qwen -> no-transcript",
    input: { ...base, engine: 'qwen', slotStatus: 'stale', transcript: '', characterHasSlot: true },
    expected: 'no-transcript',
  },
  {
    // Rule 1 outranks everything, including a maximally-broken remainder.
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
    // Rule 3 vs rule 4 precedence, doubly-broken: the engine itself is not
    // clone-capable (rule 3) AND the slot is 'failed' (rule 4). With a
    // healthy slot this precedence is untested and a rule-3/rule-4
    // order-swap still passes — this fixture is the one that catches it.
    // Mutation: swap the order of rules 3 and 4 -> this must go red
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
