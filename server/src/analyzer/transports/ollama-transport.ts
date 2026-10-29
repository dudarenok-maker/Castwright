/* Local Ollama analyzer. Mirrors GeminiAnalyzer's streaming + validation-retry
   shape (see gemini.ts) but talks to a local Ollama daemon over plain HTTP
   instead of the Google SDK.

   The key novelty is the error classification: only "couldn't connect" /
   "connection reset before first byte" failures translate into
   LocalUnreachableError — one case of AnalyzerUnreachableError, the type the
   FallbackAnalyzer in index.ts keys on to retry against Gemini. Everything
   else hard-fails: an HTTP non-2xx response surfaces as AnalyzerHttpError
   (errors.ts), which deliberately does NOT extend AnalyzerUnreachableError,
   and validation failures, stream failures and client aborts surface as
   ordinary Errors (aborts as AnalysisAbortedError). The point: a misbehaving
   local model should not silently burn Gemini quota; if Ollama is up at all,
   we trust the error.

   That classification is only sound if the fetch itself never invents a
   failure. Node's global fetch (undici) defaults `headersTimeout` to 300s,
   and Ollama withholds response headers until the FIRST generated token —
   so on a big prompt the whole prefill counts against that budget. A busy
   but perfectly healthy daemon therefore dies at exactly 302s with a bare
   `TypeError: fetch failed`, which classifyConnectError below reads as
   "unreachable" — the one condition that reroutes to the fallback target.
   So whenever a usable target is configured (analyzer.fallback.target,
   resolved by selectAnalyzer in index.ts — Gemini by default, needing its
   key), a slow local call silently completes there, which is precisely what
   the paragraph above says must not happen; with the target off or unusable
   it instead hard-fails with a wrong diagnosis
   ("start the daemon") about a daemon that is running fine. Observed
   2026-08-12: two chapters of a 103k-word book failed cast detection this
   way, both at 302s.

   Hence ANALYZER_DISPATCHER: unlimited header/body timeouts so a busy
   daemon never aborts mid-call, with a short connectTimeout so a genuinely
   down daemon still fails fast and still reaches the fallback. Same shape
   and same rationale as tts/sidecar.ts and tts/embed-client.ts. */
import { fetch as undiciFetch, Agent } from 'undici';
import { sampleAndRecordVram } from '../model-vram-stats.js';
import { acquireAnalyzerSlot } from '../analyzer-concurrency.js';
import { getLastKnownAnalyzerDevice } from '../../gpu/analyzer-device-state.js';
import { detectOllamaGpuSplit } from '../../gpu/ollama-gpu-split.js';
import { configValue } from '../../config/resolver.js';
import { getLastKnownVram } from '../../gpu/vram-state.js';
import type { RawEvalTiming } from '../analyzer-eval-stats.js';
import { AnalysisAbortedError, LocalUnreachableError, AnalyzerHttpError, AnalyzerTimeoutError } from '../errors.js';
import { redactKnownSecrets } from '../redact.js';
import { reasoningWireFragment } from '../reasoning.js';
import { mergeExtraParams, payloadSecretValues } from '../runner/extra-params.js';
/* #3084 A9 — through the leaf gate: no import edge to workspace/user-settings.ts. */
import { loadKnownAnalyzerSecrets } from '../known-secrets-gate.js';
import { keepAliveFor, resolveAnalyzerNumCtx, resolveAnalyzerNumGpu, resolveNumPredict } from '../ollama-settings.js';
import { isAnyAnalyzerRunBusy } from '../../tts/design-lock.js';
import { PERSONA_ABSOLUTE_MAX_MS } from '../runner/transport.js';
import type {
  ChatTransport,
  FreeTextOptions,
  StructuredOutputRequest,
  TransportRequest,
  TransportResult,
} from '../runner/transport.js';

/* The persona ceiling lives in runner/transport.ts (#3084 W4, owner decision 4.3-B1); re-exported
   so ollama.ts can pass it on to voice-style.ts. */
export { PERSONA_ABSOLUTE_MAX_MS };

