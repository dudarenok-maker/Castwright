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
