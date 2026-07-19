/* HTTP client provider for the local TTS sidecar (server/tts-sidecar/).
   The sidecar is a separate Python FastAPI process the user starts with
   `npm run tts:sidecar`. We don't auto-spawn it — keeps the Node process
   light, lets the user choose CPU/GPU/quantised variants, and survives Node
   restarts.

   Wire protocol — POST {url}/synthesize:
     request:  application/json  { engine, model, voice, text }
     response: audio/L16;codec=pcm;rate=<sr>  raw 16-bit signed LE mono PCM,
               sample rate in the X-Sample-Rate header (or rate= in mimetype).

   TRUE batching (plan 112) — POST {url}/synthesize-batch (Qwen-only):
     request:  application/json  { engine, model, items: [{ voice, text }] }
     response: application/octet-stream  length-prefixed binary frame —
               `{"sampleRate":N,"lengths":[…]}\n<pcm0><pcm1>…` — one 16-bit LE
               mono PCM blob per item, sliced by `lengths`. */

import type {
  SynthesizeInput,
  SynthesizeOutput,
  SynthesizeBatchInput,
  SynthesizeBatchOutput,
  TtsProvider,
  TtsEngine,
} from './index.js';
import { fetch as undiciFetch, Agent } from 'undici';
import { sidecarModelId } from './model-keys.js';
import { CountSemaphore } from '../gpu/count-semaphore.js';
import { capacityProbe as defaultCapacityProbe, type CapacityProbe } from '../gpu/capacity-probe.js';
import {
  evictOllama as defaultEvictOllama,
  analyzerEvictWouldHelp as defaultAnalyzerEvictWouldHelp,
} from '../analyzer/ollama-residency.js';
import { getAnalyzerConcurrencyStats } from '../analyzer/analyzer-concurrency.js';
import { withCapacityRetry, getCapacityWaiterCount } from '../gpu/capacity-retry.js';
import { coquiLanguageCode } from './voice-mapping.js';

/* Re-exported from ../gpu/capacity-retry.ts (the no-capacity poll-wait counter
   moved there in Task 5, #1720) so server/src/routes/gpu-queue.ts's import
   from this module stays valid. */
export { getCapacityWaiterCount };

/* Per-engine serialisation: at most ONE synth call per engine in-flight at a
   time, mirroring the sidecar's own _synth_lock. Two same-engine calls
   racing to the sidecar would serialize on _synth_lock anyway but double
   transient memory in the meantime (accelerating the leak). This gate
   prevents that while still letting DIFFERENT engines (e.g. Kokoro narrator
   + Qwen dialogue) overlap freely. Capacity-aware placement (vram-aware
   placement, Task 8b) replaced the weighted cross-engine VRAM gate that used
   to sit alongside this one — admission is now the sidecar's job (it answers
   503 `{ noCapacity: true }` when an op can't fit), so this serializer no
   longer needs VRAM-cost weighting: a plain count of 1 is enough. */
const defaultEngineSynths = new Map<string, CountSemaphore>();

function engineSynthSem(map: Map<string, CountSemaphore>, engine: string): CountSemaphore {
  let sem = map.get(engine);
  if (!sem) {
    sem = new CountSemaphore(1);
    map.set(engine, sem);
  }
  return sem;
}

/* The no-capacity poll-wait constants (GPU_CAPACITY_POLL_MS /
   GPU_CAPACITY_MAX_ATTEMPTS), the parked-waiter counter, and the retry loop
   itself moved to ../gpu/capacity-retry.ts (Task 5, #1720) so both the synth
   path and the sidecar-load admission path share one policy. Per-provider
   overrides still flow through the SidecarOptions below into that helper. */

/* TTS synth legitimately runs for minutes — a wide Qwen batch (plan 136) can
   exceed 5 minutes of GPU decode, and the sidecar is NON-streaming so it holds
   the connection open computing the whole batch before sending any response
   headers. Node's global fetch inherits undici's default 300 s `headersTimeout`,
   which was aborting those long batches → `fetch failed` → the `post()` catch
   below wrapped it as a `transient` "not reachable" → the retry wrapper
   re-synthesised the same batch → loop → fatal "sidecar not running" while the
   sidecar kept grinding orphaned audio (plan 137). The only valid cancellation
   for a synth is the caller's AbortSignal, never a wall-clock timeout — so we
   disable headers/body timeouts (0 = unlimited). `connectTimeout` stays short so
   a genuinely-down sidecar still fails fast. We use undici's OWN `fetch` + this
   `Agent` (not the global fetch + a dispatcher) so the dispatcher is guaranteed
   to belong to the same undici instance. */
