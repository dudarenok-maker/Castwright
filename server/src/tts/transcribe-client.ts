/* HTTP client for the TTS sidecar's ASR `/transcribe` endpoint (srv-31).

   The server owns the QA POLICY (word-error-rate, thresholds, re-record) in
   `segment-asr-qa.ts`; this module is only the thin transport: ship one
   sentence's PCM to the sidecar's Whisper model and return the transcript +
   Whisper's intrinsic signals.

   Wire protocol — POST {url}/transcribe:
     request:  audio/L16  raw 16-bit signed LE mono PCM (the bytes /synthesize
               emits), `X-Sample-Rate` header (required), optional `X-Language`.
     response: application/json
               { text, language, avg_logprob, no_speech_prob, compression_ratio }

   VRAM arbitration: ONLY when ASR runs on the GPU (`ASR_DEVICE=cuda`) does this
   acquire a weighted GPU token (cost `asr`, engine-vram-cost.ts) so Whisper +
   synth stay within the budget. The CPU-default path (`ASR_DEVICE=cpu`) costs
   zero VRAM, so taking a token would needlessly serialise it behind synth —
   we skip the semaphore entirely there. */

import { fetch as undiciFetch, Agent } from 'undici';
import { gpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from './engine-vram-cost.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export interface TranscribeResult {
  text: string;
  language: string | null;
  /** Whisper intrinsic signals — the server's cheap hallucination/loop tells.
     Lower avgLogprob = less confident; higher noSpeechProb = more likely
     silence; higher compressionRatio = repetition/loop. May be null when the
     model returned no segments. */
  avgLogprob: number | null;
  noSpeechProb: number | null;
  compressionRatio: number | null;
}

export interface TranscribeOptions {
  /** Whisper language hint — non-English books MUST pass this or the WER is
      meaningless (Phase 6 threads bookLanguage here). */
  language?: string | null;
  signal?: AbortSignal;
  /** Override the sidecar URL (tests inject a fake). */
  sidecarUrl?: string;
}

/* Same long-call dispatcher rationale as sidecar.ts: a transcribe is short, but
   keep header/body timeouts unlimited so a busy sidecar never aborts mid-call;
   connectTimeout stays short so a down sidecar fails fast. */
const TRANSCRIBE_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});

/** True when ASR runs on the GPU and must arbitrate for VRAM. The server reads
    the SAME `ASR_DEVICE` env the sidecar process reads (they share the env under
    `npm start`), so this stays in lockstep with where Whisper actually runs. */
export function asrRunsOnGpu(): boolean {
  return (process.env.ASR_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}

export async function transcribeSegment(
  pcm: Buffer,
  sampleRate: number,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  if (pcm.length === 0) throw new Error('transcribeSegment: empty PCM buffer.');
  const url = (opts.sidecarUrl ?? getResolvedSidecarUrl()).replace(/\/+$/, '');

  const headers: Record<string, string> = {
    'content-type': 'audio/L16',
    'x-sample-rate': String(sampleRate),
  };
  const lang = normalizeWhisperLanguage(opts.language);
  if (lang) headers['x-language'] = lang;

  const release = asrRunsOnGpu() ? await gpuSemaphore.acquire(costForEngine('asr')) : null;
  try {
    let response: Response;
    try {
      response = (await undiciFetch(`${url}/transcribe`, {
        method: 'POST',
        headers,
        body: pcm,
        signal: opts.signal,
        dispatcher: TRANSCRIBE_DISPATCHER,
      })) as unknown as Response;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      const msg = (e as Error).message || String(e);
      throw Object.assign(
        new Error(`TTS sidecar not reachable at ${url} for /transcribe. (${msg})`),
        { transient: true as const },
      );
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw Object.assign(
        new Error(`TTS sidecar /transcribe returned ${response.status}: ${text.slice(0, 240)}`),
        { transient: response.status >= 500 && response.status < 600 },
      );
    }
    const body = (await response.json()) as {
      text?: unknown;
      language?: unknown;
      avg_logprob?: unknown;
      no_speech_prob?: unknown;
      compression_ratio?: unknown;
    };
    return {
      text: typeof body.text === 'string' ? body.text : '',
      language: typeof body.language === 'string' ? body.language : null,
      avgLogprob: numOrNull(body.avg_logprob),
      noSpeechProb: numOrNull(body.no_speech_prob),
      compressionRatio: numOrNull(body.compression_ratio),
    };
  } finally {
    release?.();
  }
}

/** Normalise a BCP-47-ish tag to the base language subtag Whisper expects
    ("en-US" → "en", "ru" → "ru"). Anything that isn't a 2–3-letter code returns
    undefined → let Whisper auto-detect rather than pass an unsupported value. */
export function normalizeWhisperLanguage(lang?: string | null): string | undefined {
  if (!lang) return undefined;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
