/* Local Ollama analyzer. Header + OllamaTransport.send moved to
   transports/ollama-transport.ts (#3084 wave 1b). */

import { fetch as undiciFetch, Agent } from 'undici';
import { acquireAnalyzerSlot, describeAnalyzerConcurrency } from './analyzer-concurrency.js';
import { isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { OllamaTransport, ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
import { resolveNumPredict, resolveOllamaTemperature } from './ollama-settings.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { StageRunner, identitySchemaAdapter } from './runner/stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './runner/retry-policy.js';
export { AnalysisAbortedError, LocalUnreachableError } from './errors.js';
export { ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
export {
  resolveOllamaTemperature, resolveOllamaRetryTemperature,
  resolveKeepAliveSeconds, hasKeepAliveOverride, keepAliveFor,
  normalizeModelTag, resolveAnalyzerNumCtx, resolveAnalyzerNumGpu, resolveNumPredict,
  DEFAULT_TEMPERATURE, INVALID_JSON_RETRY_TEMPERATURE,
  ANALYZER_NUM_CTX, ANALYZER_NUM_GPU,
} from './ollama-settings.js';

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  console.log(describeAnalyzerConcurrency());
}

interface OllamaOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434).
      Trailing slash already stripped by getResolvedOllamaUrl. */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
  /** Injected undici dispatcher — for testing only. Defaults to the
      module-level ANALYZER_DISPATCHER singleton. */
  dispatcher?: Agent;
}

/* Absolute ceiling for a one-shot persona generation. Needed because
   ANALYZER_DISPATCHER removes undici's implicit 300s bound and this call site
   has no caller-supplied signal to fall back on; see the note in
   generatePersonaViaOllama. Deliberately generous: the whole point of the
   dispatcher is that a large model on CPU legitimately takes minutes. Mirrors
   DESIGN_ABSOLUTE_MAX_MS in tts/design-voice-core.ts. */
export const PERSONA_ABSOLUTE_MAX_MS = 600_000;

export class OllamaAnalyzer extends TransportAnalyzer {
  constructor(opts: OllamaOptions) {
    super(
      new StageRunner({
        transport: new OllamaTransport({ url: opts.url, model: opts.model, dispatcher: opts.dispatcher }),
        policy: OLLAMA_RETRY_POLICY,
        /* Structured output stays 'schema' (wave 3 resolves it from
           analyzer.ollama.structuredOutput); the output cap is num_predict,
           resolved per request. */
        settings: () => ({ structuredOutput: 'schema', maxOutputTokens: resolveNumPredict() }),
        adaptSchema: identitySchemaAdapter,
      }),
    );
  }
}

/** One-shot freeform Ollama call for persona generation. Unlike
    OllamaTransport.send() this sends NO response `format` (freeform text),
    does not stream, and is GPU-plan aware:
      - onCpu  → num_gpu:0 (system RAM only) AND skip the GPU semaphore
                 (a CPU call must not queue behind GPU synthesis).
      - !onCpu → acquire an analyzer GPU slot around the fetch.
      - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0
        for one-shot / CPU). */
export async function generatePersonaViaOllama(
  prompt: string,
  model: string,
  opts: {
    onCpu?: boolean;
    keepAlive?: string | number;
    signal?: AbortSignal;
    /** Override the absolute ceiling — for testing only, so the bound can be
        proven to fire without waiting out PERSONA_ABSOLUTE_MAX_MS. */
    absoluteMaxMs?: number;
  } = {},
): Promise<string> {
  const onCpu = opts.onCpu === true;
  const url = getResolvedOllamaUrl();
  const body = {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    stream: false,
    think: false,
    /* Pin during an active analysis run (same rationale as keepAliveFor); the
       caller-supplied keepAlive is the post-run idle window otherwise. */
    keep_alive: isAnyAnalyzerRunBusy() ? -1 : (opts.keepAlive ?? 0),
    options: {
      temperature: resolveOllamaTemperature(),
      ...(onCpu ? { num_gpu: 0 } : {}),
    },
  };

  /* ANALYZER_DISPATCHER disables undici's header/body timeouts, so SOMETHING
     else must bound this call — and unlike OllamaTransport.send() (whose request carries the
     analysis signal) and warmOllamaModel (which builds its own controller from
     warmTimeoutMs), nothing upstream of here supplies one: voice-style.ts
     passes only { onCpu, keepAlive }. Without this, a daemon wedged in the
     connected-but-never-responding state (mid-/api/pull, hung GPU driver — the
     listener stays up so connectTimeout never fires) would hang FOREVER, and
     because the analyzer slot above is released only in the finally below,
     it would leak a token from a bounded semaphore and silently block every
     later analyzer call. The hidden 300s cap used to be the only stop; removing
     it without replacing it would have traded a wrong diagnosis for a deadlock.
     Ceiling matches design-voice-core.ts's DESIGN_ABSOLUTE_MAX_MS — the same
     "a big local model on CPU is slow but not infinite" judgement. */
  const releaseSlot = await acquireAnalyzerSlot(model, onCpu);
  /* Start the clock AFTER the semaphore, not before: AbortSignal.timeout
     cannot be paused, so building it above the acquire charges FIFO queue
     time to the request. With K=2 held by two slow chapter calls, a persona
     request could exhaust its whole budget waiting and then reject without
     sending a byte — reported as a bare "operation was aborted due to
     timeout" naming neither daemon nor model, about an Ollama that never saw
     it. undici's implicit clock started at socket dispatch too, so this also
     keeps the replacement bound faithful to what it replaced. */
  try {
    /* Built INSIDE the try: AbortSignal.timeout/any can throw (ERR_OUT_OF_RANGE
       on a bad ceiling, TypeError on a non-signal), and the slot is already
       held by this point — anything that throws between the acquire and the
       try would leak it, which is the exact harm the regression test guards. */
    const maxMs =
      opts.absoluteMaxMs && opts.absoluteMaxMs > 0 ? opts.absoluteMaxMs : PERSONA_ABSOLUTE_MAX_MS;
    const budget = AbortSignal.timeout(maxMs);
    const signal = opts.signal ? AbortSignal.any([budget, opts.signal]) : budget;
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      /* Same ANALYZER_DISPATCHER as OllamaTransport.send(), and this call needs it MORE:
         `stream: false` above means Ollama withholds response headers until
         the ENTIRE generation is finished, so undici's 300s default would
         cover load + prefill + full decode rather than prefill alone. The
         CPU path (`num_gpu: 0`, set by voice-style.ts for persona
         generation) blows through that on any large local tag — and there is
         no Gemini fallback on this path, so the misclassified
         LocalUnreachableError below surfaces to the user as "Ollama is
         unreachable, start the daemon" about a daemon that is running fine
         and still generating. */
      response = await undiciFetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        dispatcher: ANALYZER_DISPATCHER,
      });
    } catch (err) {
      throw classifyConnectError(err, url);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json().catch(() => ({}))) as { message?: { content?: string } };
    return json.message?.content ?? '';
  } finally {
    releaseSlot(); // non-nullable (unlike the old acquireGpuTokenIfOnGpu release)
  }
}
