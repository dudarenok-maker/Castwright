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
import { gpuSemaphore, GpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from './engine-vram-cost.js';

/* Per-engine serialisation: at most ONE synth call per engine in-flight at a
   time, mirroring the sidecar's own _synth_lock.  With a VRAM budget > 1, two
   same-engine calls can both pass the global semaphore and race to the sidecar
   — where they serialize on _synth_lock but double transient memory (accelerating
   the leak).  This gate prevents that while still letting DIFFERENT engines
   (e.g. Kokoro narrator + Qwen dialogue) overlap freely. */
const defaultEngineSynths = new Map<string, GpuSemaphore>();

function engineSynthSem(map: Map<string, GpuSemaphore>, engine: string): GpuSemaphore {
  let sem = map.get(engine);
  if (!sem) {
    sem = new GpuSemaphore(1);
    map.set(engine, sem);
  }
  return sem;
}

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
  engineSynths?: Map<string, GpuSemaphore>;
  /** Injected global VRAM semaphore — for testing only. Defaults to the
      module-level `gpuSemaphore` singleton. */
  gpuSem?: GpuSemaphore;
}

export class SidecarTtsProvider implements TtsProvider {
  private readonly url: string;
  private readonly engine: TtsEngine;
  private readonly engineSynths: Map<string, GpuSemaphore>;
  private readonly gpuSem: GpuSemaphore;

  constructor(opts: SidecarOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.engine = opts.engine;
    this.engineSynths = opts.engineSynths ?? defaultEngineSynths;
    this.gpuSem = opts.gpuSem ?? gpuSemaphore;
  }

  async synthesize({
    text,
    voiceName,
    modelKey,
    signal,
  }: SynthesizeInput): Promise<SynthesizeOutput> {
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      voice: voiceName,
      text,
    });

    /* Per-engine serialisation — at most ONE synth call per engine in-flight.
       Acquired BEFORE the global GPU semaphore (outer-before-inner) to avoid
       priority inversion: if the per-engine gate were inner, a waiting
       same-engine call could hold a global token while blocked, starving
       unrelated engines. */
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      /* GPU arbitration — acquire a slot before the fetch so the synth
         doesn't race the analyzer (or another concurrent synth) for VRAM
         on an 8 GB GPU. Held across the buffered arrayBuffer() read
         below; the sidecar response is NOT streaming, so a single
         release after the read covers the whole GPU op. Cost is the engine's
         VRAM weight (engine-vram-cost.ts) so a heavy engine takes more of the
         budget than a light one. See server/src/gpu/semaphore.ts. */
      const releaseGpu = await this.gpuSem.acquire(costForEngine(this.engine));

      try {
        const response = await this.post('/synthesize', body, signal);
        if (!response.ok) await throwForResponse(response);

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
        releaseGpu();
      }
    } finally {
      releaseEngine();
    }
  }

  /* TRUE batching (plan 112) — synth N sentences in ONE sidecar call. Only
     reached for engines whose sidecar exposes /synthesize-batch (Qwen today);
     the dispatcher feature-detects this method and falls back to per-call
     `synthesize` otherwise. Acquires ONE GPU token for the whole batch (it's a
     single model forward, same VRAM lifetime as a single call) and forwards
     the abort signal so an in-flight batch cancels mid-call. */
  async synthesizeBatch({
    items,
    modelKey,
    signal,
  }: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      items: items.map((it) => ({ voice: it.voiceName, text: it.text })),
    });

    /* Per-engine serialisation — outer gate, same rationale as synthesize(). */
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      const releaseGpu = await this.gpuSem.acquire(costForEngine(this.engine));
      try {
        const response = await this.post('/synthesize-batch', body, signal);
        if (!response.ok) await throwForResponse(response);

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
        releaseGpu();
      }
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
