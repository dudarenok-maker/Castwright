/* HTTP client provider for the local TTS sidecar (server/tts-sidecar/).
   The sidecar is a separate Python FastAPI process the user starts with
   `npm run tts:sidecar`. We don't auto-spawn it — keeps the Node process
   light, lets the user choose CPU/GPU/quantised variants, and survives Node
   restarts.

   Wire protocol — POST {url}/synthesize:
     request:  application/json  { engine, model, voice, text }
     response: audio/L16;codec=pcm;rate=<sr>  raw 16-bit signed LE mono PCM,
               sample rate in the X-Sample-Rate header (or rate= in mimetype). */

import type { SynthesizeInput, SynthesizeOutput, TtsProvider, TtsEngine } from './index.js';
import { sidecarModelId } from './index.js';

interface SidecarOptions {
  url: string;
  engine: TtsEngine;
}

export class SidecarTtsProvider implements TtsProvider {
  private readonly url: string;
  private readonly engine: TtsEngine;

  constructor(opts: SidecarOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.engine = opts.engine;
  }

  async synthesize({ text, voiceName, modelKey, signal }: SynthesizeInput): Promise<SynthesizeOutput> {
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      voice: voiceName,
      text,
    });

    let response: Response;
    try {
      response = await fetch(`${this.url}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (e) {
      /* AbortError is the caller cancelling on purpose — let it propagate so
         the outer handler can shut down cleanly instead of mistaking it for
         a sidecar-down failure. */
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      const msg = (e as Error).message || String(e);
      /* Node's fetch surfaces ECONNREFUSED as `fetch failed` with a cause.
         Give the user the one piece of info that actually unblocks them.
         Annotated `transient: true` so the auto-retry wrapper in
         `synthesise-chapter.ts` can absorb a brief network blip (e.g. the
         sidecar restarting after a CUDA poison) without wedging the queue.
         Genuine "sidecar isn't running" → all retries also fail with the
         same message, so the user-facing error text is unchanged. */
      throw Object.assign(
        new Error(
          `Local TTS sidecar not reachable at ${this.url}. Start it with \`npm run tts:sidecar\`. (${msg})`,
        ),
        { transient: true as const, cause: 'network' as const },
      );
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      const trimmed = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText;
      /* Classify for the retry wrapper.
         - `poisoned: true` body → the sidecar's CUDA context is corrupted
           for the lifetime of that process; only a restart fixes it. Retry
           would just replay the fast-fail 503 — surface immediately so the
           UI can render the "needs restart" banner.
         - Other 5xx → transient. The most common shape (503 during model
           load on first call, 502 from a reverse proxy mid-restart, 504
           from a hung connection) recovers in ≤ 2.5 s of backoff.
         - 408 Request Timeout → transient.
         - 4xx other than 408 → client-side; retry won't help. */
      const poisoned = isPoisonedBody(bodyText);
      const transient =
        !poisoned &&
        (response.status === 408 ||
          (response.status >= 500 && response.status < 600));
      throw Object.assign(
        new Error(`Local TTS sidecar returned ${response.status}: ${trimmed || response.statusText}`),
        { transient, status: response.status, poisoned },
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) {
      throw new Error('Local TTS sidecar returned an empty audio body.');
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

    return { pcm: buf, sampleRate, mimeType };
  }
}

function parseRateFromMime(mime: string): number {
  const m = mime.match(/rate=(\d+)/);
  return m ? Number(m[1]) : 24000;
}

async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
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
