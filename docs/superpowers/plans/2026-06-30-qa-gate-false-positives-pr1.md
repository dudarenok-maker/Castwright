# QA-gate short-sentence false positives — PR-1 (gate-logic fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised after three adversarial reviews** (code-correctness, test-validity, regression/coverage). The folds are marked _[rev]_ inline; the biggest is a NEW Task 4 (A2c) that closes a short-line loop hole A1 would otherwise open.

**Goal:** Eliminate the short-sentence QA false positives that drive bimodal Qwen-1.7B per-chapter RTF, with zero loss of real-defect detection.

**Architecture:** Four pure-function gate-logic changes in the existing QA modules — (A1) an absolute-length floor on the duration "runaway" branch, (A2a) fuzzy compound-bridging in the ASR gate, (A2b) a short-reference single-substitution evidence backstop, (A2c) a loop/repeat check that runs even on sub-`minChars` lines — each behind a registry knob where it has a tunable. No sidecar, no I/O: every change is unit-testable in `vitest` against in-memory PCM / injected transcripts. The fixes remove the wasted single-synth re-records (RTF ~6) that dilute the healthy batched RTF (~0.7); they do **not** disable any gate.

**Tech Stack:** TypeScript, Node, Vitest. Server-side only (`server/src/tts/`, `server/src/config/`).

## Global Constraints

- **Branch:** all PR-1 work lands on `fix/server-qa-gate-false-positives` (already cut off `main`; the design spec commit `5dfaf40b` + the two plan docs are on it).
- **Commit convention:** `<type>(<scope>): <subject>`. Scope for every commit here is `server` (or `chore(scripts)` for Task 5). **`tts` is NOT an allowed scope** — it was rejected once already.
- **Spec source of truth:** `docs/superpowers/specs/2026-06-30-qa-gate-false-positives-and-rtf-telemetry-design.md` (§ PR-1).
- **Registry knobs default to current behaviour at their disable value:** `qa.seg.minRunawaySec=3.0` (`0` disables the floor → pre-PR), `qa.asr.minRefWords=2` (`0` disables the backstop → pre-PR). Both verified by review to restore pre-PR behaviour exactly.
- **No `--no-verify`.** Run `cd server && npm run test` (or the targeted file) before each commit; the pre-commit hook is scope-filtered and will run the server leg.
- **TDD, every task:** failing test → run-red → minimal impl → run-green → commit.
- **Real-defect invariant (do not regress):** a dropped word / deletion run, a repetition (high `compressionRatio`), a multi-error garble, a near-silent segment, and a genuine (≥3 s) runaway must all still flag after every task. The five existing guard tests for these (`segment-qa.test.ts` near-silent/runaway/truncated; `segment-asr-qa.test.ts` deletion-run/compression/wrong-word) MUST stay green — re-run them in Task 6.
- **Disclosed tradeoffs _[rev]_** (accept-with-note; verified narrow by review, not silently hidden):
  - **A2b** routes a *single substitution* on a 2-word ≥12-char reference to `inconclusive` (flag, no re-record). This includes a single-substitution *meaning flip* (`"Going forward"`→`"Going backward"`, `"Detonate everything"`→`"Detonate nothing"`). Deletion-shaped negation flips (`"did not"`→`"did"`) are NOT affected (they stay `drift`). `inconclusive` is still a recorded verdict persisted in `segments.json` — it is "weak ASR evidence, don't burn a re-record," not "ignore." Ship only if `inconclusive` stays visible in QA artifacts (it does — `synthesise-chapter.ts` writes `asr: asrClass` for every verdict).
  - **A2a** edit-distance-1 bridging widens the masking surface by one edit vs the legacy exact bridge (e.g. `"all together"`↔`"altogether"`). Every such collision is a near-homophone (cosmetic spacing/spelling), the exact FP class targeted; genuine ≥2-edit garbles are not bridged. Task 5's dry-run is the backstop that quantifies any over-tolerance.

## Decisions resolved from the spec's open questions

