# srv-36 Audition Centroid Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Option-B audition-centroid fallback's fixed K=12-identical-render loop with a smarter, cost-bounded pool: reuse in-book anchor embeddings where trustworthy, diversify audition text across distinct evidence quotes, and cap total renders at 8 (down from 12) in every code path.

**Architecture:** `audition-centroid.ts` gains a two-phase pool-fill algorithm (top up existing anchors to a target size, then a bimodal-safety top-up that reuses already-rendered synthetics rather than re-rendering from scratch) behind an unchanged exported function name and a widened `AuditionCentroidOpts`. `aggregate.ts` gains the evidence plumbing (`cast.json` → `hint`) and the anchor-vs-bimodal split that feeds the new pool.

**Tech Stack:** TypeScript, Vitest, existing `server/src/audio/render-integrity/*` and `server/src/tts/*` modules — no new dependencies.

## Global Constraints

- `AUDITION_POOL_TARGET_N = 6` (exported), `AUDITION_POOL_MARGIN = 2` (exported) — total render budget per character is `8`, down from the removed `CENTROID_K = 12`.
- `AUDITION_QUOTE_MAX_CHARS = 320` (not exported) — matches `voice-sample-cache.ts`'s `MAX_CHARS`, but this is a **separate, unshared** constant (do not import/modify `voice-sample-cache.ts`).
- `CENTROID_MIN_N` (10), `BIMODAL_GAP_THRESHOLD`, `BIMODAL_MIN_SIDE_FRACTION`, and all of `centroid.ts` are **untouched** — the too-thin/bimodal *classification* in `centroid.ts` still gates on 10; only the *audition pool* (a separate, smaller pool) uses the new constants.
- Total render attempts for a character, across the initial pool-fill AND any bimodal-safety top-up, must never exceed `AUDITION_POOL_TARGET_N + AUDITION_POOL_MARGIN` (= 8). This is a hard invariant, not a target — cost wins over reaching the target pool size when they conflict (degrades to the existing `too-short` → inconclusive outcome). **Unit: this counts pool *slots* (`attemptsUsed`), not raw `synth()` calls** — a slot whose primary render lands under the duration floor triggers one *additional* `synth()` call (the retry) against that SAME slot, not a new one. This matches the OLD `CENTROID_K=12` system's identical accounting (it too could double to ~24 raw calls on an unlucky run), so the "8 vs 12" comparison is apples-to-apples — see the design spec's §3 "Net effect" paragraph. Worst-case raw `synth()` calls for a character is therefore `2 × (targetN + margin)` = 16, not 8; that is expected, not a bug.
- `cast.json` reads must be best-effort: missing file, missing `.audiobook` directory, or unparseable JSON all yield "no hints available" — never a thrown error, matching the existing `readSegmentsFile` idiom in `aggregate.ts`.
- No change to `buildSampleText`/`MAX_CHARS` (`voice-sample-cache.ts`) — the voice-preview routes (`routes/voice-sample.ts`, `routes/qwen-voice.ts`) are out of scope.
- Design spec (full rationale + 3 rounds of adversarial-review corrections): `docs/superpowers/specs/2026-07-07-srv36-audition-centroid-reference-design.md`.

---

## Task 1: Rewrite `audition-centroid.ts` — pool-based reference, not fixed K

**Files:**
- Modify: `server/src/audio/render-integrity/audition-centroid.ts`
- Modify: `server/src/audio/render-integrity/audition-centroid.test.ts`

**Interfaces:**
- Consumes (unchanged imports): `selectTtsProvider`, `TtsModelKey`, `SynthesizeOutput` from `../../tts/index.js`; `embedSegment` from `../../tts/embed-client.js`; `buildSampleText`, `stripQuoteMarks` from `../../tts/voice-sample-cache.js`; `buildCentroid` from `./centroid.js`; `MIN_DURATION_SEC` from `./constants.js`; `pcmDurationSec` from `../../tts/pcm.js`; `VoiceLike`, `CharacterHint` from `../../tts/voice-mapping.js`.
- Produces: `AUDITION_POOL_TARGET_N` (exported const, `6`), `AUDITION_POOL_MARGIN` (exported const, `2`), `AuditionCharacter` (unchanged shape — `voiceName`, `modelKey`, `voice`, `hint?`), `AuditionCentroidOpts` (now `synthFn?`, `embedFn?`, `targetN?`, `margin?`, `existingAnchors?: Float32Array[]` — **no more `k`**), `auditionCentroid(character, opts?)` (unchanged signature shape — same 2 positional params, `existingAnchors` lives on `opts`, never a 3rd positional argument). `CENTROID_K` is **removed** — Task 2 does not reference it.

### Step 1: Cut the branch

