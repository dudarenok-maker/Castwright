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

   VRAM arbitration follow-up: this is a sidecar op — VRAM arbitration now
   lives in the sidecar's capacity admission (behind SEG_CAPACITY_ADMISSION),
   not a Node-side GPU token here. Flag off: this runs in the normal sequential
   workflow (ASR happens in the QA phase, poolWidth=1 renders serialize),
   matching the whole feature's flag-off model. */

import { fetch as undiciFetch, Agent } from 'undici';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';
import { configValue } from '../config/resolver.js';

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
  /** fs-52 — per-word timestamps, present only when `wordTimestamps` was
      requested. `null` otherwise (including on a sidecar that predates the
      field). Chapter/clip-relative seconds, matching whatever PCM was sent. */
  words: Array<{ word: string; start: number; end: number }> | null;
}

export interface TranscribeOptions {
  /** Whisper language hint — non-English books MUST pass this or the WER is
      meaningless (Phase 6 threads bookLanguage here). */
  language?: string | null;
  signal?: AbortSignal;
  /** Override the sidecar URL (tests inject a fake). */
  sidecarUrl?: string;
  /** fs-52 — request per-word alignment from Whisper. Only the caption
      export path sets this; the QA gate never does. */
  wordTimestamps?: boolean;
}

/* Same long-call dispatcher rationale as sidecar.ts: a transcribe is short, but
   keep header/body timeouts unlimited so a busy sidecar never aborts mid-call;
   connectTimeout stays short so a down sidecar fails fast. */
const TRANSCRIBE_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});

/** True when ASR runs on the GPU. Resolved through `configValue('qa.asr.device')`
    (env -> override store -> registry default) rather than a raw
    `process.env.ASR_DEVICE` read, so a UI-set override in Advanced
    Configuration is actually seen — the two used to diverge whenever the
    knob was set from the UI rather than `.env` (#2178).

    This is correct because `WhisperEngine` has no self-demotion: unlike
    `SpeakerEngine` (which falls back cuda -> cpu on a load failure), a CUDA
    load failure in `_ensure_loaded` (main.py) propagates as an exception
    rather than degrading, so there is no live sidecar state this function
    could disagree with — configuration IS the truth for ASR device
    placement. If ASR ever gains self-demotion, this must switch to reading
    `/health`'s `asr_device` instead (which already reports the real,
    possibly-demoted device, `main.py`'s `_ensure_loaded`).

    The only window where the server's resolved value and the sidecar's
    actual device can genuinely disagree is between an override being saved
    and the sidecar restarting to pick it up (`qa.asr.device` is
    `apply: 'restart-sidecar'`, and the resolved value is injected into the
    child's env at every spawn via `buildSidecarEnv`) — out of scope here. */
export function asrRunsOnGpu(): boolean {
  return configValue<string>('qa.asr.device').trim().toLowerCase().startsWith('cuda');
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
  if (opts.wordTimestamps) headers['x-word-timestamps'] = '1';

  // Sidecar op — VRAM arbitration now lives in the sidecar's capacity admission
  // (SEG_CAPACITY_ADMISSION); no Node-side GPU token here (see file header).
  // Only wrap in the evict-and-retry helper when ASR actually runs on the
  // GPU — on CPU the sidecar never emits a noCapacity 503, so wrapping would
  // be pure overhead.
  const doFetch = (signal?: AbortSignal) =>
    undiciFetch(`${url}/transcribe`, {
      method: 'POST',
      headers,
      body: pcm,
      signal,
      dispatcher: TRANSCRIBE_DISPATCHER,
    }) as unknown as Promise<Response>;

  let response: Response;
  try {
    response = asrRunsOnGpu()
      ? await withCapacityRetry(doFetch, { engine: 'asr', signal: opts.signal })
      : await doFetch(opts.signal);
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    if (e instanceof NoCapacityError) throw e;
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
    words?: unknown;
  };
  return {
    text: typeof body.text === 'string' ? body.text : '',
    language: typeof body.language === 'string' ? body.language : null,
    avgLogprob: numOrNull(body.avg_logprob),
    noSpeechProb: numOrNull(body.no_speech_prob),
    compressionRatio: numOrNull(body.compression_ratio),
    words: Array.isArray(body.words) ? body.words.filter(isWellFormedWord) : null,
  };
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

/** fs-52 final-review fix — a malformed sidecar `words[]` entry (missing/
    non-numeric `start`/`end`, non-string `word`) would otherwise flow
    uncaught into `buildWordCues`'s NaN-sensitive timing comparisons. Drop
    malformed entries rather than trusting the `Array.isArray` cast blindly;
    a well-formed sidecar response is unaffected. */
function isWellFormedWord(w: unknown): w is { word: string; start: number; end: number } {
  return (
    typeof w === 'object' &&
    w !== null &&
    typeof (w as { word?: unknown }).word === 'string' &&
    typeof (w as { start?: unknown }).start === 'number' &&
    Number.isFinite((w as { start?: unknown }).start) &&
    typeof (w as { end?: unknown }).end === 'number' &&
    Number.isFinite((w as { end?: unknown }).end)
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