/* Long-call dispatcher — see the header note. `headersTimeout: 0` is the
   load-bearing field: Ollama sends no response headers until the first
   generated token, so prefill on a large prompt otherwise races undici's
   300s default. `bodyTimeout: 0` covers a long inter-token stall on a
   loaded GPU. `connectTimeout` stays short so a down daemon still fails
   fast into LocalUnreachableError, preserving the fallback path.
   Exported for the regression test, which injects a deliberately tiny
   `headersTimeout` to prove the dispatcher is actually wired into the
   fetch — a bare global fetch ignores it. */
export const ANALYZER_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});

/* Network-failure error codes that Node's undici fetch surfaces via
   `err.cause.code`. These are the "couldn't connect" cases that warrant
   fallback to Gemini. Anything else (HTTP 5xx, malformed body, validation
   failure) means the daemon is reachable but misbehaving — hard-fail. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'UND_ERR_SOCKET',
]);

/* srv-2367: device-signature ("0,1") of every GPU split already warned about
   this run, so the warning fires once per distinct split rather than once
   per chat() call (Stage 1/2 call chat() per chapter — dozens of times per
   book). A full server restart clears this naturally; no TTL needed. */
const warnedGpuSplitSignatures = new Set<string>();

export interface OllamaTransportOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434). */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
  /** Injected undici dispatcher — for testing only. Defaults to the
      module-level ANALYZER_DISPATCHER singleton. */
  dispatcher?: Agent;
}

/** #3084 spec §2 — the Ollama `format` field per mode; `undefined` omits the key. */
export function ollamaFormatField(so: StructuredOutputRequest): unknown {
  if (so.mode === 'schema') return so.schema;
  if (so.mode === 'json') return 'json';
  return undefined;
}

export class OllamaTransport implements ChatTransport {
  readonly kind = 'ollama' as const;
  readonly model: string;
  private readonly url: string;
  private readonly dispatcher: Agent;

  constructor(opts: OllamaTransportOptions) {
    this.url = opts.url;
    this.model = opts.model;
    this.dispatcher = opts.dispatcher ?? ANALYZER_DISPATCHER;
  }

