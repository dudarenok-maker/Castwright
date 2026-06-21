/**
 * srv-36 Option-B audition centroid (Task 10).
 *
 * When a character has too few in-book anchor vectors (too-thin) or a
 * bimodal distribution, we fall back to rendering the character's approved
 * audition sample K times under their configured voice, embedding each render
 * with ECAPA, and using that K-sample centroid as the character reference.
 *
 * Injected `synthFn`/`embedFn` default to the real providers so the function
 * is unit-testable without a sidecar.
 */

import { selectTtsProvider, type TtsModelKey, type SynthesizeOutput } from '../../tts/index.js';
import { embedSegment } from '../../tts/embed-client.js';
import { buildSampleText } from '../../tts/voice-sample-cache.js';
import { buildCentroid } from './centroid.js';
import { MIN_DURATION_SEC } from './constants.js';
import { pcmDurationSec } from '../../tts/pcm.js';
import type { VoiceLike, CharacterHint } from '../../tts/voice-mapping.js';

// ── Exported constant ─────────────────────────────────────────────────────────

/** Number of audition renders used to build the Option-B centroid. */
export const CENTROID_K = 12;

// ── Parameter types ───────────────────────────────────────────────────────────

/** Minimal voice info needed to render a character's audition sample. */
export interface AuditionCharacter {
  /** The voice name (resolved at render time, e.g. `qwen-<uuid>` or `af_sarah`). */
  voiceName: string;
  /** The TTS model key that drove this character's renders. */
  modelKey: TtsModelKey;
  /** A minimal VoiceLike so `buildSampleText` can construct the sample text. */
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
  /** Override K (default: CENTROID_K). */
  k?: number;
}

// ── Duration helper ───────────────────────────────────────────────────────────

/** True when the PCM buffer is long enough to produce a reliable embedding. */
function isAboveFloor(pcm: Buffer, sampleRate: number): boolean {
  return pcmDurationSec(pcm.length, sampleRate) >= MIN_DURATION_SEC;
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Build an Option-B centroid by rendering the character's audition sample
 * K times, embedding each, and computing the trimmed-mean centroid.
 *
 * Duration-floor handling (bounded, at-most-once retry per render):
 *   - If a render's PCM is shorter than MIN_DURATION_SEC, attempt one retry
 *     by appending the second-longest evidence quote to the sample text.
 *   - If still under the floor (or no extra evidence), record the render
 *     as under-floor.
 *   - If EVERY render is under-floor → return `{ kind: 'too-short' }`.
 *
 * Returns null if synthesis throws (sidecar unavailable).
 *
 * @param character  Voice info for the character.
 * @param opts       Optional injection seams (synthFn, embedFn, k override).
 */
export async function auditionCentroid(
  character: AuditionCharacter,
  opts?: AuditionCentroidOpts,
): Promise<{ centroid: Float32Array; embeddings: Float32Array[]; kind: 'audition' | 'too-short' } | null> {
  const { voiceName, modelKey, voice, hint } = character;
  const k = opts?.k ?? CENTROID_K;

  // Resolve injection seams
  const synth =
    opts?.synthFn ??
    ((input: { text: string; voiceName: string; modelKey: TtsModelKey }) =>
      selectTtsProvider(input.modelKey).synthesize(input));
  const embed = opts?.embedFn ?? embedSegment;

  // Primary sample text from the longest evidence quote (or canned fallback)
  const primaryText = buildSampleText(voice, hint);

  // Pre-compute a secondary text (second-longest evidence quote) for the retry path.
  // We never fabricate text — only real evidence quotes are used.
  const evidenceQuotes = (hint?.evidence ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);

  // Second-longest quote (index 1), appended after the primary on retry.
  const secondaryQuote = evidenceQuotes[1] ?? null;

  // Render K times, embed each.
  const embeddings: Float32Array[] = [];
  let aboveFloorCount = 0;

  for (let i = 0; i < k; i++) {
    let result: SynthesizeOutput;
    try {
      result = await synth({ text: primaryText, voiceName, modelKey });
    } catch {
      // Sidecar unavailable — bail entirely
      return null;
    }

    let { pcm, sampleRate } = result;

    // Duration-floor: attempt one retry with extended text
    if (!isAboveFloor(pcm, sampleRate) && secondaryQuote !== null) {
      try {
        const extended = await synth({
          text: `${primaryText} ${secondaryQuote}`,
          voiceName,
          modelKey,
        });
        pcm = extended.pcm;
        sampleRate = extended.sampleRate;
      } catch {
        // Retry failed — keep the original under-floor render
      }
    }

    if (!isAboveFloor(pcm, sampleRate)) {
      // Under-floor even after retry — skip this render
      continue;
    }

    aboveFloorCount++;

    let vec: Float32Array;
    try {
      vec = await embed(pcm, sampleRate);
    } catch {
      // Embed failed — sidecar issue; bail
      return null;
    }
    embeddings.push(vec);
  }

  // If no renders cleared the floor, the character's sample text is too short
  if (aboveFloorCount === 0) {
    return { centroid: new Float32Array(0), embeddings: [], kind: 'too-short' };
  }

  // Build the centroid from the above-floor embeddings
  const result = buildCentroid(embeddings);

  // If too-thin (fewer than CENTROID_MIN_N), we still return a best-effort
  // centroid but mark it too-short (can't score reliably)
  if (result.kind === 'too-thin') {
    return { centroid: result.centroid, embeddings, kind: 'too-short' };
  }

  return { centroid: result.centroid, embeddings, kind: 'audition' };
}