- [ ] From the repo root (a fresh worktree or the main checkout — confirm `git status` is clean and you're on latest `main` first):

```bash
git fetch origin main
git switch -c refactor/server-srv36-audition-centroid origin/main
```

### Step 2: Write the new test file (full replacement)

- [ ] Replace the entire contents of `server/src/audio/render-integrity/audition-centroid.test.ts`:

```ts
/**
 * srv-36 Task 10 — audition-centroid tests (redesigned per
 * docs/superpowers/specs/2026-07-07-srv36-audition-centroid-reference-design.md).
 *
 * All network calls are replaced via injected synthFn + embedFn so the sidecar
 * is never required.
 */

import { describe, it, expect } from 'vitest';
import {
  auditionCentroid,
  AUDITION_POOL_TARGET_N,
  AUDITION_POOL_MARGIN,
} from './audition-centroid.js';
import type { AuditionCharacter } from './audition-centroid.js';
import type { TtsModelKey, SynthesizeOutput } from '../../tts/index.js';
import { MIN_DURATION_SEC } from './constants.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono

/** Build a PCM Buffer that corresponds to exactly `durationSec` seconds. */
function makePcm(durationSec: number): Buffer {
  const bytes = Math.ceil(durationSec * SAMPLE_RATE * BYTES_PER_SAMPLE);
  return Buffer.alloc(bytes, 0);
}

/** PCM buffer that is clearly above the MIN_DURATION_SEC floor. */
const ABOVE_FLOOR_PCM = makePcm(MIN_DURATION_SEC + 1.0);

/** PCM buffer that is clearly below the MIN_DURATION_SEC floor. */
const BELOW_FLOOR_PCM = makePcm(MIN_DURATION_SEC * 0.5);

/** Make a trivial SynthesizeOutput. */
function makeSynthOut(pcm: Buffer): SynthesizeOutput {
  return { pcm, sampleRate: SAMPLE_RATE, mimeType: 'audio/L16' };
}

/** Minimal character fixture — no evidence, so buildSampleText's canned
 *  fallback line is the only text available. */
const CHARACTER: AuditionCharacter = {
  voiceName: 'af_sarah',
  modelKey: 'coqui-xtts-v2' as TtsModelKey,
  voice: { id: 'hero', character: 'Hero', attributes: ['brave'] },
};

/** Character with 3 distinct evidence quotes (for retry + cycling tests). */
const CHARACTER_WITH_EVIDENCE: AuditionCharacter = {
  ...CHARACTER,
  hint: {
    evidence: [
      'A second evidence quote that is definitely longer and used as the primary text here.',
      'A fairly long second line from the manuscript for the retry extension.',
      'Short one.',
    ],
  },
};

// A unit vector in a given axis direction, dim=8, with tiny deterministic jitter
// on the next axis over so a cluster isn't a single repeated point. Mirrors the
// proven bimodal fixture in centroid.test.ts (orthogonal directions reliably
// clear BIMODAL_GAP_THRESHOLD regardless of pool size).
function axisVec(axis: number, i: number, dim = 8): Float32Array {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return Float32Array.from(dir.map((v) => v / norm));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auditionCentroid', () => {
  it('exports the target/margin constants at their spec\'d values', () => {
    expect(AUDITION_POOL_TARGET_N).toBe(6);
    expect(AUDITION_POOL_MARGIN).toBe(2);
  });

  it('zero anchors, all renders succeed → stops early at exactly targetN synth calls', async () => {
    const synthCalls: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCalls.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let callIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, callIdx++);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Stops as soon as the pool reaches target — doesn't burn the margin
    // when nothing fails the floor.
    expect(synthCalls.length).toBe(3);
    expect(result!.embeddings.length).toBe(3);
  });

  it('zero anchors, one under-floor render with no evidence (no retry) → margin absorbs it, still reaches target', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      const isFirst = callIdx === 0;
      callIdx++;
      return makeSynthOut(isFirst ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Slot 0 fails the floor (no evidence → no retry), slots 1-3 succeed:
    // 4 synth calls total, using the full deficit(3)+margin(1) budget.
    expect(callIdx).toBe(4);
    expect(result!.embeddings.length).toBe(3);
  });

  it('zero anchors, budget exhausted before reaching target → too-short', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      // First 2 of 4 attempts fail the floor; only 2 succeed — short of target(3).
      const isBelow = callIdx < 2;
      callIdx++;
      return makeSynthOut(isBelow ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    expect(callIdx).toBe(4); // budget (deficit 3 + margin 1) fully consumed
  });

  it('anchors alone already meet target → zero new renders', async () => {
    const synthCalls: number[] = [];
    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const existingAnchors = [axisVec(0, 0), axisVec(0, 1), axisVec(0, 2)];
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 3,
      margin: 1,
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    expect(synthCalls.length).toBe(0);
    expect(result!.embeddings.length).toBe(3);
  });

  it('partial anchors → tops up only the deficit, not the full margin', async () => {
    const synthCalls: number[] = [];
    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    const existingAnchors = [axisVec(0, 0)];
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 3,
      margin: 1,
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // deficit = 2 (target 3 - 1 anchor); all succeed → stops at 2, not the
    // deficit+margin=3 ceiling.
    expect(synthCalls.length).toBe(2);
    expect(result!.embeddings.length).toBe(3); // 1 anchor + 2 new
  });

  it('retries an under-floor render by appending the NEXT distinct evidence quote', async () => {
    const synthCallTexts: string[] = [];
    // cleaned quotes are sorted longest-first; slot 0's text is cleaned[0].
    // The retry for slot 0 appends cleaned[1] (the next quote in the cycle).
    const cleaned = [...CHARACTER_WITH_EVIDENCE.hint!.evidence!].sort((a, b) => b.length - a.length);
    const primaryText = cleaned[0];
    const expectedRetryText = `${primaryText} ${cleaned[1]}`;

    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(input.text === primaryText ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER_WITH_EVIDENCE, {
      synthFn,
      embedFn,
      targetN: 1,
      margin: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    expect(synthCallTexts).toEqual([primaryText, expectedRetryText]);
  });

  it('no retry when there is no evidence at all (canned fallback, cleaned.length===0)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(BELOW_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    // No retries attempted — exactly 2 primary calls (targetN + margin=2), not 4.
    expect(callIdx).toBe(2);
  });

  it('no retry when there is exactly one distinct evidence quote (cleaned.length===1)', async () => {
    const oneQuoteCharacter: AuditionCharacter = {
      ...CHARACTER,
      hint: { evidence: ['The only quote this character has.'] },
    };
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(BELOW_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(oneQuoteCharacter, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    expect(callIdx).toBe(2); // no doubled retry calls
  });

  it('cycles through fewer-than-target distinct evidence quotes', async () => {
    const synthCallTexts: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    await auditionCentroid(CHARACTER_WITH_EVIDENCE, { synthFn, embedFn, targetN: 5, margin: 0 });

    const cleaned = [...CHARACTER_WITH_EVIDENCE.hint!.evidence!].sort((a, b) => b.length - a.length);
    // 5 slots cycling through 3 distinct quotes: q0, q1, q2, q0, q1.
    expect(synthCallTexts).toEqual([cleaned[0], cleaned[1], cleaned[2], cleaned[0], cleaned[1]]);
  });

  it('falls back to the canned buildSampleText line when there is no evidence at all', async () => {
    const synthCallTexts: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(synthCallTexts.length).toBe(2);
    expect(synthCallTexts[0]).toBe(synthCallTexts[1]);
    expect(synthCallTexts[0].length).toBeGreaterThan(0);
  });

  it('returns null when synthFn throws (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => {
      throw new Error('sidecar down');
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).toBeNull();
  });

  it('returns null when embedFn throws mid-loop (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(ABOVE_FLOOR_PCM);
    let embedCallCount = 0;
    const embedFn = async (): Promise<Float32Array> => {
      embedCallCount++;
      if (embedCallCount === 3) throw new Error('sidecar embed unavailable');
      return axisVec(0, embedCallCount);
    };

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 5, margin: 0 });

    expect(result).toBeNull();
  });

  it('bimodal blend discards anchors and tops up the ALREADY-RENDERED synthetics within the shared 8-render cap (round-2 cost-blowup regression)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    // Every synthetic render embeds into axis-1's cluster — orthogonal to the
    // axis-0 anchor below, guaranteed to trip BIMODAL_GAP_THRESHOLD. A 1
    // anchor : 3 synthetic split is deliberately ASYMMETRIC — an even split
    // (e.g. 2:2) can leave the weighted centroid equidistant from both
    // clusters, producing near-identical cosines-to-centroid on both sides
    // and no detectable gap. The proven fixture this mirrors (centroid.test.ts,
    // "detects bimodality when two clear clusters are present") is itself
    // asymmetric (12 vs 8) for the same reason.
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);

    const existingAnchors = [axisVec(0, 0)]; // 1 anchor, axis 0
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 4,
      margin: 2, // budget = 6
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Phase A: deficit=3 (target 4 - 1 anchor), reaches target at 3 synth
    // calls (1 anchor + 3 synthetics = 4 = target). Blend comes back bimodal
    // (1:3 split) → anchor dropped, phase B tops up the 3 already-rendered
    // synthetics with 1 more (3+1=4=target). Total 4 synth calls — well
    // inside the 6-call cap, and the regression invariant: NEVER exceeds
    // targetN+margin.
    expect(callIdx).toBe(4);
    expect(callIdx).toBeLessThanOrEqual(6);
    expect(result!.embeddings.length).toBe(4);
  });

  it('a resulting synthetic-only pool is used as-is with no second bimodal check (documented, pre-existing limitation)', async () => {
    // Same setup as the regression test above — the fallback pool built from
    // ONLY axis-1 synthetics is internally uniform (not bimodal), so this
    // just confirms the call succeeds and returns 'audition' without a
    // second buildCentroid-on-the-fallback bimodal branch to fall into.
    let embedIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(ABOVE_FLOOR_PCM);
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);
    const existingAnchors = [axisVec(0, 0)];

    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 4,
      margin: 2,
      existingAnchors,
    });

    expect(result!.kind).toBe('audition');
  });

  it('bimodal fallback that still falls short after exhausting the shared cap → too-short, cap never exceeded (round-3 regression)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      // Calls 1-2 fail the floor (phase A), 3-4 succeed (phase A), 5-7
      // succeed (phase B top-up), call 8 fails (phase B) — leaving the
      // fallback pool 1 short of target once the 8-call cap is hit.
      const isBelow = callIdx <= 2 || callIdx === 8;
      return makeSynthOut(isBelow ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);

    const existingAnchors = [axisVec(0, 0), axisVec(0, 1), axisVec(0, 2), axisVec(0, 3)]; // 4 anchors
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 6,
      margin: 2, // budget = 8
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    // Exactly the 8-call cap — never exceeded chasing the unreachable target.
    expect(callIdx).toBe(8);
  });

  it('respects targetN/margin overrides — a wider margin absorbs more floor failures before giving up', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      const isFirst = callIdx === 0;
      callIdx++;
      return makeSynthOut(isFirst ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    // targetN=2, margin=1: slot 0 fails, slots 1-2 succeed → reaches target
    // using the full deficit(2)+margin(1)=3 budget.
    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 1 });

    expect(result!.kind).toBe('audition');
    expect(callIdx).toBe(3);
  });
});
```

- [ ] **Note for the implementer:** the two bimodal fixtures (`axisVec(0, …)` vs `axisVec(1, …)`) are modeled directly on the proven bimodal fixture in `centroid.test.ts` (orthogonal unit directions, `BIMODAL_GAP_THRESHOLD=0.15`, `BIMODAL_MIN_SIDE_FRACTION=0.2`). If either bimodal-path test doesn't actually observe `kind: 'audition'`/`'too-short'` as written when run (i.e. `buildCentroid` doesn't flag the blend as bimodal for a given pool size), the fix is widening the axis separation or pool composition, not changing the invariant under test — the axis values themselves aren't load-bearing to the spec, only that the two clusters are far apart with each side meeting `BIMODAL_MIN_SIDE_FRACTION`.

