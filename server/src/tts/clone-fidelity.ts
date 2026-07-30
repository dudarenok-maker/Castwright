/* fs-38 Wave 3b1 — advisory clone-fidelity check (spec §3.4).

   Embeds the master clip and the clone audition preview via the sidecar's
   ECAPA /embed endpoint and cosine-scores them. The LOW-SCORE path is
   non-blocking: below a srv-36-calibrated threshold it returns a warning
   string the wizard can surface, rather than failing the clone. A
   TRANSPORT failure of /embed itself is NOT swallowed here — it propagates
   to the caller (the /clone route), which maps it to an error response. */

import { embedSegment } from './embed-client.js';
import { cosineToCentroid } from '../audio/render-integrity/score.js';

/* Starting value — calibrated on-box against the golden fixture (srv-36
   centroid distributions cluster clean same-speaker cosines well above this).
   Deliberately conservative so only a clearly-off clone warns.

   What this compares (#1945): the clone's audition preview against its OWN
   master clip — the SAME source on both sides. That makes it a detector for
   a clone that reproduces the WRONG SPEAKER, not for a poor-quality source;
   source quality is already gated separately, before this check ever runs,
   by clone-quality.ts. Degrading the source clip therefore can't lower this
   cosine — both sides of the comparison degrade together. On-box numbers
   (#1945): clean clone vs. its own source measured 0.891/0.881; a
   band-limited source (F-8) measured 0.881 — not lower; two speakers
   overlaid measured 0.773; a different designed voice entirely measured
   0.158. So 0.3 is a coherent catastrophe-only backstop: it fires when a
   clone comes out sounding like a different speaker, and stays silent
   otherwise. See server/src/routes/voice-library.clone-fidelity.test.ts for
   the automated coverage that replaced the (impossible) manual B-06 step of
   trying to trip this by degrading the source. */
export const CLONE_FIDELITY_MIN = 0.3;

export interface CloneFidelity {
  cosine: number;
  warning?: string;
}

export async function assessCloneFidelity(
  masterPcm: Buffer,
  previewPcm: Buffer,
  sampleRate: number,
  opts: { signal?: AbortSignal; sidecarUrl?: string } = {},
): Promise<CloneFidelity> {
  const [master, preview] = await Promise.all([
    embedSegment(masterPcm, sampleRate, opts),
    embedSegment(previewPcm, sampleRate, opts),
  ]);
  const cosine = cosineToCentroid(Array.from(master), Array.from(preview));
  if (cosine < CLONE_FIDELITY_MIN) {
    return {
      cosine,
      warning:
        `This clone sounds only loosely like the sample (similarity ${cosine.toFixed(2)}). ` +
        `You can keep it, or re-record a cleaner clip and try again.`,
    };
  }
  return { cosine };
}
