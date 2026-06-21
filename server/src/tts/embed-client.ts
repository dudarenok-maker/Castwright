/* HTTP client for the TTS sidecar's `/embed` endpoint (srv-36 render-integrity).

   The client posts raw PCM to the sidecar's ECAPA embedding model and returns
   a 192-dimensional vector for render-integrity QA checks (same model as
   voice-clone matching).

   Wire protocol — POST {url}/embed:
     request:  audio/L16  raw 16-bit signed LE mono PCM (the bytes /synthesize
               emits), `X-Sample-Rate` header (required).
     response: application/json
               { embedding: number[], dim: 192, sample_rate: number }

   CPU ECAPA embed is sub-second, so bare fetch is acceptable (no special timeout Agent). */

import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export async function embedSegment(pcm: Buffer, sampleRate: number): Promise<Float32Array> {
  const base = getResolvedSidecarUrl().replace(/\/+$/, '');
  const res = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'audio/L16', 'x-sample-rate': String(sampleRate) },
    body: pcm,
  });
  if (!res.ok) throw new Error(`/embed ${res.status}`);
  const body = (await res.json()) as { embedding: number[] };
  return Float32Array.from(body.embedding);
}
