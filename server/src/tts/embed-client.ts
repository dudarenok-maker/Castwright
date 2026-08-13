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
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';
import { configValue } from '../config/resolver.js';

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

/** True when the embed runs on the GPU. Resolved through
    `configValue('qa.speaker.device')` (env -> override store -> registry
    default) rather than a raw `process.env.SPK_DEVICE` read, so a UI-set
    override in Advanced Configuration is actually seen — the two used to
    diverge whenever the knob was set from the UI rather than `.env` (#2178's
    defect, left unfixed for this gate until #2224; mirrors `asrRunsOnGpu`'s
    fix in `transcribe-client.ts`, same defect shape).

    One difference from `asrRunsOnGpu`, noted rather than solved here:
    `SpeakerEngine` DOES self-demote cuda -> cpu on a load failure (main.py,
    "SPK_DEVICE=cuda but no CUDA device — using cpu."), so a resolved 'cuda'
    can disagree with where ECAPA is ACTUALLY running after a demotion —
    unlike ASR, which has no such fallback. This is not a regression: a raw
    `process.env.SPK_DEVICE` read couldn't see the demotion either, so the
    window exists identically before and after this change. If `SpeakerEngine`
    ever surfaces its real device on `/health` the way ASR's docblock
    describes, this should switch to reading that instead. */
export function spkRunsOnGpu(): boolean {
  return configValue<string>('qa.speaker.device').trim().toLowerCase().startsWith('cuda');
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
  // Only wrap in the evict-and-retry helper when the embed actually runs on
  // the GPU — on CPU the sidecar never emits a noCapacity 503, so wrapping
  // would be pure overhead.
  const doFetch = (signal?: AbortSignal) =>
    undiciFetch(`${url}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'audio/L16', 'x-sample-rate': String(sampleRate) },
      body: pcm,
      signal,
      dispatcher: EMBED_DISPATCHER,
    }) as unknown as Promise<Response>;

  let response: Response;
  try {
    response = spkRunsOnGpu()
      ? await withCapacityRetry(doFetch, { engine: 'spk', signal: opts.signal })
      : await doFetch(opts.signal);
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    if (e instanceof NoCapacityError) throw e;
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