const SIDECAR_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});

interface SidecarOptions {
  url: string;
  engine: TtsEngine;
  /** Injected per-engine semaphore map — for testing only. Defaults to the
      module-level `defaultEngineSynths` singleton. */
  engineSynths?: Map<string, CountSemaphore>;
  /** Injected capacity probe — for testing only. Defaults to the shared
      `capacityProbe` singleton (server/src/gpu/capacity-probe.ts). */
  capacityProbe?: CapacityProbe;
  /** Injected Ollama-eviction action — for testing only. Defaults to
      `evictOllama` (server/src/analyzer/ollama-residency.ts). */
  evictOllama?: () => Promise<void>;
  /** Injected "would evicting Ollama free enough VRAM" check — for testing
      only. Defaults to `analyzerEvictWouldHelp`. */
  analyzerEvictWouldHelp?: (neededMb: number, freeOnDeviceMb: number) => Promise<boolean>;
  /** Injected "is the analyzer mid-run" check — for testing only. Defaults
      to reading `getAnalyzerConcurrencyStats().inFlight > 0`. */
  isAnalysisInFlight?: () => boolean;
  /** Injected poll interval (ms) between no-capacity admission retries —
      for testing only, so a test doesn't have to sleep the real default. */
  capacityPollMs?: number;
  /** Injected cap on no-capacity retry attempts before giving up with
      `NoCapacityError` — for testing only. */
  maxCapacityAttempts?: number;
}

export class SidecarTtsProvider implements TtsProvider {
  private readonly url: string;
  private readonly engine: TtsEngine;
  private readonly engineSynths: Map<string, CountSemaphore>;
  private readonly capacityProbe: CapacityProbe;
  private readonly evictOllama: () => Promise<void>;
  private readonly analyzerEvictWouldHelp: (neededMb: number, freeOnDeviceMb: number) => Promise<boolean>;
  private readonly isAnalysisInFlight: () => boolean;
  /* Left undefined unless injected — withCapacityRetry applies the
     GPU_CAPACITY_POLL_MS / GPU_CAPACITY_MAX_ATTEMPTS defaults. */
  private readonly capacityPollMs: number | undefined;
  private readonly maxCapacityAttempts: number | undefined;

  constructor(opts: SidecarOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.engine = opts.engine;
    this.engineSynths = opts.engineSynths ?? defaultEngineSynths;
    this.capacityProbe = opts.capacityProbe ?? defaultCapacityProbe;
    this.evictOllama = opts.evictOllama ?? defaultEvictOllama;
    this.analyzerEvictWouldHelp = opts.analyzerEvictWouldHelp ?? defaultAnalyzerEvictWouldHelp;
    this.isAnalysisInFlight =
      opts.isAnalysisInFlight ?? (() => getAnalyzerConcurrencyStats().inFlight > 0);
    this.capacityPollMs = opts.capacityPollMs;
    this.maxCapacityAttempts = opts.maxCapacityAttempts;
  }

