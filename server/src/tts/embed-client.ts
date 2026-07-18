/* HTTP client for the TTS sidecar's `/embed` endpoint (srv-36 render-integrity).

   Posts raw PCM to the sidecar's ECAPA embedding model and returns a 192-d
   vector for render-integrity QA checks.

   Wire protocol — POST {url}/embed:
     request:  audio/L16  raw 16-bit signed LE mono PCM (the bytes /synthesize
               emits), `X-Sample-Rate` header (required).
     response: application/json  { embedding: number[], dim: 192, sample_rate }

   VRAM arbitration (srv-47 follow-up): this is a sidecar op — VRAM arbitration
   now lives in the sidecar's capacity admission (behind SEG_CAPACITY_ADMISSION),
   not a Node-side GPU token here. Flag off: this runs in the normal sequential
   workflow (embeds happen in cast-review/QA phases, poolWidth=1 renders
   serialize), matching the whole feature's flag-off model. */

import { fetch as undiciFetch, Agent } from 'undici';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export interface EmbedOptions {
  signal?: AbortSignal;
  /** Override the sidecar URL (tests inject a fake). */
  sidecarUrl?: string;
}

/* Same long-call dispatcher rationale as transcribe-client.ts: an embed is
   short, but keep header/body timeouts unlimited so a busy sidecar never aborts
   mid-call; connectTimeout stays short so a down sidecar fails fast. */
const EMBED_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});

/** True when the embed runs on the GPU. Reads the SAME `SPK_DEVICE` env the
    sidecar reads (shared env under `npm start`), so it stays in lockstep with
    where ECAPA actually runs. */
export function spkRunsOnGpu(): boolean {
  return (process.env.SPK_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}

export async function embedSegment(
  pcm: Buffer,
  sampleRate: number,
  opts: EmbedOptions = {},
): Promise<Float32Array> {
  if (pcm.length === 0) throw new Error('embedSegment: empty PCM buffer.');
  const url = (opts.sidecarUrl ?? getResolvedSidecarUrl()).replace(/\/+$/, '');

  // Sidecar op — VRAM arbitration now lives in the sidecar's capacity admission
  // (SEG_CAPACITY_ADMISSION); no Node-side GPU token here (see file header).
  let response: Response;
  try {
    response = (await undiciFetch(`${url}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'audio/L16', 'x-sample-rate': String(sampleRate) },
      body: pcm,
      signal: opts.signal,
      dispatcher: EMBED_DISPATCHER,
    })) as unknown as Response;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    const msg = (e as Error).message || String(e);
    throw Object.assign(
      new Error(`TTS sidecar not reachable at ${url} for /embed. (${msg})`),
      { transient: true as const },
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`TTS sidecar /embed returned ${response.status}: ${text.slice(0, 240)}`),
      { transient: response.status >= 500 && response.status < 600 },
    );
  }
  const body = (await response.json()) as { embedding: number[] };
  return Float32Array.from(body.embedding);
}