  /** #3084 W4 — the free-text path (spec §10): one NON-streaming /api/chat call with no response
      `format`, GPU-plan aware. Moved from the former ollama.ts persona function (main 80be2f1d).
        - onCpu  → num_gpu:0 (system RAM only); the analyzer slot is still taken with onCpu=true.
        - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0 for one-shot / CPU). */
  private async sendFreeText(req: TransportRequest, freeText: FreeTextOptions): Promise<TransportResult> {
    const onCpu = freeText.onCpu === true;
    const url = this.url; // CHANGED: was getResolvedOllamaUrl() — voice-style.ts resolves it into the analyzer
    const body: Record<string, unknown> = {
      model: this.model, // CHANGED: was the `model` parameter
      /* CHANGED: was [{ role: 'user', content: prompt }]. A persona passes system '' and one user
         turn, so the wire is identical. */
      messages: [
        ...(req.system !== '' ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages,
      ],
      stream: false,
      /* Pin during an active analysis run (same rationale as keepAliveFor); the
         caller-supplied keepAlive is the post-run idle window otherwise. */
      keep_alive: isAnyAnalyzerRunBusy() ? -1 : (freeText.keepAlive ?? 0), // CHANGED: opts → freeText
      options: {
        temperature: req.temperature, // CHANGED: was resolveOllamaTemperature(); voice-style.ts passes that value
        ...(onCpu ? { num_gpu: 0 } : {}),
      },
    };
    /* #3084 wave 5 — reasoning. `undefined` = a caller that sends no level; no
       production caller does now (the stage runner and the Test action's probe
       steps both send one), so this is the legacy default for any direct
       transport.send that omits it: keep today's think:false
       (qwen3.5's <think> tokens break the parser; Ollama accepts false on
       non-thinking models). A defined level sends exactly its fragment;
       'model-default' sends no `think` at all. */
    if (req.reasoning === undefined) {
      body.think = false;
    } else {
      Object.assign(body, reasoningWireFragment('ollama', { model: this.model }, req.reasoning));
    }
    /* #3084 wave 5b — the custom payload is merged LAST; built once here, outside any slot-acquire window. */
    const wireBody = mergeExtraParams('ollama', body as Record<string, unknown>, req.extraParams);

    /* ANALYZER_DISPATCHER disables undici's header/body timeouts, so SOMETHING
       else must bound this call — and unlike chat() (whose StageCall carries the
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
    const releaseSlot = await acquireAnalyzerSlot(this.model, onCpu); // CHANGED: model → this.model
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
        freeText.absoluteMaxMs && freeText.absoluteMaxMs > 0 ? freeText.absoluteMaxMs : PERSONA_ABSOLUTE_MAX_MS; // CHANGED: opts → freeText
      const budget = AbortSignal.timeout(maxMs);
      const startedAt = Date.now();
      const signal = req.signal ? AbortSignal.any([budget, req.signal]) : budget; // CHANGED: opts.signal → req.signal
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        /* Same ANALYZER_DISPATCHER as chat(), and this call needs it MORE:
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
          body: JSON.stringify(wireBody),
          signal,
          dispatcher: this.dispatcher, // CHANGED: the field is non-optional (defaulted to ANALYZER_DISPATCHER in the constructor), so the injected test dispatcher is honoured, like send()
        });
      } catch (err) {
        /* CHANGED: the design job's abort signal now reaches this call (req.signal, #3084 W4). A pause
           aborts the fetch before the first byte; report the clean stop it is, as send()'s streaming
           body does, never an unreachable daemon. A budget timeout (no caller abort) classifies as before. */
        if (req.signal?.aborted) {
          throw new AnalysisAbortedError(`Ollama ${this.model} persona call aborted (paused or client disconnected).`);
        }
        /* The budget fired and the caller did not: the daemon is connected but silent, so say so with
           the typed timeout the design pre-pass halts on (a bare TimeoutError DOMException matched
           nothing, so every character waited out the full ceiling and then failed as 'unknown'). */
        if (budget.aborted) {
          throw new AnalyzerTimeoutError('ollama', this.model, Date.now() - startedAt, 'ceiling');
        }
        throw classifyConnectError(err, url);
      }
      if (!response.ok) {
        /* CHANGED: typed per spec §1 (was a plain Error, and the excerpt local was `excerpt`). The redaction
           is PR 3b's (W3b Task 3b.6a), carried through the move, plus this request's own custom-payload values
           (#3084 P29): every known analyzer secret and every payload string value is removed BEFORE the body
           is sliced (P22). With neither in the body the message text is byte-identical to main's. */
        const text = await response.text().catch(() => '');
        const bodyExcerpt = redactKnownSecrets(text, [...(await loadKnownAnalyzerSecrets()), ...payloadSecretValues(req.extraParams)]).slice(0, 500);
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          bodyExcerpt,
          `Ollama ${url} returned ${response.status} ${response.statusText}: ${bodyExcerpt}`,
        );
      }
      /* CHANGED: also reads done_reason and message.thinking, so runFreeText can tell a length stop
         that only reasoned apart from an empty answer. */
      const json = (await response.json().catch(() => {
        /* The budget or a caller abort can fire AFTER the headers, while the body is still being read.
           Swallowing that into {} reads as an empty persona; report the typed stop, as the fetch phase
           does. A malformed body with neither fired keeps the old empty result. */
        if (req.signal?.aborted) {
          throw new AnalysisAbortedError(`Ollama ${this.model} persona call aborted (paused or client disconnected).`);
        }
        if (budget.aborted) {
          throw new AnalyzerTimeoutError('ollama', this.model, Date.now() - startedAt, 'ceiling');
        }
        return {};
      })) as {
        message?: { content?: string; thinking?: string };
        done_reason?: string;
      };
      const text = json.message?.content ?? '';
      return {
        text,
        reasoningSeen: typeof json.message?.thinking === 'string' && json.message.thinking.length > 0,
        finish: json.done_reason === 'length' ? 'length' : 'stop',
        receivedBytes: text.length,
      };
    } finally {
      releaseSlot(); // non-nullable (unlike the old acquireGpuTokenIfOnGpu release)
    }
  }

  /* Streamed chat against /api/chat. Mirrors GeminiAnalyzer.generate so the
     route-layer 45s silence watchdog (analysis.ts) keeps working unchanged —
     each NDJSON line fires onChunk with the assembled buffer.
     When the caller passes an AbortSignal, it's wired into both the initial
     fetch and the stream-read loop. If the signal fires we throw an
     AnalysisAbortedError so the route can distinguish "client went away,
     drop work silently" from a real model failure. */
  async send(req: TransportRequest): Promise<TransportResult> {
    if (req.freeText) return this.sendFreeText(req, req.freeText);
    const onChunk = req.call.onChunk;
    const onEvalTiming = req.call.onEvalTiming;
    const signal = req.signal;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.system ? [{ role: 'system' as const, content: req.system }, ...req.messages] : req.messages,
      stream: true,
      /* Strict structured output via Ollama 0.5+ constrained decoding. The
         schema is derived from the per-stage Zod schema (see runStage); the
         sampler can only emit tokens that keep the output a valid prefix of
         a value matching this schema. This eliminates the "malformed JSON
         at byte N" failure mode on smaller models (qwen3.5:4b in
         particular) — the model literally cannot produce invalid JSON or
         extra fields. The existing validation-retry loop below still guards
         against semantic violations the schema can't express. */
      format: ollamaFormatField(req.structuredOutput),
      /* Per-model keep_alive — see keepAliveFor + resolveKeepAliveSeconds
         above; a user override in analyzerKeepAliveByModel wins over the flat
         DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS fallback. */
      keep_alive: keepAliveFor(this.model, getLastKnownVram().accelerator),
      options: {
        /*Caller-controlled temperature — DEFAULT_TEMPERATURE for the first
           attempt and schema-validation retries, INVALID_JSON_RETRY_TEMPERATURE
           for invalid-json retries. See runStage for the kind-aware branch. */
        temperature: req.temperature,
        /* 16K covers long chapters (~12–15K chars ≈ 3–4K tokens) plus the
           inlined response schema + skill system prompt without spilling.
           At 8K we observed silent hangs on 12K+ char chapters where the
           combined prompt brushed the context limit and Ollama's
           structured-output path stalled with no first byte. The 4B
           weights (~3 GB) leave enough headroom on an 8 GB box for the
           larger KV cache. */
        num_ctx: resolveAnalyzerNumCtx(),
        /* Pin every layer to GPU — see ANALYZER_NUM_GPU above for the
           full rationale (was: Ollama silently offloading ~8% of
           llama3.1:8b layers to CPU under 16K-context pressure). */
        num_gpu: resolveAnalyzerNumGpu(),
        /* Output-token cap — see resolveNumPredict above. -1 by default
           (predict until context fills); truncation is caught loudly via
           done_reason below regardless. */
        num_predict: req.maxOutputTokens ?? resolveNumPredict(),
      },
    };
    /* #3084 wave 5 — reasoning: same rule as the free-text body above. */
    if (req.reasoning === undefined) {
      body.think = false;
    } else {
      Object.assign(body, reasoningWireFragment('ollama', { model: this.model }, req.reasoning));
    }
    /* #3084 wave 5b — the custom payload is merged LAST (same rule as the free-text body above). */
    const wireBody = mergeExtraParams('ollama', body as Record<string, unknown>, req.extraParams);

    /* Short-circuit if the caller has already aborted (e.g. the SSE client
       disconnected while a previous chapter was still running). Saves a
       wasted Ollama round-trip and lets the route loop bail immediately. */
    if (signal?.aborted) {
      throw new AnalysisAbortedError(
        `Ollama ${this.model} call aborted before fetch (client disconnected).`,
      );
    }

    /* Analyzer concurrency: width-K limiter + per-model GPU lease
       (analyzer-concurrency.ts). Replaces the old per-call gpuSemaphore acquire;
       the lease holds one cross-engine slot per resident model. */
    const releaseSlot = await acquireAnalyzerSlot(this.model, getLastKnownAnalyzerDevice() === 'cpu');

    try {
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(`${this.url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(wireBody),
          signal,
          dispatcher: this.dispatcher,
        });
      } catch (err) {
        if (signal?.aborted) {
          throw new AnalysisAbortedError(
            `Ollama ${this.model} fetch aborted (client disconnected).`,
          );
        }
        throw classifyConnectError(err, this.url);
      }

      if (!response.ok) {
        /* Reachable but errored — hard-fail. Surface the body so the operator can
           diagnose ("model not found", "invalid format", …), with every known
           analyzer secret AND this request's custom-payload string values removed
           where the error is built (#3084 P22, P29). Redacted BEFORE truncating, so
           a value the slice would cut in half cannot survive. With neither in the
           body the text is byte-identical. */
        const text = await response.text().catch(() => '');
        const bodyExcerpt = redactKnownSecrets(text, [...(await loadKnownAnalyzerSecrets()), ...payloadSecretValues(req.extraParams)]).slice(0, 500);
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          bodyExcerpt,
          `Ollama ${this.url} returned ${response.status} ${response.statusText}: ${bodyExcerpt}`,
        );
      }

      if (!response.body) {
        throw new Error(`Ollama ${this.url} returned an empty body (no readable stream).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = ''; // assembled assistant content
      /* #3084 wave 2 — reasoning evidence for mapFinish: any non-empty
         message.thinking chunk (a thinking model, or one ignoring think:false). */
      let reasoningSeen = false;
      let lineBuf = ''; // partial NDJSON line carried across reads
      let firstByteSeen = false;
      /* Ollama reports WHY it stopped on the final `done:true` line:
         'stop' (clean), 'length' (hit num_ctx/num_predict — truncated),
         'load'. Captured here, asserted after the stream drains (#528). */
      let doneReason: string | undefined;
      /* Raw decode timing off the `done:true` line — see analyzer-eval-stats.ts.
         Fired via onEvalTiming after the stream drains (best-effort telemetry,
         gated by the analyzer.evalStats.enabled knob below). */
      let timing: RawEvalTiming | null = null;
      const start = Date.now();
      let lastChunkAt = start;

      try {
        for (;;) {
          if (signal?.aborted) {
            /* Caller (the route's req.on('close') handler) aborted while we
               were mid-stream. Tear down cleanly rather than burning more
               tokens on output the client will never see. */
            throw new AnalysisAbortedError(
              `Ollama ${this.model} stream aborted (client disconnected).`,
            );
          }
          let result: { done: boolean; value?: Uint8Array };
          try {
            result = await reader.read();
          } catch (err) {
            if (signal?.aborted) {
              throw new AnalysisAbortedError(
                `Ollama ${this.model} stream aborted (client disconnected).`,
              );
            }
            /* A connection drop mid-stream — daemon was up, then went away.
               If we've already seen bytes, this is a partial-stream failure
               (hard-fail). If we haven't, treat as unreachable. */
            if (!firstByteSeen) throw classifyConnectError(err, this.url);
            throw new Error(`Ollama ${this.url} stream interrupted: ${(err as Error).message}`);
          }
          if (result.done) break;
          firstByteSeen = true;
          lineBuf += decoder.decode(result.value ?? new Uint8Array(), { stream: true });

          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;

            let parsed: {
              message?: { content?: string; thinking?: string };
              done?: boolean;
              done_reason?: string;
              error?: string;
              eval_count?: number; eval_duration?: number;
              prompt_eval_count?: number; prompt_eval_duration?: number;
              load_duration?: number;
            };
            try {
              parsed = JSON.parse(line);
            } catch {
              /* Skip a corrupted NDJSON line rather than abort the stream —
                 Ollama very occasionally emits keep-alive noise. If the whole
                 stream produces no content, the empty-buffer check below
                 will hard-fail. */
              continue;
            }

            if (parsed.error) {
              /* #3084 P22, A8 — the daemon's in-stream error can echo request text; every
                 known analyzer secret is removed where the error is built. With no secret
                 the message is byte-identical. */
              const streamError = redactKnownSecrets(String(parsed.error), await loadKnownAnalyzerSecrets());
              throw new Error(`Ollama ${this.url} stream error: ${streamError}`);
            }
            if (parsed.done) {
              if (parsed.done_reason) doneReason = parsed.done_reason;
              timing = {
                model: this.model,
                evalCount: parsed.eval_count ?? 0,
                evalDuration: parsed.eval_duration ?? 0,
                promptEvalCount: parsed.prompt_eval_count ?? 0,
                promptEvalDuration: parsed.prompt_eval_duration ?? 0,
                loadDuration: parsed.load_duration ?? 0,
              };
            }

            if (typeof parsed.message?.thinking === 'string' && parsed.message.thinking.length > 0) {
              reasoningSeen = true;
              /* P4 — a thinking chunk is activity. Feed the route heartbeat
                 (analysis.ts:1184, :4417-4423) with the answer byte count
                 unchanged, like Gemini thought-only chunks and OpenAI
                 reasoning deltas. */
              const now = Date.now();
              onChunk?.({
                receivedBytes: buf.length,
                receivedText: buf,
                sinceLastChunkMs: now - lastChunkAt,
                elapsedMs: now - start,
              });
              lastChunkAt = now;
            }
            const piece = parsed.message?.content;
            if (piece) {
              buf += piece;
              const now = Date.now();
              onChunk?.({
                receivedBytes: buf.length,
                receivedText: buf,
                sinceLastChunkMs: now - lastChunkAt,
                elapsedMs: now - start,
              });
              lastChunkAt = now;
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }

      if (!buf) {
        if (doneReason === 'length') {
          console.warn(`[ollama] output truncated done_reason=length bytes=0 model=${this.model}`);
        }
        return { text: '', reasoningSeen, finish: doneReason === 'length' ? 'length' : 'stop', finishReason: doneReason, receivedBytes: 0 };
      }
      /* Truncation gate (#528): the stream completed but Ollama stopped
         because it hit the context/output budget (`done_reason: 'length'`),
         not because the model finished. The buffered JSON is cut off
         mid-object; returning it hands a corrupt payload to parseAndValidate.
         Throw a classified error so the stage-2 chunker can split the
         chapter rather than retrying the same oversized prompt. */
      if (doneReason === 'length') {
        console.warn(
          `[ollama] output truncated done_reason=length bytes=${buf.length} model=${this.model}`,
        );
        return { text: buf, reasoningSeen, finish: 'length', finishReason: 'length', receivedBytes: buf.length };
      }
      // fs-45 v1: record this model's real GPU footprint while provably resident.
      // Env-gated (Global Constraints) so fetch-count tests can opt out; best-effort.
      if (process.env.CASTWRIGHT_VRAM_SAMPLE !== '0') {
        await sampleAndRecordVram(this.url, this.model, resolveAnalyzerNumCtx());
      }

      /* srv-2367: warn once per distinct GPU split that would have fit on a
         single device — independently best-effort of the VRAM sample above,
         and never trusting detectOllamaGpuSplit's own never-throws contract
         blindly from this call site (belt and suspenders). Also warns when
         expectedDevice is set and the detected placement disagrees. */
      try {
        const splitResult = await detectOllamaGpuSplit();
        const expectedDevice = configValue<string>('analyzer.ollama.expectedDevice');

        /* Check for multi-GPU split that would fit on a single device. Only
           warn if we have complete data; a split with unavailable VRAM data
           means we can't confidently assess whether it would fit, so don't
           suggest a migration that might not actually help. */
        if (splitResult.split && splitResult.wouldFitSingleDevice && !splitResult.dataUnavailable) {
          const signature = splitResult.deviceIndices.join(',');
          if (!warnedGpuSplitSignatures.has(signature)) {
            warnedGpuSplitSignatures.add(signature);
            console.warn(
              `[ollama] analyzer model split across GPUs ${signature} (would fit on a single device) — see docs/local-llm.md "Pinning the analyzer to 100% GPU"`,
            );
          }
        }

        /* Check for expectedDevice mismatch: either a split touching ANY device
           outside the expected one, or a single device that isn't the expected one.
           Use .every() semantics (not .includes()): a split that touches ANY
           device outside expected counts as a mismatch, just like on the frontend.
           Guard against NaN (non-numeric expectedDevice) to fail safe: a malformed
           value like 'gpu0' would become NaN and compare false against every device
           index, producing a bogus always-mismatch warning. Mirror the frontend's
           !Number.isNaN guard (advanced.tsx line 314/323).
           Also mirror the frontend's dataUnavailable suppression: when the VRAM data
           is inconclusive (driver doesn't expose per-process memory), we can't
           confidently assert a mismatch, so suppress the warning. */
        if (expectedDevice && splitResult.reachable && !splitResult.dataUnavailable) {
          const expectedIndex = Number(expectedDevice);
          if (!Number.isNaN(expectedIndex)) {
            const isMismatch =
              (splitResult.split && !splitResult.deviceIndices.every((idx) => idx === expectedIndex)) ||
              /* Mismatch only fires when there's exactly one resident Ollama process/PID.
                 With 2+ distinct PIDs on different GPUs (e.g., analyzer + design model),
                 ambiguous which model expectedDevice refers to, so skip the warning. */
              (!splitResult.split && splitResult.deviceIndices.length === 1 && splitResult.deviceIndices[0] !== expectedIndex);

            if (isMismatch) {
              /* Include both the device list and expectedDevice in the signature so
                 each distinct mismatch state is warned once (rate-limited per
                 device signature + expected state pair). */
              const mismatchSignature = `${splitResult.deviceIndices.join(',')}-expected:${expectedDevice}`;
              if (!warnedGpuSplitSignatures.has(mismatchSignature)) {
                warnedGpuSplitSignatures.add(mismatchSignature);
                const deviceDesc = splitResult.deviceIndices.length === 0 ? 'unknown' : splitResult.deviceIndices.join(',');
                console.warn(
                  `[ollama] analyzer GPU device mismatch: expected GPU ${expectedDevice}, detected on GPU ${deviceDesc}`,
                );
              }
            }
          }
        }
      } catch {
        /* best-effort; never let a detector bug surface as an analyzer failure */
      }

      /* fs-analyzer-eval-telemetry: best-effort decode-timing capture, gated
         by the analyzer.evalStats.enabled knob so an operator can disable it.
         Wrapped so the sink can NEVER turn a clean decode into a stage failure —
         the sole consumer today is an inert array push, but "never throws on the
         hot path" must hold by construction for any future sink (srv-61). */
      if (timing && onEvalTiming && configValue<boolean>('analyzer.evalStats.enabled')) {
        try {
          onEvalTiming(timing);
        } catch (evalSinkErr) {
          console.warn('[ollama] onEvalTiming sink threw (ignored, telemetry is best-effort):', evalSinkErr);
        }
      }
      return { text: buf, reasoningSeen, finish: 'stop', finishReason: doneReason, receivedBytes: buf.length };
    } finally {
      releaseSlot();
    }
  }
}

/* Map a fetch / stream-read failure to either LocalUnreachableError (triggers
   fallback) or a plain Error (hard-fail). Undici surfaces connection-level
   errors as `TypeError: fetch failed` with `.cause` carrying the inner
   SystemError; we read `.cause.code` to discriminate. */
export function classifyConnectError(err: unknown, url: string): Error {
  const e = err as { cause?: { code?: string }; name?: string; code?: string; message?: string };
  const innerCode = e?.cause?.code ?? e?.code;
  if (innerCode && UNREACHABLE_CODES.has(innerCode)) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (${innerCode}). Start the daemon or switch to Gemini in Admin → Model Manager.`,
      err,
    );
  }
  /* Bare "fetch failed" with no inner code on Node 20 is almost always a
     connection refusal at the OS layer (Windows surfaces it without a code
     in some configs). Treat as unreachable. */
  if (e?.name === 'TypeError' && /fetch failed/i.test(e?.message ?? '')) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (fetch failed). Start the daemon or switch to Gemini in Admin → Model Manager.`,
      err,
    );
  }
  /* AbortError before first byte = the daemon never responded; treat as
     unreachable. Callers that abort mid-stream are handled by the inner
     read-loop catch which keys off `firstByteSeen`. */
  if (e?.name === 'AbortError') {
    return new LocalUnreachableError(
      `Ollama at ${url} aborted before first byte. Likely unreachable or hung.`,
      err,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