  async synthesize({
    text,
    voiceName,
    modelKey,
    language,
    signal,
  }: SynthesizeInput): Promise<SynthesizeOutput> {
    /* fs-59 W4b — XTTS's own language table uses `zh-cn` where every other
       engine/the registry uses `zh` (Task 4b.0). Map ONLY at this
       sidecar-request boundary, and ONLY for the Coqui engine — the caller's
       `language` (and the shared `langCode` upstream that feeds
       `expandForSpeech`) must never see the mapped code. */
    const wireLanguage =
      language != null && this.engine === 'coqui' ? coquiLanguageCode(language) : language;
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      voice: voiceName,
      text,
      ...(wireLanguage != null ? { language: wireLanguage } : {}),
    });

    /* Per-engine serialisation — at most ONE synth call per engine in-flight.
       GPU admission itself is now the sidecar's job (capacity-aware
       placement): it answers 503 `{ noCapacity: true }` when an op can't
       fit, and `postWithCapacityRetry` below decides whether to nudge the
       analyzer out of the way or wait and retry. */
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      const response = await this.postWithCapacityRetry('/synthesize', body, signal);

      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length === 0) {
        throw new Error('Local voice engine returned an empty audio body.');
      }

      const mimeType = response.headers.get('content-type') ?? 'audio/L16;codec=pcm;rate=24000';
      const headerRate = response.headers.get('x-sample-rate');
      const sampleRate = headerRate ? Number(headerRate) : parseRateFromMime(mimeType);

      /* When the sidecar's speaker manifest doesn't contain the voice we
         asked for, it substitutes a safe fallback and tells us via this
         header. The synth still completed (so we don't fail the chapter),
         but the user's chapter ends up speaking in a different voice than
         the cast view shows. Log loudly so we can fix server/src/tts/
         voice-mapping.ts when this happens — the catalog and the model's
         actual speaker list have drifted. */
      const substitutedFrom = response.headers.get('x-voice-substituted-from');
      if (substitutedFrom) {
        console.warn(
          `[tts] Sidecar substituted voice: requested "${substitutedFrom}" not in XTTS v2 manifest. ` +
            `Update server/src/tts/voice-mapping.ts to remove this name. ` +
            `Run \`curl ${this.url}/speakers\` to see the model's actual speaker list.`,
        );
      }

      return {
        pcm: buf,
        sampleRate,
        mimeType,
        ...(substitutedFrom ? { voiceSubstitutedFrom: substitutedFrom } : {}),
      };
    } finally {
      releaseEngine();
    }
  }

  /* TRUE batching (plan 112) — synth N sentences in ONE sidecar call. Only
     reached for engines whose sidecar exposes /synthesize-batch (Qwen today);
     the dispatcher feature-detects this method and falls back to per-call
     `synthesize` otherwise. Forwards the abort signal so an in-flight batch
     cancels mid-call. */
  async synthesizeBatch({
    items,
    modelKey,
    liveInstruct,
    signal,
  }: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      /* fs-57 — batch-level liveInstruct flag; per-item instruct phrase when
         the gate is open. The sidecar substitutes NEUTRAL_INSTRUCT for items
         without an instruct on the liveInstruct path (PR2-Mi1). The single
         /synthesize body is unchanged (live instruct is batch-only, PR2-M3). */
      liveInstruct: liveInstruct ?? false,
      items: items.map((it) => ({
        voice: it.voiceName,
        text: it.text,
        ...(it.instruct != null ? { instruct: it.instruct } : {}),
        ...(it.emotion != null ? { emotion: it.emotion } : {}),
      })),
    });

    /* Per-engine serialisation — outer gate, same rationale as synthesize(). */
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      const response = await this.postWithCapacityRetry('/synthesize-batch', body, signal);

      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length === 0) {
        throw new Error('Local voice engine returned an empty batch body.');
      }

      const { sampleRate, pcms, genMs, audioMs } = parseBatchFrame(buf);
      /* Hard invariant — one PCM chunk per requested item. A mismatch means the
         sidecar demux drifted; fail loudly rather than scatter misaligned audio
         back onto the wrong sentences. */
      if (pcms.length !== items.length) {
        throw new Error(
          `Local TTS sidecar batch returned ${pcms.length} chunks for ${items.length} items.`,
        );
      }
      return { pcms, sampleRate, genMs, audioMs };
    } finally {
      releaseEngine();
    }
  }

  /* Shared POST: fetch + the network-error annotation both routes need.
     AbortError propagates unchanged (caller-driven stop); a connection failure
     becomes a transient "sidecar not reachable" the retry wrapper can absorb. */
  private async post(path: string, body: string, signal?: AbortSignal): Promise<Response> {
    try {
      /* Cast to the global `Response` type: at runtime Node's global fetch IS
         undici, so `globalThis.Response` and undici's exported `Response` are
         the same class — only their duplicated TS declarations (undici vs
         undici-types) differ, on `formData()` which we never call. */
      return (await undiciFetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
        dispatcher: SIDECAR_DISPATCHER,
      })) as unknown as Response;
    } catch (e) {
      /* AbortError is the caller cancelling on purpose — let it propagate so
         the outer handler can shut down cleanly instead of mistaking it for a
         sidecar-down failure. */
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      const msg = (e as Error).message || String(e);
      /* Node's fetch surfaces ECONNREFUSED as `fetch failed` with a cause.
         Give the user the one piece of info that actually unblocks them.
         Annotated `transient: true` so the auto-retry wrapper in
         `synthesise-chapter.ts` can absorb a brief network blip (e.g. the
         sidecar restarting after a CUDA poison) without wedging the queue. */
      throw Object.assign(
        new Error(
          `Local TTS sidecar not reachable at ${this.url}. Start it with \`npm run tts:sidecar\`. (${msg})`,
        ),
        { transient: true as const, cause: 'network' as const },
      );
    }
  }

  /* Capacity-aware admission (vram-aware placement, Task 8b) — thin wrapper over
     the shared `withCapacityRetry` helper (../gpu/capacity-retry.ts, Task 5).
     The helper retries a genuine no-capacity 503 (evict-once-then-bounded-poll)
     and RETURNS any other response untouched; this wrapper preserves the synth
     path's existing contract by running `throwForResponse` on a non-ok result,
     so poisoned/5xx/4xx keep their transient/poisoned classification for
     `withTtsRetry`. */
  private async postWithCapacityRetry(
    path: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await withCapacityRetry((s) => this.post(path, body, s), {
      engine: this.engine,
      signal,
      capacityProbe: this.capacityProbe,
      evictOllama: this.evictOllama,
      analyzerEvictWouldHelp: this.analyzerEvictWouldHelp,
      isAnalysisInFlight: this.isAnalysisInFlight,
      pollMs: this.capacityPollMs,
      maxAttempts: this.maxCapacityAttempts,
    });
    if (!response.ok) await throwForResponse(response);
    return response;
  }
}

