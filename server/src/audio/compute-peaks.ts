/* Fixed-length waveform-envelope reducer for chapter audio.

   Listen view's waveform card paints a `peaks: number[]` array (length 240)
   into a fixed-width strip of bars. Before this module landed the
   chapter-audio meta endpoint returned `peaks: []` and the frontend filled
   in a sinusoidal mock — visually plausible but a lie. `computePeaks`
   replaces that lie with a real RMS-bin summary of the rendered chapter
   PCM, emitted at encode time and persisted next to the MP3 (see
   `server/src/tts/mp3.ts`'s `writeChapterPeaksFile` and BACKLOG Could #35).

   Contract:
   - Input: raw 16-bit signed little-endian MONO PCM (`Buffer`), same shape
     the sidecar emits and `encodePcmToMp3` consumes. Sample rate is
     informational — peak bins are sample-count proportional, not time-
     proportional, so the same PCM at a different sample rate produces the
     same shape. Sample rate is accepted for parity with other helpers in
     this layer and to leave the door open for future time-based reducers.
   - Output: exactly `BIN_COUNT` (= 240) `number`s in `[0, 1]`.
   - Reduction: each bin's value is the RMS (root-mean-square) of every
     sample that falls inside it, normalized by the peak RMS across all
     bins so the loudest bin reads `1.0`. Silence (entirely zero PCM) maps
     to `[0, 0, …, 0]` rather than NaN.
   - Short input (< BIN_COUNT samples): bins map 1:1 onto samples for the
     first N positions; the trailing `BIN_COUNT - N` bins are 0. We do
     NOT upsample / repeat — that would smear a real waveform shape, and
     in practice every chapter rendered by the pipeline is many seconds
     long. The all-zero tail makes "this chapter is suspiciously tiny"
     visible at a glance in the Listen waveform.
   - Long input (>> BIN_COUNT): each bin's sample window is computed in
     integer-arithmetic-friendly fashion (`floor(i * N / BIN_COUNT)` ..
     `floor((i+1) * N / BIN_COUNT)`) so every sample lands in exactly one
     bin and no sample is double-counted. Last bin always includes the
     final sample (no off-by-one drop).

   Purity: NO file I/O, NO ffmpeg shell-out, NO timers, NO randomness. The
   wrapper that writes the peaks JSON lives in `mp3.ts` (atomic-write
   convention matches `state-io.ts`'s `writeJsonAtomic`). */

export const BIN_COUNT = 240;
export const BYTES_PER_SAMPLE = 2;

/** Reduce raw 16-bit LE mono PCM to a `BIN_COUNT`-length RMS envelope
 *  normalized to `[0, 1]`. See module header for the full contract.
 *
 *  @param pcm Raw 16-bit signed little-endian mono PCM buffer.
 *  @param sampleRate Hz. Currently informational — see header.
 *  @returns A length-`BIN_COUNT` array of finite numbers in `[0, 1]`.
 */
export function computePeaks(pcm: Buffer, sampleRate: number): number[] {
  /* sampleRate is accepted but not consumed in the current reduction —
     RMS-per-bin is sample-count proportional. Validate to surface
     mis-wiring early (a 0 / NaN / negative rate is always a bug). */
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`computePeaks: sampleRate must be a positive finite number, got ${sampleRate}`);
  }
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const bins = new Array<number>(BIN_COUNT).fill(0);
  if (sampleCount === 0) return bins;

  if (sampleCount < BIN_COUNT) {
    /* Map each sample to its own bin; trailing bins stay 0. Absolute
       sample value (normalized to [0,1] against int16 full scale) is
       used directly — RMS of a single sample is just |sample|. */
    let peak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
      /* 32768 = -INT16_MIN; using it as the denominator means a sample
         at the negative full-scale (-32768) normalizes to exactly 1.0
         and positive full-scale (32767) to ~0.99997. Choosing 32768
         over 32767 avoids the rare case where a positive-clipping
         signal exceeds 1.0 after the normalization step. */
      const abs = Math.abs(sample) / 32768;
      bins[i] = abs;
      if (abs > peak) peak = abs;
    }
    if (peak > 0) {
      for (let i = 0; i < sampleCount; i += 1) bins[i] = bins[i] / peak;
    }
    return bins;
  }

  /* General case: bucket samples into BIN_COUNT integer windows and
     compute RMS per window. `start`/`end` use `floor(i * N / BIN_COUNT)`
     to guarantee complete, non-overlapping coverage of [0, sampleCount). */
  let peakRms = 0;
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    const start = Math.floor((bin * sampleCount) / BIN_COUNT);
    const end = Math.floor(((bin + 1) * sampleCount) / BIN_COUNT);
    const windowSize = end - start;
    if (windowSize === 0) {
      bins[bin] = 0;
      continue;
    }
    let sumOfSquares = 0;
    for (let i = start; i < end; i += 1) {
      /* Normalize to [-1, 1] before squaring so the RMS itself is in
         [0, 1]. Doing this inside the inner loop costs one divide per
         sample but keeps the running sum from overflowing on long
         chapters (a 1-hour chapter at 24 kHz is 86.4 M samples; sum of
         raw int16 squares would breach Number.MAX_SAFE_INTEGER). */
      const normalized = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
      sumOfSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumOfSquares / windowSize);
    bins[bin] = rms;
    if (rms > peakRms) peakRms = rms;
  }

  /* Normalize so the loudest bin reads 1.0. Silent chapters (peakRms === 0)
     return the all-zero array we already populated, which is correct: there
     is no "shape" to render. */
  if (peakRms > 0) {
    for (let bin = 0; bin < BIN_COUNT; bin += 1) bins[bin] = bins[bin] / peakRms;
  }
  return bins;
}