- **OQ1 (A1):** floor **alone**, no fixed-overhead term added to `expectedSec` (an overhead term feeds the *same* expression both duration branches divide by → would false-trip the truncation branch on fast short lines).
- **OQ2 + OQ3 (A2):** ship the **`qa.asr.minRefWords` evidence backstop** (single *substitution* on a 2-word ref → `inconclusive`, deletions/insertions exempt) **instead of** phonetic/metaphone name-matching. Rationale: lighter (no new dependency — OQ3's preference), more general, deletion-exempt. **Metaphone is NOT implemented in PR-1.** _[rev — Finding 2/coverage]_ A residual class remains that metaphone would have caught: name splits 1→3 (`"Scapegrace"`→`"scape a grace"`, insertion-driven, A2a only bridges 2↔1 pairs). This is disclosed, **filed as PR-1.1 follow-up**, and its size is measured by Task 5 — do NOT claim PR-1 "eliminates" all word-split FPs; claim the measured residual.
- **A2c (NEW, from review):** the loop/repeat (`compressionRatio`) check now runs even on sub-`minChars` lines — closing the hole where A1's floor + the ASR `minChars` floor jointly let a short looped line (`"no no no"` for 2.8 s) escape both gates. The spec's "ASR backstops it" note was **wrong**; A2c makes it true.
- **OQ4 (3 near-silent pads):** out of PR-1 scope — not touched here.

---

## File Structure

- `server/src/tts/segment-qa.ts` — **A1**: one new threshold field + one guard clause.
- `server/src/tts/segment-qa.test.ts` — A1 cases.
- `server/src/tts/segment-asr-qa.ts` — **A2a** (new `editDistanceAtMost1` + rewrite `bridgeCompounds`), **A2b** (new threshold field + one backstop clause), **A2c** (compression check inside the `minChars` block).
- `server/src/tts/segment-asr-qa.test.ts` — A2a + A2b + A2c cases.
- `server/src/config/registry.ts` — `qa.seg.minRunawaySec`, `qa.asr.minRefWords`, in the `qa-gates` group.
- `server/scripts/qa-gate-dryrun.ts` — Task 5 measurement (allowlist + language threaded).
- `.env.example` — regenerated by `npm run config:sync`.

---

## Task 1: A1 — duration gate absolute-length floor

**Files:**
- Modify: `server/src/tts/segment-qa.ts` (interface `SegmentQaThresholds`, `DEFAULT_SEGMENT_QA_THRESHOLDS`, `resolveThresholds`, the `maxDurationRatio` branch in `evaluateSegmentPcm`)
- Modify: `server/src/config/registry.ts` (new `qa.seg.minRunawaySec` knob)
- Test: `server/src/tts/segment-qa.test.ts`

**Interfaces:**
- Consumes: existing `evaluateSegmentPcm(pcm, sampleRate, text, thresholds?)`, `SegmentQaThresholds`, `configValue<number>`.
- Produces: `SegmentQaThresholds.minRunawaySec: number`; registry key `qa.seg.minRunawaySec` (env `SEG_QA_MIN_RUNAWAY_SEC`, default `3`). The "Suspiciously long — possible runaway" reason is emitted **only** when `durationSec >= minRunawaySec` AND `ratio > maxDurationRatio`. The truncation branch is unchanged.

- [ ] **Step 1: Write the tests**

Add to `server/src/tts/segment-qa.test.ts`, inside the `describe('evaluateSegmentPcm', …)` block (`tone`/`silence`/`SR` already exist). _[rev — R2]_ Only the first case is a true red→green guard; the others are invariant guards / a post-impl wiring check (noted per case):

```typescript
it('A1: does NOT flag a 1.0s render of a one-word line as runaway (RED→GREEN)', () => {
  // "Oh." → 3 chars → expectedSec ≈ 0.21s → ratio ≈ 4.7 > 2.5, but 1.0s is a
  // normal short utterance under the 3s absolute floor. FAILS before A1 (flagged
  // "runaway"), passes after. All 51 real FPs in the Scepter corpus were < 2.5s.
  const v = evaluateSegmentPcm(tone(1.0), SR, 'Oh.');
  expect(v.status).toBe('ok');
  expect(v.reasons).toHaveLength(0);
});

it('A1: still flags a genuine runaway — long absolute duration (invariant guard)', () => {
  // 6s of audio for "Oh." is over the ratio cap AND the 3s floor. Green before & after.
  const v = evaluateSegmentPcm(tone(6), SR, 'Oh.');
  expect(v.status).toBe('suspect');
  expect(v.reasons.some((r) => /runaway/i.test(r))).toBe(true);
});

it('A1: truncation branch is unmoved — a fast short line stays ok (invariant guard)', () => {
  // 0.25s "Oh." → ratio ≈ 1.17, between minRatio(0.4) and maxRatio(2.5): ok before & after.
  const v = evaluateSegmentPcm(tone(0.25), SR, 'Oh.');
  expect(v.status).toBe('ok');
});

it('A1: minRunawaySec knob lowers the floor (post-impl wiring check)', () => {
  // NOTE [rev]: green BOTH before and after the impl (pre-A1 there is no floor, so
  // the line flags regardless). It is NOT the regression guard — it only proves the
  // knob is wired once the floor exists. Keep it as a wiring check.
  process.env.SEG_QA_MIN_RUNAWAY_SEC = '0.5';
  const v = evaluateSegmentPcm(tone(1.0), SR, 'Oh.');
  expect(v.reasons.some((r) => /runaway/i.test(r))).toBe(true);
});
```

Add `SEG_QA_MIN_RUNAWAY_SEC` to the existing top-of-file `afterEach` cleanup block (alongside the other `SEG_QA_*` deletes).

- [ ] **Step 2: Run the tests to verify the RED case fails**

Run: `cd server && npx vitest run src/tts/segment-qa.test.ts -t A1`
Expected: the **first** test FAILS (status `'suspect'`, reasons includes "runaway"). The two invariant guards and the knob wiring check already pass (per review) — that's expected; only the first is red→green.

- [ ] **Step 3: Add the threshold field + default**

In `server/src/tts/segment-qa.ts`, add `minRunawaySec` to the `SegmentQaThresholds` interface. _[rev — R1 cosmetic]_ Add **only** the new field; do not re-paste `maxDurationRatio` (it already exists — pasting it twice is a TS duplicate-identifier error):

```typescript
  /** durationSec / expectedSec above this is "runaway". */
  maxDurationRatio: number;
  /** A "runaway" is only flagged when the rendered audio is also at least this
      many seconds long, in ABSOLUTE terms. A ratio over a sub-second expectedSec
      (a one-word line) is meaningless; every real runaway is ≫ this floor. */
  minRunawaySec: number;
```

Add to `DEFAULT_SEGMENT_QA_THRESHOLDS`:

```typescript
export const DEFAULT_SEGMENT_QA_THRESHOLDS: SegmentQaThresholds = {
  silenceRms: 0.003,
  noiseFloor: 0.01,
  maxInternalSilenceSec: 1.5,
  minDurationRatio: 0.4,
  maxDurationRatio: 2.5,
  minRunawaySec: 3.0,
};
```

Add to `resolveThresholds` (the registry branch):

```typescript
    minDurationRatio: configValue<number>('qa.seg.minRatio'),
    maxDurationRatio: configValue<number>('qa.seg.maxRatio'),
    minRunawaySec: configValue<number>('qa.seg.minRunawaySec'),
```

- [ ] **Step 4: Gate the runaway branch behind the floor**

In `evaluateSegmentPcm`, change only the `else if` condition for the long branch (body unchanged):

```typescript
    } else if (ratio > t.maxDurationRatio && durationSec >= t.minRunawaySec) {
      reasons.push(
        `Suspiciously long — ${durationSec.toFixed(1)}s rendered vs ~${expectedSec.toFixed(
          1,
        )}s expected (possible runaway synthesis).`,
      );
    }
```

- [ ] **Step 5: Add the registry knob**

In `server/src/config/registry.ts`, add immediately after the `qa.seg.maxRatio` knob (ends at line ~192):

```typescript
  {
    key: 'qa.seg.minRunawaySec',
    env: 'SEG_QA_MIN_RUNAWAY_SEC',
    group: 'qa-gates',
    label: 'Runaway absolute floor (s)',
    help: 'A segment is only flagged "runaway" when its rendered audio is at least this many seconds long. Stops one-word lines (sub-second expected duration) from false-flagging. 0 disables the floor.',
    type: 'number', min: 0, max: 30, step: 0.5,
    default: 3.0, // ← DEFAULT_SEGMENT_QA_THRESHOLDS.minRunawaySec in tts/segment-qa.ts
    apply: 'live', risk: 'low',
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/tts/segment-qa.test.ts`
Expected: ALL `segment-qa` tests PASS (4 new A1 cases + every pre-existing case, incl. the explicit-thresholds test — which survives because `minRunawaySec` is now in `DEFAULT`).

- [ ] **Step 7: Sync `.env.example` and verify the registry**

Run: `npm run config:sync` then `npm run config:check`
Expected: `SEG_QA_MIN_RUNAWAY_SEC` added to `.env.example`; `config:check` exits 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/segment-qa.ts server/src/tts/segment-qa.test.ts server/src/config/registry.ts .env.example
git commit -m "fix(server): gate duration runaway flag behind an absolute-length floor"
```

---

## Task 2: A2a — fuzzy compound-bridging in the ASR gate

**Files:**
- Modify: `server/src/tts/segment-asr-qa.ts` (new `editDistanceAtMost1` helper; rewrite `bridgeCompounds`)
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Consumes: existing `bridgeCompounds(expected: string[], actual: string[]): [string[], string[]]`, `normalizeForWer`, `classifyTranscript`.
- Produces: `editDistanceAtMost1(a: string, b: string): boolean` (exported). `bridgeCompounds` collapses an adjacent pair when its concatenation matches a token in the **other** stream — **exact match preferred, else within edit-distance ≤ 1** — and pushes the matched other-stream token so the streams align as `match`. _[rev — R1-#4]_ Exact-first preserves byte-identical legacy output even when a 1-edit neighbor precedes the exact token in the other stream.

- [ ] **Step 1: Write the tests**

Extend the import in `server/src/tts/segment-asr-qa.test.ts` to include `bridgeCompounds, editDistanceAtMost1`. Then add:

```typescript
describe('editDistanceAtMost1', () => {
  it('is true for equal / single-sub / single-indel, false otherwise', () => {
    expect(editDistanceAtMost1('skulduggery', 'skulduggery')).toBe(true); // equal
    expect(editDistanceAtMost1('skullduggery', 'skulduggery')).toBe(true); // 1 deletion (extra l)
    expect(editDistanceAtMost1('notted', 'nodded')).toBe(false); // 2 subs
    expect(editDistanceAtMost1('goodby', 'goodbye')).toBe(true); // 1 insertion
    expect(editDistanceAtMost1('cat', 'dog')).toBe(false); // 3 subs
  });
});

describe('bridgeCompounds (fuzzy)', () => {
  it('A2a: bridges a Whisper word-split 1 edit from the manuscript token', () => {
    const [exp, act] = bridgeCompounds(['skulduggery', 'froze'], ['skull', 'duggery', 'froze']);
    expect(exp).toEqual(['skulduggery', 'froze']);
    expect(act).toEqual(['skulduggery', 'froze']); // canonicalised to the manuscript form
  });

  it('A2a: still bridges an EXACT split (unchanged legacy behaviour)', () => {
    const [exp, act] = bridgeCompounds(['curvebuster'], ['curve', 'buster']);
    expect(exp).toEqual(['curvebuster']);
    expect(act).toEqual(['curvebuster']);
  });

  it('A2a: prefers an EXACT other-stream token over a 1-edit neighbour', () => {
    // other has both a 1-edit neighbour ('too') and the exact concat ('tos');
    // exact must win so legacy output is preserved regardless of array order.
    const [, act] = bridgeCompounds(['tos'], ['to', 's']);
    expect(act).toEqual(['tos']); // not 'too'
  });

  it('A2a: does NOT bridge a genuinely wrong pair (concat far from any token)', () => {
    const [exp, act] = bridgeCompounds(['hello', 'there'], ['banana', 'split']);
    expect(exp).toEqual(['hello', 'there']);
    expect(act).toEqual(['banana', 'split']);
  });
});

describe('classifyTranscript — A2a word-split tolerance', () => {
  it('A2a: a 1-edit word-split on a short line is ok, not drift (RED→GREEN)', () => {
    const c = classifyTranscript('Skulduggery frowned at her.', 'Skull Duggery frowned at her.', CLEAN);
    expect(c.verdict).toBe('ok');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t A2a`
Expected: RED. _[rev — R1 cosmetic]_ The `editDistanceAtMost1` cases fail at **module import** (missing named export → the whole file errors), not per-assertion; the classify case fails with verdict `'drift'`. Either way the suite is red before the change.

- [ ] **Step 3: Add the bounded edit-distance helper**

In `server/src/tts/segment-asr-qa.ts`, add directly above the `bridgeCompounds` doc-comment (~line 280):

```typescript
/** True when `a` and `b` are within Levenshtein distance 1 (equal, one
    substitution, or one insertion/deletion). Bounded short-circuit — no full DP
    matrix. Used by bridgeCompounds to tolerate the one-character drift Whisper
    introduces re-segmenting a compound ("skulduggery" → "skull duggery"). */
export function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1); // one substitution
  if (la > lb) return a.slice(i + 1) === b.slice(i); // one deletion from a
  return a.slice(i) === b.slice(i + 1); // one insertion into a
}
```

- [ ] **Step 4: Rewrite `bridgeCompounds` (exact-first, then fuzzy)**

Replace the `collapse` closure + the `expSet`/`actSet` lines with:

```typescript
export function bridgeCompounds(expected: string[], actual: string[]): [string[], string[]] {
  // Collapse an adjacent pair when its concatenation matches a token in the OTHER
  // stream — EXACT match preferred (byte-identical to the legacy Set behaviour),
  // else within edit-distance 1 — and emit that matched token so the two streams
  // align as a `match` rather than a residual substitution. A genuinely wrong pair
  // won't concatenate near an other-stream token, so this can't mask real drift.
  // Pairs only (2↔1); 3+ token compounds out of scope.
  const collapse = (tokens: string[], other: readonly string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (i + 1 < tokens.length) {
        const concat = tokens[i] + tokens[i + 1];
        const match = other.find((o) => o === concat) ?? other.find((o) => editDistanceAtMost1(concat, o));
        if (match !== undefined) {
          out.push(match);
          i += 1; // consumed the pair
          continue;
        }
      }
      out.push(tokens[i]);
    }
    return out;
  };
  return [collapse(expected, actual), collapse(actual, expected)];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: ALL `segment-asr-qa` tests PASS — the new A2a cases AND every pre-existing case (exact hits push `concat === match`, byte-identical; review confirmed no existing fixture fuzzy-collides).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/segment-asr-qa.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "fix(server): bridge 1-edit Whisper word-splits in the ASR gate"
```

---

## Task 3: A2b — short-reference single-substitution evidence backstop

**Files:**
- Modify: `server/src/tts/segment-asr-qa.ts` (`AsrThresholds`, `DEFAULT_ASR_THRESHOLDS`, `resolveAsrThresholds`, one backstop clause in `classifyTranscript`)
- Modify: `server/src/config/registry.ts` (new `qa.asr.minRefWords` knob)
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Consumes: existing `classifyTranscript`, `resolveAsrThresholds`, `AsrThresholds`, the computed `sub`/`del`/`ins`/`longestDeletionRun`/`wer`/`expectedTokens`.
- Produces: `AsrThresholds.minRefWords: number`; registry key `qa.asr.minRefWords` (env `SEG_ASR_MIN_REF_WORDS`, default `2`). Behaviour: when the (normalised) reference is **exactly in the band `2 ≤ length ≤ minRefWords`** and the **only** errors are substitutions (`del === 0 && ins === 0 && longestDeletionRun === 0 && sub <= 1`) yet `wer > maxWer`, return `inconclusive` instead of `drift`. _[rev — R1-#1]_ The `length >= 2` lower bound EXCLUDES 1-word references, where a full substitution (`wer = 1.0`) is strong evidence, not weak. A deletion or insertion on a short reference still flags. `minRefWords = 0` disables the backstop.

- [ ] **Step 1: Write the tests**

Add to `server/src/tts/segment-asr-qa.test.ts`. All references are ≥ 12 chars so they clear the `minChars` floor and reach the WER verdict. _[rev — R2-#3]_ Add the `afterEach` **inside this new describe block** (the file's existing `afterEach` is block-scoped to the per-language describe and will NOT fire here → `SEG_ASR_MIN_REF_WORDS` would leak and disable the backstop for the rest of the suite):

```typescript
describe('classifyTranscript — A2b short-reference substitution backstop', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_MIN_REF_WORDS;
  });

  it('A2b: a single substitution on a 2-word reference is inconclusive, not drift (RED→GREEN)', () => {
    // "Valkyrie Cain." (14 chars, 2 words) heard "Volkery Cain": 1 sub / 2 words =
    // WER 0.5 > 0.4, but one homophone on a 2-word line is weak evidence.
    const c = classifyTranscript('Valkyrie Cain.', 'Volkery Cain.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.del).toBe(0);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2b: a single substitution on a 1-WORD reference still flags drift (strong evidence)', () => {
    // [rev R1-#1] "Extraordinarily." → 1 token, 16 chars. A full substitution is
    // wer 1.0 — the whole word is wrong. The >= 2 lower bound must keep this drift.
    const c = classifyTranscript('Extraordinarily.', 'Coincidentally.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: a DELETION on a short reference still flags drift (truncation/negation preserved)', () => {
    const c = classifyTranscript('Detective Inspector', 'Inspector', CLEAN);
    expect(c.del).toBe(1);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: TWO substitutions on a 2-word reference still flags drift (whole line wrong)', () => {
    const c = classifyTranscript('Crimson Sparrow', 'Velvet Hammer', CLEAN);
    expect(c.sub).toBe(2);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: a single-substitution meaning-flip on a 2-word ref is inconclusive (disclosed tradeoff)', () => {
    // [rev R1-#2] Documents the accepted tradeoff: a directional flip expressible
    // as ONE substitution on a 2-word ref is weak ASR evidence → inconclusive
    // (recorded, not re-recorded). Deletion-shaped flips stay drift (case above).
    const c = classifyTranscript('Going forward.', 'Going backward.', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2b: the backstop does not touch a long reference', () => {
    const c = classifyTranscript(EXPECTED, EXPECTED.replace('observatory', 'laboratory'), CLEAN);
    expect(c.verdict).toBe('ok');
  });

  it('A2b: minRefWords=0 disables the backstop (post-impl wiring check)', () => {
    // NOTE [rev]: green before AND after the impl. Pre-A2b there is no backstop so
    // this is drift anyway; post-impl it proves the disable knob is wired.
    process.env.SEG_ASR_MIN_REF_WORDS = '0';
    const c = classifyTranscript('Valkyrie Cain.', 'Volkery Cain.', CLEAN);
    expect(c.verdict).toBe('drift');
  });
});
```

- [ ] **Step 2: Run the tests to verify the RED cases fail**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t A2b`
Expected: the two `inconclusive` cases (`Valkyrie Cain`, `Going forward`) FAIL (verdict `'drift'`). The 1-word/deletion/two-sub/long-ref guards and the `minRefWords=0` wiring check already pass.

- [ ] **Step 3: Add the threshold field + default + resolver**

In the `AsrThresholds` interface (after `minChars`):

```typescript
  /** Sentences shorter than this (trimmed chars) are not scored ... */
  minChars: number;
  /** References in the WORD-count band [2, minRefWords] (after normalization)
      where the only error is substitution(s) are routed to `inconclusive` instead
      of `drift`: a single ASR substitution swamps WER on a 2-word line yet is weak
      evidence. 1-word refs are EXCLUDED (a full sub there is strong evidence);
      deletions/insertions are exempt (they stay drift). 0 disables the backstop. */
  minRefWords: number;
```

Add to `DEFAULT_ASR_THRESHOLDS`:

```typescript
  maxWer: 0.4,
  maxDeletionRun: 4,
  minChars: 12,
  minRefWords: 2,
  maxCompressionRatio: 2.4,
  minAvgLogprob: -1.0,
  maxNoSpeechProb: 0.6,
```

Add to `resolveAsrThresholds`'s `base` object:

```typescript
    minChars: configValue<number>('qa.asr.minChars'),
    minRefWords: configValue<number>('qa.asr.minRefWords'),
```

- [ ] **Step 4: Add the backstop clause in `classifyTranscript`**

Insert **between** the `longestDeletionRun > t.maxDeletionRun` drift block and the `wer > t.maxWer` block:

```typescript
  // Short-reference substitution backstop (A2b). On a 2-word reference a single
  // ASR substitution (homophone, misheard name) drives WER over the cap yet is
  // weak evidence — route to inconclusive (flag, do NOT re-record). 1-word refs
  // are excluded (length >= 2): a full sub there is strong evidence. A deletion
  // (negation flip "did not"→"did", a dropped word) or insertion still flags.
  if (
    t.minRefWords > 0 &&
    expectedTokens.length >= 2 &&
    expectedTokens.length <= t.minRefWords &&
    del === 0 &&
    ins === 0 &&
    longestDeletionRun === 0 &&
    sub <= 1 &&
    wer > t.maxWer
  ) {
    reasons.push(
      `Short reference (${expectedTokens.length} words) with a single substitution; ` +
        `WER ${wer.toFixed(2)} is weak evidence — not scoring.`,
    );
    return base('inconclusive', metrics);
  }
```

- [ ] **Step 5: Add the registry knob**

In `server/src/config/registry.ts`, add immediately after the `qa.asr.minChars` knob (ends at line ~327):

```typescript
  {
    key: 'qa.asr.minRefWords',
    env: 'SEG_ASR_MIN_REF_WORDS',
    group: 'qa-gates',
    label: 'ASR min reference words',
    help: 'On 2-word references a single ASR substitution is routed to inconclusive instead of drift — one homophone on a two-word line is weak evidence. 1-word refs and deletions/insertions still flag. 0 disables.',
    type: 'integer', min: 0, max: 10,
    default: 2, // ← DEFAULT_ASR_THRESHOLDS.minRefWords in tts/segment-asr-qa.ts
    apply: 'live', risk: 'low',
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: ALL PASS — the 7 new A2b cases plus every pre-existing case.

- [ ] **Step 7: Sync `.env.example` and verify the registry**

Run: `npm run config:sync` then `npm run config:check`
Expected: `SEG_ASR_MIN_REF_WORDS` added; `config:check` exits 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/segment-asr-qa.ts server/src/tts/segment-asr-qa.test.ts server/src/config/registry.ts .env.example
git commit -m "fix(server): route short-ref single ASR substitutions to inconclusive"
```

---

## Task 4: A2c — loop/repeat detection on sub-`minChars` lines _[rev — NEW, closes the A1 hard-constraint hole]_

**Why:** A1's floor + the ASR `minChars` floor jointly let a *short* looped/runaway line escape both gates. A 1-word line looped to `"no no no no"` for 2.8 s is under A1's 3 s floor, AND `classifyTranscript` returns `inconclusive` at the 12-char `minChars` gate **before** it ever evaluates `compressionRatio` (Whisper's loop tell). Loop detection is intrinsic to the transcript and needs no minimum reference length — so check it inside the `minChars` block. This is the smallest change that makes the spec's "ASR backstops it" claim actually true, and it touches no ≥12-char behaviour (the existing compression path at the WER stage is unchanged).

**Files:**
- Modify: `server/src/tts/segment-asr-qa.ts` (the `minChars` early-return in `classifyTranscript`)
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Consumes: existing `classifyTranscript`, `AsrSignals.compressionRatio`, `t.maxCompressionRatio`, `t.minChars`.
- Produces: no signature change. A sub-`minChars` reference whose transcript has `compressionRatio > maxCompressionRatio` now returns `drift` (was `inconclusive`). All other sub-`minChars` references still return `inconclusive`. ≥`minChars` references are unaffected.

- [ ] **Step 1: Write the tests**

Add to the `segment-asr-qa.test.ts` (a fresh describe or the existing classify block):

```typescript
describe('classifyTranscript — A2c short-line loop detection', () => {
  it('A2c: a looped short line flags drift even under the minChars floor (RED→GREEN)', () => {
    // "No." (3 chars, < minChars 12) looped → high compression. Before A2c the
    // minChars floor returns inconclusive first; after, the loop tell wins.
    const looped: AsrSignals = { avgLogprob: -0.2, noSpeechProb: 0.02, compressionRatio: 3.0 };
    const c = classifyTranscript('No.', 'no no no no no no', looped);
    expect(c.verdict).toBe('drift');
  });

  it('A2c: a normal short line is still inconclusive (not over-flagged)', () => {
    const c = classifyTranscript('Oh.', 'Oh.', CLEAN); // compression 1.3 < 2.4
    expect(c.verdict).toBe('inconclusive');
  });
});
```

- [ ] **Step 2: Run the tests to verify the RED case fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t A2c`
Expected: the looped case FAILS (verdict `'inconclusive'` — minChars floor wins today). The normal-short case already passes.

- [ ] **Step 3: Add the compression check inside the `minChars` block**

In `classifyTranscript`, replace the existing `minChars` early-return block:

```typescript
  // Too short to WER-score reliably — don't act on it. EXCEPT a loop/repeat (high
  // compression) is intrinsic to the transcript and needs no minimum reference
  // length, so catch it even on a short line (A2c): A1's duration floor no longer
  // covers a sub-3s short-line loop, and this is the only gate that can.
  if ((expectedText ?? '').trim().length < t.minChars) {
    if (signals.compressionRatio != null && signals.compressionRatio > t.maxCompressionRatio) {
      reasons.push(
        `Loop/repeat — compression ratio ${signals.compressionRatio.toFixed(2)} exceeds the ${
          t.maxCompressionRatio
        } cap (likely repeated/garbled synthesis).`,
      );
      return base('drift');
    }
    reasons.push(`Not scored — sentence under the ${t.minChars}-char ASR floor.`);
    return base('inconclusive');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: ALL PASS — A2c cases plus every pre-existing case (≥`minChars` compression behaviour is untouched; the existing "looped audio → drift on compression_ratio" test uses a ≥12-char ref and still hits the WER-stage compression path with full metrics).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/segment-asr-qa.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "fix(server): detect short-line loops under the ASR minChars floor"
```

---

## Task 5: Corpus dry-run validation (measurement; allowlist + language threaded)

**Files:**
- Create: `server/scripts/qa-gate-dryrun.ts` (re-runnable, read-only over the corpus)
- Reads: the rendered book's `*.segments.json` + its `cast.json` (for the name allowlist).

**Interfaces:**
- Consumes: `classifyTranscript` (with `nameAllowlist` + `language`), `buildCastNameAllowlist`, `DEFAULT_SEGMENT_QA_THRESHOLDS`.
- Produces: a printed before/after table the Ship notes record. _[rev — R1-#6]_ The script threads the **cast name allowlist + book language** so its counts are comparable to the production gate (omitting them inflates `sub` on every name-mangle and injects English number-spelling on non-English books). The **valid signal is the delta** between the production `asr.verdict` already in each segment (allowlist-aware, pre-PR) and the script's re-classification (post-PR) — report that flip count, not just an absolute.

- [ ] **Step 1: Write the dry-run script**

Create `server/scripts/qa-gate-dryrun.ts`:

```typescript
/* One-off, read-only measurement (PR-1 validation). Re-derives the ASR + duration
   QA verdicts over a rendered book's *.segments.json with the CURRENT code, so we
   can quote before/after false-positive counts in the spec Ship notes. Not wired
   into any harness — run on the box that has the corpus:
     npx tsx server/scripts/qa-gate-dryrun.ts "<audio dir>" [--lang=en] [--cast=<cast.json>]
   No writes. Threads the cast name allowlist (so name-mangles aren't counted as
   subs) and the book language. The trustworthy figure is the FLIP count: segments
   whose stored production asr.verdict was 'drift' but re-classify to ok/inconclusive
   under the new code. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  classifyTranscript,
  buildCastNameAllowlist,
  type AsrSignals,
} from '../src/tts/segment-asr-qa.js';
import { DEFAULT_SEGMENT_QA_THRESHOLDS } from '../src/tts/segment-qa.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const lang = args.find((a) => a.startsWith('--lang='))?.slice('--lang='.length);
const castArg = args.find((a) => a.startsWith('--cast='))?.slice('--cast='.length);
if (!dir) {
  console.error('usage: qa-gate-dryrun.ts <audio-dir> [--lang=en] [--cast=path]');
  process.exit(1);
}

// Locate cast.json: explicit --cast, else audioDir/cast.json, else parent/cast.json.
const castPath = [castArg, join(dir, 'cast.json'), join(dirname(dir), 'cast.json')].find(
  (p) => p && existsSync(p),
);
let nameAllowlist: string[] = [];
if (castPath) {
  try {
    const cast = JSON.parse(readFileSync(castPath, 'utf8'));
    const chars = Array.isArray(cast?.characters) ? cast.characters : Array.isArray(cast) ? cast : [];
    nameAllowlist = buildCastNameAllowlist(chars);
  } catch (e) {
    console.warn(`cast.json parse failed (${castPath}): ${String(e)} — allowlist empty`);
  }
} else {
  console.warn('No cast.json found — name allowlist EMPTY; absolute drift count over-counts.');
}

let total = 0;
let prodDrift = 0; // stored production verdict (allowlist-aware, pre-PR)
let newDrift = 0; // re-classified with current code
let flippedToClean = 0; // prod 'drift' → new ok/inconclusive
let durLongNow = 0;
const t = DEFAULT_SEGMENT_QA_THRESHOLDS;

for (const f of readdirSync(dir).filter((n) => n.endsWith('.segments.json'))) {
  const segs = JSON.parse(readFileSync(join(dir, f), 'utf8')) as any[];
  for (const s of segs) {
    total += 1;
    const dur = s.qa?.durationSec;
    const exp = s.qa?.expectedSec;
    if (dur != null && exp != null && exp > 0) {
      if (dur / exp > t.maxDurationRatio && dur >= t.minRunawaySec) durLongNow += 1;
    }
    const text: string | undefined = s.text;
    const transcript: string | undefined = s.asr?.transcript;
    if (text && transcript != null) {
      const signals: AsrSignals = {
        avgLogprob: s.asr?.avgLogprob ?? null,
        noSpeechProb: s.asr?.noSpeechProb ?? null,
        compressionRatio: s.asr?.compressionRatio ?? null,
      };
      const c = classifyTranscript(text, transcript, signals, { nameAllowlist, language: lang });
      const wasDrift = s.asr?.verdict === 'drift';
      if (wasDrift) prodDrift += 1;
      if (c.verdict === 'drift') newDrift += 1;
      if (wasDrift && c.verdict !== 'drift') flippedToClean += 1;
    }
  }
}

console.log(`segments scanned:            ${total}`);
console.log(`production ASR drift (pre):  ${prodDrift}`);
console.log(`ASR drift (post-PR-1 code):  ${newDrift}`);
console.log(`  flipped drift→clean:       ${flippedToClean}`);
console.log(`duration "runaway" (post):   ${durLongNow}  (spec baseline: 51, all < 2.5s)`);
```

- [ ] **Step 2: Run the dry-run against the corpus**

Run: `npx tsx server/scripts/qa-gate-dryrun.ts "C:\AudiobookWorkspace\books\Derek Landy\Skulduggery Pleasant\Scepter of the Ancients\audio" --lang=en`
Expected: `duration "runaway"` → 0 (all 51 were < 2.5 s). A large `flipped drift→clean` (the 78 word-splits via A2a + the 2-word single-subs via A2b). **Record the actual numbers** — this is the measured residual that the "RTF win" claim is gated on (do NOT claim full elimination; quote the residual). If `cast.json` isn't found, re-run with `--cast=<path>` before recording.

- [ ] **Step 3: Confirm real defects survive**

Add a temporary `console.log` of the residual `newDrift` transcripts (or inspect a few segments where new verdict is still `drift`). Expected survivors: the genuine repetition (high compression), multi-error garbles, true deletion runs — NOT word-splits or single homophones. A residual that is a clear FP (e.g. a `Scapegrace`→`scape a grace` 1→3 split) is the PR-1.1 metaphone trigger — note it, do not relax a threshold.

- [ ] **Step 4: Commit the script + record numbers in the spec Ship notes**

Edit the spec Ship notes with the before/after counts + the flip count, then:

```bash
git add server/scripts/qa-gate-dryrun.ts docs/superpowers/specs/2026-06-30-qa-gate-false-positives-and-rtf-telemetry-design.md
git commit -m "chore(scripts): QA-gate dry-run + record PR-1 before/after counts"
```

---

## Task 6: Full server verify + branch wrap-up

- [ ] **Step 1: Run the full server test suite**

Run: `npm run test:server`
Expected: green. Run `npm run test:server-slow` too if any `qa-gates` config resolution is exercised in that lane.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (new exported `editDistanceAtMost1`, new threshold fields, new knobs all type-clean; review confirmed no orphaned `SegmentQaThresholds`/`AsrThresholds` literal).

- [ ] **Step 3: Confirm the real-defect invariant across both gate test files**

Run: `cd server && npx vitest run src/tts/segment-qa.test.ts src/tts/segment-asr-qa.test.ts`
Expected: every pre-existing "flags X" case (truncation, deletion run, compression-ratio loop, multi-error drift, near-silent, internal-silence gap) is still green. If any went green→absent, a fix over-reached — stop and reconcile.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/server-qa-gate-false-positives
```

Open the PR (title `fix(server): eliminate short-sentence QA-gate false positives`). Body = mini-release-notes enumerating A1 / A2a / A2b / A2c, each with its knob + default, the **measured** before/after corpus counts from Task 5 (residual, not "all eliminated"), the disclosed tradeoffs, and the real-defect invariant. Link the design spec. File the **PR-1.1 metaphone follow-up** issue for the Scapegrace-class 1→3 name splits. CI is opt-in — add `run-ci` only for a clean-room run before merge.

---

## Self-Review (post-fold)

**1. Spec coverage (§ PR-1):** A1 floor-alone → Task 1 ✓; A2a fuzzy bridge (exact-first) → Task 2 ✓; A2b backstop, 1-word excluded → Task 3 ✓; **A2c loop-under-minChars (new, closes the hard-constraint hole the spec mis-described) → Task 4 ✓**; corpus dry-run with allowlist+language → Task 5 ✓; registry knobs + `config:sync` → Tasks 1, 3 ✓.

**2. Review folds applied:** R1-#1 (1-word exclusion, `length >= 2`) ✓; R1-#2 (substitution-flip tradeoff disclosed + tested) ✓; R1-#4 (exact-first bridge + test) ✓; R1-#6 (dry-run allowlist+language+flip count) ✓; R2-#1/#2 (knob tests reframed as wiring checks) ✓; R2-#3 (in-block `afterEach`) ✓; R3-#1 (A2c) ✓; R3 metaphone residual (PR-1.1 filed, claim gated on measurement) ✓; cosmetics (14-char count, no duplicate `maxDurationRatio`, import-failure red phase) ✓.

**3. Placeholder scan:** every code step shows full code; no TBD/"handle edge cases".

**4. Type consistency:** `minRunawaySec`/`minRefWords` used identically across interface/default/resolver/registry; `editDistanceAtMost1` signature identical in helper/export/test; `bridgeCompounds` signature unchanged.

**Residual (disclosed, not blocking):** name splits 1→3 (`Scapegrace`→`scape a grace`) remain `drift` — PR-1.1 metaphone follow-up. A2b downgrades a single-substitution 2-word meaning-flip to `inconclusive` (recorded, not re-recorded) — accepted, tested, visible in artifacts.