/* Classify a non-ok sidecar response for the retry wrapper and throw.
   - `poisoned: true` body → the sidecar's CUDA context is corrupted for the
     lifetime of that process; only a restart fixes it. Retry would just replay
     the fast-fail 503 — surface immediately so the UI can render the "needs
     restart" banner.
   - Other 5xx → transient (503 during model load, 502 from a proxy mid-restart,
     504 from a hung connection) — recovers in ≤ 2.5 s of backoff.
   - 408 Request Timeout → transient.
   - 4xx other than 408 → client-side; retry won't help. */
async function throwForResponse(response: Response): Promise<never> {
  const bodyText = await safeReadText(response);
  const trimmed = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText;
  const poisoned = isPoisonedBody(bodyText);
  const transient =
    !poisoned && (response.status === 408 || (response.status >= 500 && response.status < 600));
  throw Object.assign(
    new Error(`Local voice engine returned ${response.status}: ${trimmed || response.statusText}`),
    { transient, status: response.status, poisoned },
  );
}

/* Parse the /synthesize-batch length-prefixed binary frame:
     {"sampleRate":N,"lengths":[…]}\n<pcm0><pcm1>…
   Split on the FIRST newline only — the JSON header is newline-free, so PCM
   payload bytes that happen to equal 0x0A (a valid 16-bit sample byte) are
   never mis-parsed. */
function parseBatchFrame(buf: Buffer): {
  sampleRate: number;
  pcms: Buffer[];
  genMs?: number;
  audioMs?: number;
} {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    throw new Error('Local TTS sidecar batch frame is missing its header terminator.');
  }
  let header: { sampleRate?: unknown; lengths?: unknown; genMs?: unknown; audioMs?: unknown };
  try {
    header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } catch {
    throw new Error('Local TTS sidecar batch frame had an unparseable header.');
  }
  const lengths = header.lengths;
  const sampleRate = Number(header.sampleRate);
  if (!Array.isArray(lengths) || !Number.isFinite(sampleRate)) {
    throw new Error('Local TTS sidecar batch frame header is missing sampleRate/lengths.');
  }
  /* Optional perf fields (plan 127 live per-batch RTF) — older sidecars omit
     them, so treat a non-finite value as "not reported". */
  const genMs = Number(header.genMs);
  const audioMs = Number(header.audioMs);

  const pcms: Buffer[] = [];
  let off = nl + 1;
  for (const len of lengths as number[]) {
    pcms.push(buf.subarray(off, off + len));
    off += len;
  }
  if (off !== buf.length) {
    throw new Error(
      `Local TTS sidecar batch frame body length mismatch (declared ${off - (nl + 1)} bytes, ` +
        `got ${buf.length - (nl + 1)}).`,
    );
  }
  return {
    sampleRate,
    pcms,
    genMs: Number.isFinite(genMs) ? genMs : undefined,
    audioMs: Number.isFinite(audioMs) ? audioMs : undefined,
  };
}

function parseRateFromMime(mime: string): number {
  const m = mime.match(/rate=(\d+)/);
  return m ? Number(m[1]) : 24000;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/* The sidecar returns `{ "detail": "...", "poisoned": true }` on the
   503 fast-fail fence after a CUDA device-side assert. That state is
   process-wide and only a sidecar restart clears it (see main.py's
   `_schedule_poison_exit`), so retrying just replays the fast-fail.
   Returns false on any parse failure — a malformed body errs on the
   side of "treat as transient" so the queue keeps trying. */
function isPoisonedBody(bodyText: string): boolean {
  if (!bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as { poisoned?: unknown };
    return parsed?.poisoned === true;
  } catch {
    return false;
  }
}
