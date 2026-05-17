/* Raw 16-bit signed little-endian mono PCM helpers. The sidecar emits PCM
   in this shape; Node-side encoders (currently `./mp3.ts`) consume it. */

export const BYTES_PER_SAMPLE = 2; // 16-bit
export const CHANNELS = 1;          // mono

/** Duration in seconds of a raw 16-bit mono PCM buffer of `pcmBytes` length
    at `sampleRate`. */
export function pcmDurationSec(pcmBytes: number, sampleRate: number): number {
  return pcmBytes / (sampleRate * CHANNELS * BYTES_PER_SAMPLE);
}
