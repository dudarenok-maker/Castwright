/* fs-38 Wave 3b1 — advisory clone-fidelity check (spec §3.4).

   Embeds the master clip and the clone audition preview via the sidecar's
   ECAPA /embed endpoint and cosine-scores them. NON-blocking: below a
   srv-36-calibrated threshold it returns a warning string the wizard can
   surface, but never fails the clone. */

import { embedSegment } from './embed-client.js';
import { cosineToCentroid } from '../audio/render-integrity/score.js';

/* Starting value — calibrated on-box against the golden fixture (srv-36
   centroid distributions cluster clean same-speaker cosines well above this).
   Deliberately conservative so only a clearly-off clone warns. */
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