### Step 3: Run the tests, confirm they fail on the old implementation

- [ ] Run: `cd server && npx vitest run src/audio/render-integrity/audition-centroid.test.ts`
- [ ] Expected: FAIL — `AUDITION_POOL_TARGET_N`/`AUDITION_POOL_MARGIN` are not exported by the current file, and `existingAnchors`/`targetN`/`margin` don't exist on the current `AuditionCentroidOpts`.

### Step 4: Replace the implementation

- [ ] Replace the entire contents of `server/src/audio/render-integrity/audition-centroid.ts`:

```ts
/**
 * srv-36 Option-B audition centroid (Task 10, redesigned per
 * docs/superpowers/specs/2026-07-07-srv36-audition-centroid-reference-design.md).
 *
 * When a character has too few in-book anchor vectors (too-thin) or a
 * bimodal distribution, we fall back to a blended reference: real anchor
 * embeddings (when trustworthy) topped up with new audition renders under
 * distinct evidence-quote text, embedded with ECAPA. Total render attempts
 * for a character — across the initial pool-fill AND the bimodal-safety
 * top-up below — never exceed AUDITION_POOL_TARGET_N + AUDITION_POOL_MARGIN.
 *
 * Injected `synthFn`/`embedFn` default to the real providers so the function
 * is unit-testable without a sidecar.
 */

import { selectTtsProvider, type TtsModelKey, type SynthesizeOutput } from '../../tts/index.js';
import { embedSegment } from '../../tts/embed-client.js';
import { buildSampleText, stripQuoteMarks } from '../../tts/voice-sample-cache.js';
import { buildCentroid } from './centroid.js';
import { MIN_DURATION_SEC } from './constants.js';
import { pcmDurationSec } from '../../tts/pcm.js';
import type { VoiceLike, CharacterHint } from '../../tts/voice-mapping.js';

// ── Exported constants ─────────────────────────────────────────────────────────

/** Target combined pool size (anchors + new audition renders) for the
 *  Option-B fallback. Decoupled from CENTROID_MIN_N (10, centroid.ts), which
 *  governs the in-book path — this pool is deliberately smaller since it's a
 *  synthetic backup, not a statistically rigorous sample. */
export const AUDITION_POOL_TARGET_N = 6;
/** Extra render attempts allowed above the bare deficit, to absorb
 *  duration-floor failures — restores the margin the old fixed K=12 provided. */
export const AUDITION_POOL_MARGIN = 2;
/** Per-render evidence-quote cap. Matches voice-sample-cache.ts's MAX_CHARS
 *  but is an intentionally separate constant — that module is untouched. */
const AUDITION_QUOTE_MAX_CHARS = 320;

// ── Parameter types ───────────────────────────────────────────────────────────

/** Minimal voice info needed to render a character's audition sample. */
export interface AuditionCharacter {
  /** The voice name (resolved at render time, e.g. `qwen-<uuid>` or `af_sarah`). */
  voiceName: string;
  /** The TTS model key that drove this character's renders. */
  modelKey: TtsModelKey;
  /** A minimal VoiceLike so `buildSampleText` can construct the fallback text. */
  voice: VoiceLike;
  /** Optional hint carrying evidence quotes; absent = canned fallback text. */
  hint?: CharacterHint;
}

/** Injection seams for unit tests (default to the real implementations). */
export interface AuditionCentroidOpts {
  /** Override the TTS synthesize fn (default: selectTtsProvider(modelKey).synthesize). */
  synthFn?: (input: {
    text: string;
    voiceName: string;
    modelKey: TtsModelKey;
  }) => Promise<SynthesizeOutput>;
  /** Override the embed fn (default: embedSegment). */
  embedFn?: (pcm: Buffer, sampleRate: number) => Promise<Float32Array>;
  /** Override the target pool size (default: AUDITION_POOL_TARGET_N). */
  targetN?: number;
  /** Override the render margin (default: AUDITION_POOL_MARGIN). */
  margin?: number;
  /** Real in-book anchor embeddings to blend into the pool before topping up
   *  with new renders. Callers pass these ONLY for a too-thin-origin
   *  fallback — a bimodal-origin fallback must pass `[]` (or omit), since
   *  the anchors are exactly the untrustworthy data causing the split. */
  existingAnchors?: Float32Array[];
}

// ── Duration helper ───────────────────────────────────────────────────────────

/** True when the PCM buffer is long enough to produce a reliable embedding. */
function isAboveFloor(pcm: Buffer, sampleRate: number): boolean {
  return pcmDurationSec(pcm.length, sampleRate) >= MIN_DURATION_SEC;
}

// ── Text pool ────────────────────────────────────────────────────────────────

/** Evidence quotes stripped, filtered, sorted longest-first, capped. Shared
 *  by the text-pool builder (below) and the per-slot retry (needs the same
 *  ordered list to pick "the next quote"). */
function cleanEvidenceQuotes(hint: CharacterHint | undefined): string[] {
  return (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((s) => s.slice(0, AUDITION_QUOTE_MAX_CHARS));
}

/** Build a pool of up to `count` audition texts: distinct evidence quotes,
 *  cycling through them to fill `count` slots when there are fewer than
 *  `count` distinct quotes. Falls back to the canned buildSampleText line
 *  (repeated) only when there's no evidence at all. */
function buildAuditionTexts(
  voice: VoiceLike,
  hint: CharacterHint | undefined,
  cleaned: string[],
  count: number,
): string[] {
  if (cleaned.length === 0) {
    const canned = buildSampleText(voice, hint); // unchanged fallback
    return Array(count).fill(canned);
  }
  return Array.from({ length: count }, (_, i) => cleaned[i % cleaned.length]);
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Build an Option-B centroid from a blended pool: real anchor embeddings
 * (when passed via `opts.existingAnchors`) topped up with new audition
 * renders, embedded, and combined via the trimmed-mean/bimodal-check
 * `buildCentroid`.
 *
 * Phase A: top up `existingAnchors` to `targetN` using up to `deficit +
 * margin` new renders (deficit = max(0, targetN - existingAnchors.length)),
 * stopping as soon as the pool reaches `targetN`.
 *
 * Phase B (only when anchors were blended AND the result comes back
 * bimodal): drop the anchors and top up the ALREADY-RENDERED synthetic set
 * to `targetN`, reusing the SAME shared render budget — never a second,
 * independent budget. The resulting synthetic-only pool is not itself
 * re-checked for bimodality (pre-existing limitation — see the design
 * spec's "Accepted limitation").
 *
 * Duration-floor handling (bounded, at-most-once retry per slot): if a
 * slot's PCM is under MIN_DURATION_SEC, retry once by appending the next
 * distinct evidence quote in the cycle; still under-floor (or no next
 * quote available) → the slot is skipped, not counted as a success.
 *
 * Returns null if synthesis or embedding throws (sidecar unavailable).
 *
 * @param character  Voice info for the character.
 * @param opts       Optional injection seams + pool-size overrides + anchors.
 */
export async function auditionCentroid(
  character: AuditionCharacter,
  opts?: AuditionCentroidOpts,
): Promise<{ centroid: Float32Array; embeddings: Float32Array[]; kind: 'audition' | 'too-short' } | null> {
  const { voiceName, modelKey, voice, hint } = character;
  const targetN = opts?.targetN ?? AUDITION_POOL_TARGET_N;
  const margin = opts?.margin ?? AUDITION_POOL_MARGIN;
  const existingAnchors = opts?.existingAnchors ?? [];

  const synth =
    opts?.synthFn ??
    ((input: { text: string; voiceName: string; modelKey: TtsModelKey }) =>
      selectTtsProvider(input.modelKey).synthesize(input));
  const embed = opts?.embedFn ?? embedSegment;

  /** One render+floor-retry+embed attempt. Returns the embedding on
   *  success, or `null` if the render never clears the floor. A throw from
   *  either the primary synth call or the embed call propagates (signals
   *  "sidecar unavailable, bail entirely"); a throw from the RETRY synth
   *  call is swallowed (keeps the original under-floor render). */
  async function renderAndEmbed(text: string, retryText: string | null): Promise<Float32Array | null> {
    const primary = await synth({ text, voiceName, modelKey });
    let { pcm, sampleRate } = primary;

    if (!isAboveFloor(pcm, sampleRate) && retryText !== null) {
      try {
        const extended = await synth({ text: `${text} ${retryText}`, voiceName, modelKey });
        pcm = extended.pcm;
        sampleRate = extended.sampleRate;
      } catch {
        // Retry failed — keep the original under-floor render.
      }
    }

    if (!isAboveFloor(pcm, sampleRate)) return null;
    return embed(pcm, sampleRate);
  }

  const cleaned = cleanEvidenceQuotes(hint);
  const globalBudget = targetN + margin;
  // Precomputed once so phase A and the phase B top-up draw from the SAME
  // cycle position rather than restarting it.
  const texts = buildAuditionTexts(voice, hint, cleaned, globalBudget);

  const newEmbeddings: Float32Array[] = [];
  let attemptsUsed = 0;

  // ── Phase A: top up existing anchors to the target pool size ───────────
  const deficit = Math.max(0, targetN - existingAnchors.length);
  const phaseAEnd = deficit + margin;
  try {
    while (attemptsUsed < phaseAEnd && existingAnchors.length + newEmbeddings.length < targetN) {
      const i = attemptsUsed;
      const retryText = cleaned.length > 1 ? cleaned[(i + 1) % cleaned.length] : null;
      const vec = await renderAndEmbed(texts[i], retryText);
      attemptsUsed++;
      if (vec) newEmbeddings.push(vec);
    }
  } catch {
    return null; // sidecar unavailable
  }

  const combinedPool = [...existingAnchors, ...newEmbeddings];
  const result = buildCentroid(combinedPool, { minN: targetN });

  if (result.kind === 'too-thin') {
    return { centroid: result.centroid, embeddings: combinedPool, kind: 'too-short' };
  }

  if (!(result.bimodal && existingAnchors.length > 0)) {
    return { centroid: result.centroid, embeddings: combinedPool, kind: 'audition' };
  }

  // ── Phase B: bimodal safety check on the blended pool ──────────────────
  // Anchors are the untrustworthy data causing the split — drop them and
  // top up the ALREADY-RENDERED synthetic set, within the SAME shared
  // render budget (attemptsUsed carries over; never a second, independent
  // budget stacked on top of phase A's).
  try {
    while (attemptsUsed < globalBudget && newEmbeddings.length < targetN) {
      const i = attemptsUsed;
      const retryText = cleaned.length > 1 ? cleaned[(i + 1) % cleaned.length] : null;
      const vec = await renderAndEmbed(texts[i], retryText);
      attemptsUsed++;
      if (vec) newEmbeddings.push(vec);
    }
  } catch {
    return null;
  }

  // The synthetic-only pool is used as-is — not re-checked for its own
  // bimodality (pre-existing limitation; this check exists only for the
  // anchors+synthetic mixing failure mode this redesign introduces).
  const fallback = buildCentroid(newEmbeddings, { minN: targetN });
  if (fallback.kind === 'too-thin') {
    return { centroid: fallback.centroid, embeddings: newEmbeddings, kind: 'too-short' };
  }
  return { centroid: fallback.centroid, embeddings: newEmbeddings, kind: 'audition' };
}
```

