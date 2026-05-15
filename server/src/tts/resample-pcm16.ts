/* Linear-interpolation resampler for 16-bit signed little-endian mono PCM.

   Used by `synthesiseChapter` to reconcile mid-chapter sample-rate mismatches
   (e.g. a per-character engine swap that puts a Kokoro 24 kHz group inside
   a Coqui 22.05 kHz chapter). Quality is fine for speech — linear interp
   between adjacent int16 samples introduces a tiny bit of aliasing in the
   high band, but at these rate ratios (~10% off) and for narration content
   it's inaudible. The alternative — spawning ffmpeg per group — costs
   200-400 ms of latency that we don't want inside the synthesis loop. */

/** Resample a PCM16 LE mono buffer from `fromHz` to `toHz` using linear
 *  interpolation. Identity (`fromHz === toHz`) returns the input untouched.
 *  Odd-length input (a trailing half-sample byte) is silently rounded down
 *  to even — the malformed half-sample is dropped. */
export function resamplePcm16(buf: Buffer, fromHz: number, toHz: number): Buffer {
  if (fromHz <= 0 || toHz <= 0) {
    throw new Error(`resamplePcm16: rates must be positive (from=${fromHz}, to=${toHz})`);
  }
  if (fromHz === toHz) return buf;

  /* Drop a trailing half-sample if the buffer is odd-length. PCM16 frames are
     2 bytes; an odd byte tail is malformed. We don't want to throw inside a
     mid-chapter synth loop — silently dropping the half-byte matches how
     audio decoders generally handle truncation. */
  const usableBytes = buf.length - (buf.length % 2);
  const inSamples = usableBytes / 2;
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.max(1, Math.round((inSamples * toHz) / fromHz));
  const out = Buffer.alloc(outSamples * 2);
  const ratio = fromHz / toHz; // input-samples per output-sample

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const lower = Math.floor(srcPos);
    const upper = lower + 1;
    const frac = srcPos - lower;

    /* Clamp at the upper boundary: when the last output sample lands at or
       beyond the final input index, just reuse the last input sample (no
       extrapolation past the data we have). */
    const lowerSample = lower < inSamples ? buf.readInt16LE(lower * 2) : 0;
    const upperSample = upper < inSamples ? buf.readInt16LE(upper * 2) : lowerSample;

    const interpolated = lowerSample * (1 - frac) + upperSample * frac;
    /* Round-half-away-from-zero, then clamp to int16 range. The clamp is
       belt-and-braces — for in-range input the interpolation can't exceed
       int16 limits — but defends against future callers passing data that
       was already saturated. */
    const rounded = interpolated >= 0
      ? Math.floor(interpolated + 0.5)
      : Math.ceil(interpolated - 0.5);
    const clamped = Math.max(-32768, Math.min(32767, rounded));
    out.writeInt16LE(clamped, i * 2);
  }

  return out;
}
