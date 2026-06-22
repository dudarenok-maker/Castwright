/* HTTP client for the TTS sidecar's `/embed` endpoint (srv-36 render-integrity).

   Posts raw PCM to the sidecar's ECAPA embedding model and returns a 192-d
   vector for render-integrity QA checks.

   Wire protocol — POST {url}/embed:
     request:  audio/L16  raw 16-bit signed LE mono PCM (the bytes /synthesize
               emits), `X-Sample-Rate` header (required).
     response: application/json  { embedding: number[], dim: 192, sample_rate }

   VRAM arbitration (srv-47): ONLY when the embed runs on the GPU
   (`SPK_DEVICE=cuda`) does this acquire a weighted GPU token (cost `spk`,
   engine-vram-cost.ts) so ECAPA + synth stay within the budget. The CPU-default
   path (`SPK_DEVICE=cpu`) costs zero VRAM, so taking a token would needlessly
   serialise it behind synth — we skip the semaphore there. */

import { fetch as undiciFetch, Agent } from 'undici';
import { gpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from './engine-vram-cost.js';
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

/** True when the embed runs on the GPU and must arbitrate for VRAM. Reads the
    SAME `SPK_DEVICE` env the sidecar reads (shared env under `npm start`), so it
    stays in lockstep with where ECAPA actually runs. */
export function spkRunsOnGpu(): boolean {
  return (process.env.SPK_DEVICE ?? 'cpu').trim().toLowerCase() === 'cuda';
}

/* R2-A guard: at the default budget of 1, an spk token consumes the whole
   budget and the cuda embed serialises behind synth — likely slower than the
   free, parallel cpu embed. Warn ONCE so a misconfiguration is visible without
   changing behaviour. */
let budgetWarned = false;
function warnIfBudgetTooLow(): void {
  if (budgetWarned || gpuSemaphore.budget >= 2) return;
  budgetWarned = true;
  console.warn(
    'SPK_DEVICE=cuda but GPU budget < 2: the speaker embed will serialise ' +
      'behind synth and may be slower than the free cpu path; set ' +
      'GPU_VRAM_BUDGET >= 2.',
  );
}

export async function embedSegment(
  pcm: Buffer,
  sampleRate: number,
  opts: EmbedOptions = {},
): Promise<Float32Array> {
  if (pcm.length === 0) throw new Error('embedSegment: empty PCM buffer.');
  const url = (opts.sidecarUrl ?? getResolvedSidecarUrl()).replace(/\/+$/, '');

  const onGpu = spkRunsOnGpu();
  if (onGpu) warnIfBudgetTooLow();
  const release = onGpu ? await gpuSemaphore.acquire(costForEngine('spk')) : null;
  try {
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
  } finally {
    release?.();
  }
}