### Step 5: Run the tests, confirm they pass

- [ ] Run: `cd server && npx vitest run src/audio/render-integrity/audition-centroid.test.ts`
- [ ] Expected: PASS, all 17 tests green.
- [ ] If either bimodal-path test doesn't observe the expected `kind`, adjust the `axisVec` separation per the Step 2 implementer note — do not weaken the assertion.

### Step 6: Typecheck

- [ ] Run: `npm run typecheck`
- [ ] Expected: no errors. `aggregate.ts`'s existing call site (`auditionCentroid(voiceInfo)`, no `opts` argument) still compiles as-is — it never referenced `CENTROID_K` or `opts.k`, and every new field on `AuditionCentroidOpts` is optional, so Task 1 alone is a non-breaking change for that call site. (Task 2 changes that call site's *behavior*, not its type-compatibility.)

### Step 7: Commit

- [ ] 
```bash
git add server/src/audio/render-integrity/audition-centroid.ts server/src/audio/render-integrity/audition-centroid.test.ts
git commit -m "refactor(server): replace the 12x-identical-render audition centroid with a cost-bounded, anchor-aware pool

srv-36: the Option-B fallback reference now blends real in-book anchor
embeddings with new audition renders (distinct evidence-quote text, not
one repeated line), capped at 8 total render attempts (down from a fixed
12) via AUDITION_POOL_TARGET_N + AUDITION_POOL_MARGIN.

Closes #1386"
```

