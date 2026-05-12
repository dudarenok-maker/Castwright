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

  async synthesize({ text, voiceName, modelKey }: SynthesizeInput): Promise<SynthesizeOutput> {
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
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      /* Node's fetch surfaces ECONNREFUSED as `fetch failed` with a cause.
         Give the user the one piece of info that actually unblocks them. */
      throw new Error(
        `Local TTS sidecar not reachable at ${this.url}. Start it with \`npm run tts:sidecar\`. (${msg})`,
      );
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      const trimmed = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText;
      throw new Error(`Local TTS sidecar returned ${response.status}: ${trimmed || response.statusText}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) {
      throw new Error('Local TTS sidecar returned an empty audio body.');
    }

    const mimeType = response.headers.get('content-type') ?? 'audio/L16;codec=pcm;rate=24000';
    const headerRate = response.headers.get('x-sample-rate');
    const sampleRate = headerRate ? Number(headerRate) : parseRateFromMime(mimeType);

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
