/* Local Ollama analyzer. Mirrors GeminiAnalyzer's streaming + validation-retry
   shape (see gemini.ts) but talks to a local Ollama daemon over plain HTTP
   instead of the Google SDK.

   The key novelty is the error classification: only "couldn't connect" /
   "connection reset before first byte" failures translate into
   LocalUnreachableError, which is the *only* condition that triggers the
   FallbackAnalyzer in index.ts to retry against Gemini. Everything else —
   HTTP non-2xx, validation failures, mid-stream aborts — surfaces as a plain
   Error and hard-fails. The point: a misbehaving local model should not
   silently burn Gemini quota; if Ollama is up at all, we trust the error. */

import { writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { writeInbox, errorPath, type HandoffKey } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall, StageChunkInfo } from './index.js';
import {
  buildSystemInstruction,
  parseAndValidate,
  buildRetryMessage,
  summariseDetail,
  persistResponse,
  loadSkill,
  type SkillName,
} from './gemini.js';

/** Sentinel error class. The FallbackAnalyzer decorator in index.ts uses
    `err instanceof LocalUnreachableError` as the SOLE trigger for Gemini
    fallback. Any other error type propagates unchanged and hard-fails. */
export class LocalUnreachableError extends Error {
  readonly code = 'LOCAL_UNREACHABLE';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LocalUnreachableError';
  }
}

interface OllamaOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434).
      Trailing slash already stripped by getResolvedOllamaUrl. */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
}

/* Network-failure error codes that Node's undici fetch surfaces via
   `err.cause.code`. These are the "couldn't connect" cases that warrant
   fallback to Gemini. Anything else (HTTP 5xx, malformed body, validation
   failure) means the daemon is reachable but misbehaving — hard-fail. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_SOCKET']);

/* Models we want Ollama to hold in VRAM between back-to-back analysis
   calls. Stage 1 → Stage 2 → next chapter happens on a tight loop, and
   reloading a multi-GB weight set between each one would dominate
   wall-clock time. The 4B is small enough (~3 GB) to leave resident
   without crowding XTTS on an 8 GB box; the 9B (~6.6 GB) and Llama-8B
   (~5 GB) eat too much VRAM to leave sitting around, so we explicitly
   ask Ollama to evict them as soon as each call completes. Tune the
   allowlist in lockstep with src/lib/models.ts MODEL_OPTIONS. */
const RESIDENT_MODELS = new Set([
  'qwen3.5:4b',
]);

/** Picks the `keep_alive` value for an Ollama /api/chat call:
    - models in RESIDENT_MODELS → '5m' (stay loaded for the analysis loop)
    - everything else            → 0   (unload immediately after the call,
                                        matching `keep_alive: 0` in Ollama's
                                        own unload pattern — see
                                        https://github.com/ollama/ollama/blob/main/docs/api.md#keep-alive). */
export function keepAliveFor(model: string): string | number {
  return RESIDENT_MODELS.has(model) ? '5m' : 0;
}

export class OllamaAnalyzer implements Analyzer {
  private readonly url: string;
  private readonly model: string;