---

## Task 2: Thread `cast.json` evidence + anchor blending into `aggregate.ts`

**Files:**
- Create: `server/src/audio/render-integrity/aggregate-audition-pool.test.ts`
- Create: `server/src/audio/render-integrity/aggregate-audition-pool-real.test.ts`
- Modify: `server/src/audio/render-integrity/aggregate.ts`

**Interfaces:**
- Consumes: `AuditionCharacter`, `auditionCentroid` from Task 1's `./audition-centroid.js` (unchanged import, now called with a second `opts` argument); `castJsonPath` from `../../workspace/paths.js`; `readJson` from `../../workspace/state-io.js`; `buildHintFromCast`, `CastCharacter` from `../../tts/synthesise-chapter.js`.
- Produces: no new exports — `scoreBook`'s external signature and `resolveCharacterReference`'s behavior-visible contract are unchanged; only the internal `auditionCentroid` call gains real evidence + anchors.

**Why two test files, not one:** `aggregate-audition-pool.test.ts` mocks `auditionCentroid` entirely (matching the established pattern in `aggregate-audition-tier.test.ts`) to test the plumbing in isolation without a sidecar. But that means it can never prove the actual point of this redesign — that blended anchors drive the resulting `cleanMean`/`pSevere`/`pBand` — because the mock never returns a real `'audition'` result. `aggregate-audition-pool-real.test.ts` closes that gap with ONE test that exercises the REAL (unmocked) `auditionCentroid`, using a fixture engineered to need zero synthetic renders (anchors already at/above the default `AUDITION_POOL_TARGET_N`=6, so `auditionCentroid`'s phase-A loop never calls `synth()` at all) — safe to run without a sidecar, and it directly locks the spec's Testing section requirement ("assert the combined pool … drives the resulting `cleanMean`/`pSevere`/`pBand`").

### Step 1: Write the failing test file

- [ ] Create `server/src/audio/render-integrity/aggregate-audition-pool.test.ts`:

```ts
/* srv-36 audition-centroid redesign: scoreBook must (a) thread cast.json's
   evidence onto the Option-B AuditionCharacter as `hint` (previously always
   undefined in production — every real invocation silently used the canned
   fallback line, never a character's actual evidence), and (b) split
   existingAnchors by WHY the fallback triggered — too-thin passes the real
   anchor vectors in; bimodal passes none (they're the untrustworthy data
   causing the split). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async (_character: unknown, _opts?: unknown) => null),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A unit vector in a given axis direction, dim=8, tiny deterministic jitter.
function axisVec(axis: number, i: number, dim = 8): number[] {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return dir.map((v) => v / norm);
}
const vec = (axis: number, i: number) => Float32Array.from(axisVec(axis, i));

function writeThuridFixture(dir: string, anchorCount: number) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: anchorCount }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(0, i),
  }));
  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
    }),
  );
  return writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
}

function writeCastJson(dir: string, characters: Array<Record<string, unknown>>) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

describe('scoreBook — cast.json evidence threading + anchor blending (srv-36 redesign)', () => {
  beforeEach(() => auditionSpy.mockClear());

  it('threads buildHintFromCast onto the AuditionCharacter when cast.json has a matching character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-match-'));
    await writeThuridFixture(dir, 3); // below CENTROID_MIN_N=10 → too-thin
    writeCastJson(dir, [
      { id: 'thurid', evidence: [{ quote: 'A real line Thurid actually says.' }] },
    ]);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: { evidence?: string[] } }];
    expect(character.hint?.evidence).toEqual(['A real line Thurid actually says.']);
  });

  it('leaves hint undefined when cast.json exists but has no matching character id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-nomatch-'));
    await writeThuridFixture(dir, 3);
    writeCastJson(dir, [{ id: 'some-other-character', evidence: [{ quote: 'Not Thurid.' }] }]);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: unknown }];
    expect(character.hint).toBeUndefined();
  });

  it('does not throw and leaves hint undefined when cast.json is entirely missing (best-effort read)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-missing-'));
    await writeThuridFixture(dir, 3); // no .audiobook dir written at all

    await expect(scoreBook(dir, [{ id: 1, slug: 'ch1' }])).resolves.toBeUndefined();

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: unknown }];
    expect(character.hint).toBeUndefined();
  });

  it('passes the real anchor vectors as existingAnchors for a too-thin character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-anchors-toothin-'));
    await writeThuridFixture(dir, 3); // 3 < CENTROID_MIN_N=10 → too-thin

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [, opts] = auditionSpy.mock.calls[0] as unknown as [unknown, { existingAnchors?: Float32Array[] }];
    expect(opts?.existingAnchors?.length).toBe(3);
  });

  it('passes NO anchors (empty array) for a bimodal character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-anchors-bimodal-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    // 10 anchors split 3-and-7 across orthogonal axes — clears CENTROID_MIN_N
    // (10) and trips centroid.ts's own bimodal detection. Deliberately
    // ASYMMETRIC (not 5-and-5): an even split can leave the weighted
    // centroid equidistant from both clusters, producing near-identical
    // cosines-to-centroid on both sides and no detectable gap.
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: vec(0, i) })),
      ...Array.from({ length: 7 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [3 + i], vec: vec(1, i) })),
    ];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [, opts] = auditionSpy.mock.calls[0] as unknown as [unknown, { existingAnchors?: Float32Array[] }];
    expect(opts?.existingAnchors ?? []).toEqual([]);
  });
});
```

- [ ] **Note for the implementer:** if the "passes NO anchors for a bimodal character" fixture doesn't actually trigger `result.kind === 'in-book' && result.bimodal` in `resolveCharacterReference` (i.e. `auditionSpy` is never called because the 10-vector pool classified as a clean `in-book` non-bimodal reference instead), widen the axis separation the same way as Task 1's note — the invariant under test (bimodal → no anchors) is what matters, not these exact vectors.

### Step 2: Write the second (unmocked) test file

- [ ] Create `server/src/audio/render-integrity/aggregate-audition-pool-real.test.ts`:

```ts
/* srv-36 audition-centroid redesign: the whole point of blending real
   anchor embeddings into the Option-B pool is that they drive the
   resulting cleanMean/pSevere/pBand — but aggregate-audition-pool.test.ts
   mocks auditionCentroid entirely, so it can never prove that. This file
   exercises the REAL (unmocked) auditionCentroid via a fixture engineered
   to need ZERO synthetic renders: a too-thin character (< CENTROID_MIN_N=10
   anchor-eligible embeddings, so centroid.ts routes it to the audition
   fallback) whose anchor count is already at/above auditionCentroid's
   DEFAULT AUDITION_POOL_TARGET_N (6) — scoreBook calls auditionCentroid
   with no targetN/margin override, so the default (6) applies. With
   existingAnchors.length >= 6, auditionCentroid's phase-A deficit is 0, so
   its render loop never calls synth() at all — safe to run without a
   sidecar, no mock needed. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { scoreBook } from './aggregate.js';
import { readCentroids } from './centroids-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A unit vector in a given axis direction, dim=8, tiny deterministic jitter —
// a single tight cluster (not bimodal), mirroring the codebase's existing
// vec() helpers in aggregate.test.ts / aggregate-audition-tier.test.ts.
function axisVec(axis: number, i: number, dim = 8): number[] {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return dir.map((v) => v / norm);
}
const vec = (i: number) => Float32Array.from(axisVec(0, i));

describe('scoreBook — real (unmocked) auditionCentroid drives the spread from blended anchors', () => {
  it('a too-thin character whose anchors already meet the default target gets referenceKind "audition" with a real, anchor-derived cleanMean', async () => {
    // Belt-and-suspenders against #1242/#1243 (a dev box's own live sidecar
    // on :9000 turning a "fails fast" assumption into a 15s hang): point
    // LOCAL_TTS_URL at a guaranteed-empty ephemeral port. After Task 2's fix
    // this test never actually reaches the network (existingAnchors alone
    // meet target, so auditionCentroid's synth() loop never runs) — but the
    // guard keeps this test safe to run standalone at ANY point in the TDD
    // cycle, including the pre-fix "confirm it fails" step, which (before
    // existingAnchors is threaded through) DOES attempt a real network call.
    const probe = createServer();
    const ephemeralPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const prevLocalTtsUrl = process.env.LOCAL_TTS_URL;
    process.env.LOCAL_TTS_URL = `http://127.0.0.1:${ephemeralPort}`;

    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-real-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });

    // 8 anchor-eligible vectors: below CENTROID_MIN_N=10 (too-thin per
    // centroid.ts) but above AUDITION_POOL_TARGET_N=6 (so auditionCentroid
    // needs zero new renders — existingAnchors alone already meet target).
    const rows = Array.from({ length: 8 }, (_, i) => ({
      characterId: 'thurid',
      sentenceIds: [i],
      vec: vec(i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );
    // No cast.json — hint stays undefined, irrelevant here since no text
    // ever gets rendered (deficit=0, zero synth() calls).

    try {
      await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    } finally {
      if (prevLocalTtsUrl === undefined) delete process.env.LOCAL_TTS_URL;
      else process.env.LOCAL_TTS_URL = prevLocalTtsUrl;
    }

    const centroids = await readCentroids(dir);
    expect(centroids).not.toBeNull();
    const ref = centroids!['thurid'];
    // Real auditionCentroid returned kind='audition' (built purely from the
    // 8 blended anchors, zero synthetic renders) — NOT 'too-short'.
    expect(ref.referenceKind).toBe('audition');
    // The 8 anchors are a tight single cluster, so their cosines to their
    // own centroid are all very close to 1 — cleanMean must reflect that
    // real spread, not a placeholder/zero value.
    expect(ref.cleanMean).toBeGreaterThan(0.9);
  });
});
```

### Step 3: Run both new test files, confirm they fail

- [ ] Run: `cd server && npx vitest run src/audio/render-integrity/aggregate-audition-pool.test.ts src/audio/render-integrity/aggregate-audition-pool-real.test.ts`
- [ ] Expected: FAIL. `aggregate-audition-pool.test.ts`: `character.hint` is `undefined` in every case (including the "matching cast entry" case, which should be populated), because `aggregate.ts` doesn't read `cast.json` yet and never passes `existingAnchors`. `aggregate-audition-pool-real.test.ts`: `existingAnchors` is never passed, so real `auditionCentroid` renders the full default target+margin from scratch and (with no sidecar reachable in this test env) returns `null` → `referenceKind` is `'too-short'`, not `'audition'`.

### Step 4: Modify `aggregate.ts`

- [ ] Add imports — modify the existing import block near the top of `server/src/audio/render-integrity/aggregate.ts`:

```ts
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { audioDir, castJsonPath } from '../../workspace/paths.js';
import { readJson } from '../../workspace/state-io.js';
import { loadSegmentsFiles } from '../segments-io.js';
import { readEmbeddings, type EmbeddingRow } from './embeddings-io.js';
import { writeVerdicts, writeAttempted, attemptedPath, type VerdictRow } from './verdicts-io.js';
import {
  writeCentroids,
  type CharacterCentroid,
} from './centroids-io.js';
import { buildCentroid } from './centroid.js';
import {
  cosineToCentroid,
  percentile,
  scoreSegment,
  CUTOFFS,
} from './score.js';
import { auditionCentroid, type AuditionCharacter } from './audition-centroid.js';
import { canonicalModelKeyForEngine, type TtsModelKey } from '../../tts/model-keys.js';
import { buildHintFromCast, type CastCharacter } from '../../tts/synthesise-chapter.js';
```

(Only the `audioDir` import line, and the two new import lines for `readJson` and `buildHintFromCast`/`CastCharacter`, are additions — everything else is unchanged.)

- [ ] Add a `readCastJson` helper directly below the existing `readSegmentsFile` helper (same file, same best-effort-read pattern):

```ts
/** Read cast.json; returns null on missing/malformed (best-effort — mirrors
 *  readSegmentsFile's swallow-all contract just above). A missing or
 *  unparseable cast.json yields no hints for any character in this book —
 *  identical to this function's behavior before cast.json-sourced hints
 *  existed at all, not a new failure mode. */
async function readCastJson(bookDir: string): Promise<CastCharacter[] | null> {
  try {
    const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
    return cast?.characters ?? null;
  } catch {
    return null;
  }
}
```

- [ ] In `resolveCharacterReference`, change the too-thin/bimodal branch's `auditionCentroid` call to pass `existingAnchors` — split by `result.kind`:

```ts
  // Task 10: too-thin OR bimodal → Option-B audition centroid.
  if (voiceInfo) {
    const audition = await auditionCentroid(voiceInfo, {
      // Too-thin: blend the real anchors in (better signal than synthetic-only).
      // Bimodal: pass none — the anchors ARE the untrustworthy data causing
      // the split; auditionCentroid falls back to a pure audition-only pool.
      existingAnchors: result.kind === 'too-thin' ? anchorVecs : [],
    });
```

(This replaces the single line `const audition = await auditionCentroid(voiceInfo);` — everything below it in that `if` block is unchanged.)

- [ ] In `scoreBook`'s Phase 2, load `cast.json` once and thread `hint` onto each `voiceInfoByChar` entry. Modify the block starting at `const classificationSources = await loadSegmentsFiles(bookDir, chapters);`:

```ts
  const classificationSources = await loadSegmentsFiles(bookDir, chapters);
  const configuredEngineByChar = resolveConfiguredEngineByChar(classificationSources);
  // srv-36 audition-centroid redesign: cast.json is the only place evidence
  // quotes live, so it's read once here (best-effort — see readCastJson) and
  // threaded onto each character's Option-B voice info as `hint`, letting
  // auditionCentroid build a per-render pool of distinct evidence quotes
  // instead of one repeated canned line.
  const castChars = await readCastJson(bookDir);
  const castById = new Map((castChars ?? []).map((c) => [c.id, c] as const));
  // Voice info for Option-B audition centroid (Task 10): voiceName + modelKey per char.
  const voiceInfoByChar = new Map<string, AuditionCharacter>();
  for (const cd of chapterData) {
    for (const [charId, snap] of Object.entries(cd.snapshots)) {
      // Collect voice info for Option-B (first chapter's snapshot wins).
      if (!voiceInfoByChar.has(charId) && snap.voiceEngine && snap.resolvedVoiceName && STOCHASTIC_ENGINES.has(snap.voiceEngine)) {
        const engine = snap.voiceEngine as import('../../tts/model-keys.js').TtsEngine;
        // Render the Option-B audition under the SAME tier this character ACTUALLY
        // rendered in — NOT a hardcoded 0.6B. canonicalModelKeyForEngine returns a
        // Qwen request key VERBATIM, so the old 'qwen3-tts-0.6b' placeholder forced
        // EVERY too-thin/bimodal Qwen character's audition (K=12 full synths) onto the
        // 0.6B base: co-resident with a 1.7B render (8GB-card OOM), and embedded under
        // a model whose speaker space isn't comparable to the 1.7B-rendered anchors (a
        // corrupt centroid). Prefer the PER-CHARACTER stamp (elevate-only tier from
        // buildCharacterSnapshots) so an elevated Qwen char in a non-Qwen-default book
        // isn't under-tiered by the chapter run-default; fall back to the chapter-level
        // modelKey, then 0.6B for legacy segments with neither stamp.
        const renderKey: TtsModelKey = snap.modelKey ?? cd.modelKey ?? 'qwen3-tts-0.6b';
        const modelKey = canonicalModelKeyForEngine(engine, renderKey);
        const castChar = castById.get(charId);
        voiceInfoByChar.set(charId, {
          voiceName: snap.resolvedVoiceName,
          modelKey,
          voice: {
            id: charId,
            // attributes may not be in the snapshot; fall back to empty
            attributes: snap.attributes,
          },
          hint: castChar ? buildHintFromCast(castChar) : undefined,
        });
      }
    }
  }
```

(Only the `castChars`/`castById` lines above the `voiceInfoByChar` declaration, and the trailing `hint: castChar ? buildHintFromCast(castChar) : undefined,` line inside `voiceInfoByChar.set(...)`, are additions — the render-tier resolution logic in between is unchanged.)

### Step 5: Run both new test files, confirm they pass

- [ ] Run: `cd server && npx vitest run src/audio/render-integrity/aggregate-audition-pool.test.ts src/audio/render-integrity/aggregate-audition-pool-real.test.ts`
- [ ] Expected: PASS — 5 tests green in the mocked file, 1 test green in the real (unmocked) file. The real file's test now takes the zero-network path (`existingAnchors` is threaded through, deficit=0), confirming both that the plumbing works AND that it's fast/no-sidecar-required in this state.

### Step 6: Run the full existing render-integrity suite, confirm no regressions

- [ ] Run: `cd server && npx vitest run src/audio/render-integrity/`
- [ ] Expected: PASS — in particular, `aggregate.test.ts`'s "too-few anchors" test (no `cast.json` on disk, real network call to an empty ephemeral port) and all 3 fixtures in `aggregate-audition-tier.test.ts` (no `cast.json` on disk either) must stay green, confirming the best-effort `readCastJson` never throws on a missing file.

### Step 7: Typecheck

- [ ] Run: `npm run typecheck`
- [ ] Expected: no errors.

### Step 8: Commit

- [ ] 
```bash
git add server/src/audio/render-integrity/aggregate.ts server/src/audio/render-integrity/aggregate-audition-pool.test.ts server/src/audio/render-integrity/aggregate-audition-pool-real.test.ts
git commit -m "refactor(server): thread cast.json evidence and in-book anchors into the audition centroid

srv-36: scoreBook now reads cast.json once (best-effort) and threads each
character's evidence quotes onto the Option-B AuditionCharacter as \`hint\`
— previously always undefined in production, silently no-oping the
duration-floor retry and forcing every fallback onto the canned sample
line. Too-thin characters' real anchor embeddings are now blended into
the fallback pool (proven via one unmocked, sidecar-free integration
test asserting the resulting cleanMean); bimodal characters' are
correctly excluded.

Refs #1386"
```

---

## Task 3: Verify, document, and ship

**Files:**
- Modify: `docs/release-notes-next.md`

### Step 1: Full branch-scoped verification

- [ ] Run: `npm run verify:fast:branch`
- [ ] Expected: PASS. If a pre-existing failure surfaces unrelated to this change (triage per CLAUDE.md's "Related → fix it. Pre-existing → surface to the user"), stop and report rather than silently proceeding.

### Step 2: Release notes

This is an internal backend algorithm change (a scoring-pipeline fallback's cost/quality mechanics) with **no user-visible behavior delta** — no new UI, no changed output shape, no changed user-facing timing. Per CLAUDE.md's before-shipping checklist item 4, add a technical-register entry to `docs/release-notes-next.md` under "🏗️ Under the hood"; **skip `RELEASE_NOTES.md`** (explicitly — no shippable user-facing delta to translate into brand voice).

- [ ] In `docs/release-notes-next.md`, under the `## 🏗️ Under the hood` section, add:

```
- **The srv-36 audition-centroid backup reference now blends real in-book anchor embeddings with fewer, more diverse audition renders** instead of rendering one repeated short quote 12 times. Too-thin characters' existing anchors top up a smaller synthetic pool (target 6, cap 8 total renders — down from a fixed 12); bimodal characters get a pure audition-only pool at the same smaller size. Internal fallback-reference quality/cost change — no user-visible behavior change (srv-36, #1386).
```

- [ ] 
```bash
git add docs/release-notes-next.md
git commit -m "docs(docs): note the srv-36 audition-centroid reference redesign in release notes"
```

### Step 3: Push and open the PR

- [ ] 
```bash
git push -u origin refactor/server-srv36-audition-centroid
gh pr create --title "refactor(server): replace the 12x-identical-render audition centroid with a cost-bounded, anchor-aware pool" --body "$(cat <<'EOF'
## Summary
- Replaces the srv-36 Option-B audition-centroid fallback's fixed K=12-identical-render loop with a smaller (target 6, hard cap 8), anchor-aware, text-diverse pool.
- Threads cast.json evidence into the fallback for the first time in production (previously silently undefined, no-oping the existing duration-floor retry).
- Too-thin characters' real in-book anchor embeddings are now reused; bimodal characters correctly get none.

Design spec (3 rounds of adversarial review): `docs/superpowers/specs/2026-07-07-srv36-audition-centroid-reference-design.md`

## Test plan
- [x] `audition-centroid.test.ts` rewritten — 17 cases covering pool-fill math, per-slot retry semantics, text cycling, the bimodal-blend cost-cap regression, and the round-3 shortfall regression.
- [x] New `aggregate-audition-pool.test.ts` — 5 cases covering hint threading (match/no-match/missing-cast.json) and the too-thin/bimodal anchor split (via a mocked `auditionCentroid`).
- [x] New `aggregate-audition-pool-real.test.ts` — 1 case exercising the REAL (unmocked) `auditionCentroid` end-to-end, proving blended anchors actually drive the resulting `cleanMean` — the mocked test file above can't prove this on its own.
- [x] Existing `aggregate.test.ts` + `aggregate-audition-tier.test.ts` unaffected (both have fixtures with no cast.json on disk — confirms the best-effort read doesn't regress them).
- [x] `npm run verify:fast:branch` green.

Closes #1386
EOF
)"
```

### Step 4: Mandatory independent review

Per CLAUDE.md's "Mandatory review gates": this PR is `refactor(server)`, single-scope — the model-routing skill's effort table puts `refactor` at **`high`** regardless of scope count.

- [ ] Once pushed and the PR is open, run the `code-review` skill at `high` effort (no `--fix`) against this branch.
- [ ] Triage findings per the skill's Findings handling: fix clear-cut correctness bugs directly, commit, push (re-triggers review per the loop rules); route genuine judgment calls back to the user rather than auto-resolving.

### Step 5: Merge

- [ ] Once cloud `verify.yml` and the code-review pass are both green and any findings are resolved, merge via `gh pr merge --merge` (repo merges are "Create a merge commit" only — squash/rebase disabled).