  constructor(opts: OllamaOptions) {
    this.url = opts.url;
    this.model = opts.model;
  }

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    return this.runStage(manuscriptId, '1', 'whole_book_stage1', promptMd, stage1Schema, call);
  }

  async runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput> {
    const key = `1-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'per_chapter_stage1', promptMd, stage1ChapterSchema, call);
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    const key = `2-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'per_chapter_stage2', promptMd, stage2ChapterSchema, call);
  }

  private async runStage<T>(
    manuscriptId: string,
    key: HandoffKey,
    skillName: SkillName,
    promptMd: string,
    schema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(skillName);
    const systemInstruction = buildSystemInstruction(skill);

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.chat(
        [
          { role: 'system', content: systemInstruction },
          { role: 'user',   content: promptMd },
        ],
        call.onChunk,
      );

      const firstAttempt = parseAndValidate(firstText, schema);
      if (firstAttempt.ok) {
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      // Retry once with the validation errors fed back as a follow-up turn.
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify({ kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 }, null, 2),
        'utf8',
      );

      const followup = buildRetryMessage(firstAttempt);
      const secondText = await this.chat(
        [
          { role: 'system',    content: systemInstruction },
          { role: 'user',      content: promptMd },
          { role: 'assistant', content: firstText },
          { role: 'user',      content: followup },
        ],
        call.onChunk,
      );

      const secondAttempt = parseAndValidate(secondText, schema);
      if (secondAttempt.ok) {
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
      }

      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          {
            kind: secondAttempt.kind,
            detail: secondAttempt.detail,
            attempt: 2,
            firstError: { kind: firstAttempt.kind, detail: firstAttempt.detail },
          },
          null,
          2,
        ),
        'utf8',
      );
      throw new Error(
        `Ollama ${this.model} ${key} failed validation after retry: ${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* Streamed chat against /api/chat. Mirrors GeminiAnalyzer.generate so the
     route-layer 45s silence watchdog (analysis.ts) keeps working unchanged —
     each NDJSON line fires onChunk with the assembled buffer. */
  private async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onChunk?: (info: StageChunkInfo) => void,
  ): Promise<string> {
    const body = {
      model: this.model,
      messages,
      stream: true,
      /* Constrain output to valid JSON. Ollama 0.5+ also supports a JSON
         schema object here for stricter structured output, but `format:'json'`
         + our existing validation-retry loop is enough for v1 with no new
         deps. Upgrade path: pass the per-stage Zod schema through
         zod-to-json-schema if first-attempt validation rates ever sag. */
      format: 'json',
      /* Per-model keep_alive — see keepAliveFor + RESIDENT_MODELS above.
         Small models (4B) stay resident across the analysis loop; larger
         ones (9B, Llama-8B) unload immediately so they don't squat on
         VRAM that XTTS needs after analysis. */
      keep_alive: keepAliveFor(this.model),
      /* Suppress qwen3.5's thinking tokens — they'd appear as
         `<think>…</think>` ahead of the JSON and break the parser. Ollama
         silently ignores this flag on non-thinking models. */
      think: false,
      options: {
        temperature: 0.2,
        /* 8K is plenty for chapter prompts (~3–4K typical) and keeps the
           KV cache well within the ~1.4 GB VRAM headroom on an 8 GB box
           after the 6.6 GB qwen3.5:9b weight load. Bump only if chapter
           prompts start running long and the chunker can't help. */
        num_ctx: 8192,
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw classifyConnectError(err, this.url);
    }

    if (!response.ok) {
      /* Reachable but errored — hard-fail. Surface the body verbatim so
         operator can diagnose ("model not found", "invalid format", …). */
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${this.url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error(`Ollama ${this.url} returned an empty body (no readable stream).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';          // assembled assistant content
    let lineBuf = '';      // partial NDJSON line carried across reads
    let firstByteSeen = false;
    const start = Date.now();
    let lastChunkAt = start;

    try {
      for (;;) {
        let result: { done: boolean; value?: Uint8Array };
        try {
          result = await reader.read();
        } catch (err) {
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

          let parsed: { message?: { content?: string }; done?: boolean; error?: string };
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
            throw new Error(`Ollama ${this.url} stream error: ${parsed.error}`);
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
      try { reader.releaseLock(); } catch { /* already released */ }
    }

    if (!buf) {
      throw new Error(`Ollama ${this.model} returned an empty response.`);
    }
    return buf;
  }
}

/* Map a fetch / stream-read failure to either LocalUnreachableError (triggers
   fallback) or a plain Error (hard-fail). Undici surfaces connection-level
   errors as `TypeError: fetch failed` with `.cause` carrying the inner
   SystemError; we read `.cause.code` to discriminate. */
function classifyConnectError(err: unknown, url: string): Error {
  const e = err as { cause?: { code?: string }; name?: string; code?: string; message?: string };
  const innerCode = e?.cause?.code ?? e?.code;
  if (innerCode && UNREACHABLE_CODES.has(innerCode)) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (${innerCode}). Start the daemon or set ANALYZER=gemini.`,
      err,
    );
  }
  /* Bare "fetch failed" with no inner code on Node 20 is almost always a
     connection refusal at the OS layer (Windows surfaces it without a code
     in some configs). Treat as unreachable. */
  if (e?.name === 'TypeError' && /fetch failed/i.test(e?.message ?? '')) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (fetch failed). Start the daemon or set ANALYZER=gemini.`,
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
