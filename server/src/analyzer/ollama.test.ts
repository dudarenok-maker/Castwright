/* OllamaAnalyzer — covers the wire-format basics that gemini.test.ts can't
   exercise because the transports differ:
     - NDJSON stream parsing and onChunk feedback
     - LocalUnreachableError vs. plain Error classification at the network
       boundary (the load-bearing distinction for the FallbackAnalyzer
       decorator)
     - validation-retry loop reusing the same helpers as GeminiAnalyzer

   The Ollama daemon is mocked at global.fetch — we don't need a real
   server, just a deterministic Response object per scenario. */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as conc from './analyzer-concurrency.js';
import type { RawEvalTiming } from './analyzer-eval-stats.js';
import {
  _setUserSettingsCacheForTest,
  _resetUserSettingsCache,
  DEFAULT_USER_SETTINGS,
} from '../workspace/user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');

/* A valid stage-1 chapter response — characters[] only, no chapters[] (the
   per-chapter shape forbids chapters via .strict()). */
const VALID_RESPONSE = JSON.stringify({
  characters: [
    {
      id: 'narrator',
      name: 'Narrator',
      role: 'narrator',
      color: 'narrator',
      evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }],
    },
    {
      id: 'wren',
      name: 'Wren',
      role: 'protagonist',
      color: 'orange',
      evidence: [{ quote: 'dd' }, { quote: 'eee' }, { quote: 'ffff' }],
    },
  ],
});

/* Build a ReadableStream that emits Ollama-style NDJSON: one line per
   content chunk, terminated by a `done: true` line. */
function ndjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const line = JSON.stringify({
          message: { role: 'assistant', content: chunks[i] },
          done: false,
        });
        controller.enqueue(encoder.encode(line + '\n'));
        i += 1;
      } else if (i === chunks.length) {
        const done = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true });
        controller.enqueue(encoder.encode(done + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/* Like ndjsonStream but the terminating `done:true` line carries a
   `done_reason` — 'length' is Ollama's "hit the context/output budget"
   (truncated) signal. */
function ndjsonStreamWithDoneReason(
  chunks: string[],
  doneReason: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const line = JSON.stringify({
          message: { role: 'assistant', content: chunks[i] },
          done: false,
        });
        controller.enqueue(encoder.encode(line + '\n'));
        i += 1;
      } else if (i === chunks.length) {
        const done = JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: doneReason,
        });
        controller.enqueue(encoder.encode(done + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

/* Like ndjsonStream but the terminating `done:true` line also carries
   Ollama's real decode-timing fields (eval_count/eval_duration/
   prompt_eval_count/prompt_eval_duration/load_duration) — used to test
   the onEvalTiming capture seam (analyzer-eval-telemetry). */
function ndjsonStreamWithTiming(
  chunks: string[],
  timing: Record<string, number>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const line = JSON.stringify({
          message: { role: 'assistant', content: chunks[i] },
          done: false,
        });
        controller.enqueue(encoder.encode(line + '\n'));
        i += 1;
      } else if (i === chunks.length) {
        const done = JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          ...timing,
        });
        controller.enqueue(encoder.encode(done + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function okResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });

describe('OllamaAnalyzer — happy path streaming', () => {
  it('parses a NDJSON stream into the assembled JSON response and fires onChunk per content piece', async () => {
    const pieces = chunksOf(VALID_RESPONSE, 32);
    expect(pieces.length).toBeGreaterThan(2);
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(pieces)));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const onChunk = vi.fn();
    const result = await analyzer.runStage1Chapter('m_ollama_ok', 1, '# stage1 prompt', {
      onChunk,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('qwen3.5:9b');
    expect(body.stream).toBe(true);
    /* Schema-constrained decoding: `format` is now the JSON Schema derived
     * from the per-stage Zod schema, not the legacy 'json' string. See
     * ollama.ts:runStage. The schema-shape contract is asserted in a
     * dedicated test below; here we only sanity-check that we moved off
     * the string sentinel. */
    expect(body.format).not.toBe('json');
    expect(typeof body.format).toBe('object');
    /* qwen3.5:9b has no override, so it resolves to the flat 30s fallback
       (DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS) — the curated per-model map was
       removed. accel is 'unknown' here so the RAM-heavy CPU clamp doesn't fire. */
    expect(body.keep_alive).toBe(30);
    expect(body.options.num_ctx).toBe(32768);
    /* Pin all layers to GPU — see ANALYZER_NUM_GPU in ollama.ts. 999 is
       the standard "all layers" idiom; without this, Ollama auto-splits
       and silently offloads layers to CPU under VRAM pressure. The
       in-app /load endpoint threads the same value (covered in its own
       test in ollama-health.test.ts) so warm-then-chat doesn't trigger
       a mid-stream reload. */
    expect(body.options.num_gpu).toBe(999);
    /* DEFAULT_TEMPERATURE on the first attempt — invalid-json retries bump
       to INVALID_JSON_RETRY_TEMPERATURE (covered in its own test below). */
    expect(body.options.temperature).toBe(0.2);
    /* System + user turn shape. */
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');

    /* Buffer reassembled, monotonic, terminal value matches input. */
    expect(onChunk).toHaveBeenCalledTimes(pieces.length);
    const lengths = onChunk.mock.calls.map((args) => args[0].receivedBytes);
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    expect(lengths[lengths.length - 1]).toBe(VALID_RESPONSE.length);

    /* Parsed payload comes through. */
    expect(result.characters).toHaveLength(2);
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'wren']);
  });
});

describe('OllamaAnalyzer — analyzer slot (limiter + model lease)', () => {
  it('acquires an analyzer slot around a chat call and releases it', async () => {
    const spy = vi.spyOn(conc, 'acquireAnalyzerSlot');
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await analyzer.runStage1Chapter('m_ollama_slot_ok', 1, '# stage1 prompt', {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('qwen3.5:9b'); // keyed on this.model
    expect(conc.analyzerConcurrency.inFlight).toBe(0); // released in finally
    spy.mockRestore();
  });

  it('releases the slot even when the chat call throws', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await expect(
      analyzer.runStage1Chapter('m_ollama_slot_err', 1, '# stage1 prompt', {}),
    ).rejects.toThrow();
    expect(conc.analyzerConcurrency.inFlight).toBe(0);
  });
});

describe('OllamaAnalyzer — keep_alive policy (per-model seconds)', () => {
  afterEach(() => _resetUserSettingsCache());

  it('returns the flat 30s fallback for ANY model without an override (curated map removed)', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    // Formerly-curated tags no longer get a special 300 — they share the fallback.
    expect(keepAliveFor('qwen3.5:4b')).toBe(30);
    expect(keepAliveFor('llama3.1:8b')).toBe(30);
    expect(keepAliveFor('qwen3.5:9b')).toBe(30);
    expect(keepAliveFor('gemma4-e4b-8gb')).toBe(30);
    expect(keepAliveFor('gemma4-e4b-8gb:latest')).toBe(30); // normalized to bare
    // The regression that started this: an uncurated fine-tune used to fall to 0
    // (evict-per-call). It now gets the 30s fallback so a run stays resident.
    expect(keepAliveFor('qwen36-cw-iq4-32k:latest')).toBe(30);
    expect(keepAliveFor('placeholder:test-7b')).toBe(30);
  });

  it('lets a user override win, including -1 (pin) and 0 (evict)', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    _setUserSettingsCacheForTest({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 600, 'qwen3.5:4b': 0, 'llama3.1:8b': -1 },
    });
    expect(keepAliveFor('qwen36-castwright:latest')).toBe(600);
    expect(keepAliveFor('qwen3.5:4b')).toBe(0); // override beats the 30s fallback
    expect(keepAliveFor('llama3.1:8b')).toBe(-1);
  });

  it('clamps RAM-heavy 9B to 0 on CPU even with a positive override', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    _setUserSettingsCacheForTest({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen3.5:9b': 900 },
    });
    expect(keepAliveFor('qwen3.5:9b', 'cuda')).toBe(900);
    expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
    expect(keepAliveFor('qwen3.5:9b', 'unknown')).toBe(900);
    expect(keepAliveFor('qwen3.5:4b', 'cpu')).toBe(30); // small model → fallback, unaffected by CPU clamp
  });

  it('PINS the model (-1) while an analysis OR review run is in flight, overriding fallback / override / CPU-clamp', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    const { markAnalysisBusy, clearAnalysisBusy, markReviewBusy, clearReviewBusy } = await import(
      '../tts/design-lock.js'
    );
    _setUserSettingsCacheForTest({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen3.5:4b': 120 }, // a positive override…
    });
    // …is superseded by the run-scoped pin. Calls land minutes apart, so any
    // finite TTL would let Ollama evict between them mid-run. Both a main
    // analysis run and a script-review run pin the model.
    for (const [mark, clear] of [
      [markAnalysisBusy, clearAnalysisBusy],
      [markReviewBusy, clearReviewBusy],
    ] as const) {
      mark('/book/pinned');
      try {
        expect(keepAliveFor('qwen36-cw-iq4-32k:latest')).toBe(-1); // uncurated fallback → pinned
        expect(keepAliveFor('qwen3.5:4b')).toBe(-1); // override → pinned
        expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(-1); // RAM-heavy CPU clamp → pinned
      } finally {
        clear('/book/pinned');
      }
    }
    // Both runs over → normal resolution resumes (teardown issues the keep_alive:0 evict).
    expect(keepAliveFor('qwen36-cw-iq4-32k:latest')).toBe(30);
    expect(keepAliveFor('qwen3.5:4b')).toBe(120);
    expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
  });
});

describe('OllamaAnalyzer — schema-constrained `format`', () => {
  /* The wire-level contract for Ollama 0.5+ structured output. The exact
     conversion is owned by Zod 4's native z.toJSONSchema; we assert just
     enough that a regression to `format: 'json'` (the old soft-hint) or to a
     $ref-using shape (which some Ollama builds can't follow) would fail this
     test. The JSON-Schema shape itself is pinned in handoff/schemas.test.ts. */
  it('sends the per-stage Zod schema as a strict JSON Schema in `format` for stage1Chapter', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await analyzer.runStage1Chapter('m_ollama_format_shape_s1c', 1, '# prompt', {});

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.format).toBeTypeOf('object');
    /* stage1ChapterSchema = { characters: [...] }, .strict(). */
    expect(body.format.type).toBe('object');
    expect(body.format.additionalProperties).toBe(false);
    expect(body.format.required).toContain('characters');
    expect(body.format.properties?.characters?.type).toBe('array');
    /* characterSchema is also .strict() — confirm reused:'inline' inlined
       it (so Ollama doesn't have to follow $ref/definitions). */
    const charItems = body.format.properties.characters.items;
    expect(charItems.type).toBe('object');
    expect(charItems.additionalProperties).toBe(false);
    expect(charItems.required).toEqual(expect.arrayContaining(['id', 'name', 'role', 'color']));
    expect(JSON.stringify(body.format)).not.toContain('$ref');
  });

  it('sends a *different* JSON Schema for stage2 (sentences[]) than stage1Chapter (characters[])', async () => {
    /* Same-shape valid payload for stage 2 so the per-chapter loop validates. */
    const stage2Payload = JSON.stringify({
      sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
    });
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(stage2Payload, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await analyzer.runStage1Chapter('m_ollama_format_shape_diff', 1, '# stage1 prompt', {});
    await analyzer.runStage2Chapter('m_ollama_format_shape_diff', 1, '# stage2 prompt', {});

    const s1 = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).format;
    const s2 = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body).format;
    expect(s1.required).toContain('characters');
    expect(s2.required).toContain('sentences');
    expect(s2.properties.sentences.items.required).toEqual(
      expect.arrayContaining(['id', 'chapterId', 'characterId', 'text']),
    );
  });
});

describe('OllamaAnalyzer — two-schema runStage (grammar vs validation)', () => {
  /* Task 7: runStage now accepts grammarSchema (fed to z.toJSONSchema → Ollama
     format) and validationSchema (fed to parseAndValidate). For stage1Chapter,
     the grammar uses stage1ChapterGrammarSchema (tone REQUIRED) while
     validation uses stage1ChapterSchema (tone OPTIONAL). A response with no
     tone field must pass validation without a retry. */
  it('a stage-1 response with NO tone passes validation (non-fatal), grammar still required-tone', async () => {
    /* Arrange: character without tone — grammar requires it, validation tolerates absence. */
    const noToneResponse = JSON.stringify({
      characters: [
        {
          id: 'narrator',
          name: 'Narrator',
          role: 'narrator',
          color: 'narrator',
          /* NOTE: tone is intentionally absent here — the validation schema
             (stage1ChapterSchema → characterSchema) marks tone as optional.
             A missing tone must NOT fail parseAndValidate or trigger a retry. */
        },
      ],
    });
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(noToneResponse, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const { stage1ChapterGrammarSchema } = await import('../handoff/schemas.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    /* (b) validation is tolerant: the call succeeds with no retry */
    const result = await analyzer.runStage1Chapter(
      'm_ollama_two_schema',
      1,
      '# stage1 prompt',
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].tone).toBeUndefined(); // absent is fine

    /* (a) grammar fed to Ollama is derived from the required-tone grammar schema */
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const expectedGrammar = z.toJSONSchema(stage1ChapterGrammarSchema, {
      target: 'draft-07',
      reused: 'inline',
    });
    expect(body.format).toEqual(expectedGrammar);

    /* Confirm the grammar schema DOES require tone (its character items list
       tone as required), while the validation schema does not. */
    const charItems = body.format.properties.characters.items;
    expect(charItems.required).toContain('tone');
  });
});

describe('OllamaAnalyzer — runNonStoryClassification (#1447 Signal 2)', () => {
  it('parses a { nonStory: true } model response', async () => {
    const { nonStoryClassificationSchema } = await import('../handoff/schemas.js');
    fetchMock.mockResolvedValue(
      okResponse(ndjsonStream(chunksOf(JSON.stringify({ nonStory: true }), 16))),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    const out = await analyzer.runNonStoryClassification!('m_nonstory_ch3', 3, 'PROMPT', {
      language: 'ru',
    });

    expect(out).toEqual({ nonStory: true });
    expect(nonStoryClassificationSchema.safeParse(out).success).toBe(true);

    /* routed through runStage → schema-constrained `format` for the
       non_story_classification skill. */
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.format.required).toContain('nonStory');
  });
});

/* fs-2 — the Ollama analyzer gets the same language preamble as Gemini (parity)
   so a local Russian run attributes correctly. */
describe('OllamaAnalyzer — fs-2 language preamble', () => {
  function systemContent(callArgs: unknown): string {
    const body = JSON.parse((callArgs as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>;
    };
    return body.messages.find((m) => m.role === 'system')?.content ?? '';
  }

  it("injects the Russian preamble into the system message for language 'ru'", async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await analyzer.runStage1Chapter('m_ollama_ru', 1, '# prompt', { language: 'ru' });
    expect(systemContent(fetchMock.mock.calls[0][1])).toMatch(/manuscript text is in Russian/i);
  });

  it("omits the preamble for an English book (language 'en' or absent)", async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await analyzer.runStage1Chapter('m_ollama_en', 1, '# prompt', {});
    expect(systemContent(fetchMock.mock.calls[0][1])).not.toMatch(/manuscript text is in/i);
  });
});

describe('OllamaAnalyzer — LocalUnreachableError classification', () => {
  it('throws LocalUnreachableError when fetch fails with ECONNREFUSED', async () => {
    const fetchErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    fetchMock.mockRejectedValue(fetchErr);

    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(
      analyzer.runStage1Chapter('m_ollama_down', 1, '# prompt', {}),
    ).rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('throws LocalUnreachableError on bare TypeError: fetch failed with no cause code', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(
      analyzer.runStage1Chapter('m_ollama_bare_fetchfail', 1, '# prompt', {}),
    ).rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('throws LocalUnreachableError on AbortError before first byte', async () => {
    const ab = new Error('aborted');
    ab.name = 'AbortError';
    fetchMock.mockRejectedValue(ab);
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(
      analyzer.runStage1Chapter('m_ollama_abort', 1, '# prompt', {}),
    ).rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('does NOT classify a 404 "model not found" response as unreachable — it hard-fails as a plain Error', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'model "qwen3.5:9b" not found, try pulling it first' }),
        { status: 404, statusText: 'Not Found' },
      ),
    );
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    /* This is the load-bearing assertion: a *reachable* daemon returning a
       hard error must NOT trigger Gemini fallback. The decorator above
       this layer only acts on LocalUnreachableError. */
    await expect(
      analyzer.runStage1Chapter('m_ollama_404', 1, '# prompt', {}),
    ).rejects.not.toBeInstanceOf(LocalUnreachableError);
    await expect(
      analyzer.runStage1Chapter('m_ollama_404_again', 1, '# prompt', {}),
    ).rejects.toThrow(/404/);
  });

  it('throws plain Error (not LocalUnreachableError) when the daemon returns 500', async () => {
    fetchMock.mockResolvedValue(
      new Response('upstream blew up', { status: 500, statusText: 'Internal Server Error' }),
    );
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(
      analyzer.runStage1Chapter('m_ollama_500', 1, '# prompt', {}),
    ).rejects.not.toBeInstanceOf(LocalUnreachableError);
  });

  it('throws plain Error on empty body', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream([])));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    let err: unknown;
    try {
      await analyzer.runStage1Chapter('m_ollama_empty', 1, '# prompt', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LocalUnreachableError);
    expect((err as Error).message).toMatch(/empty response/i);
  });
});

describe('OllamaAnalyzer — validation-retry', () => {
  it('retries once when the first response fails schema validation, then accepts the corrected JSON', async () => {
    const invalid = JSON.stringify({
      characters: [] /* missing required field on shape — empty arr is fine actually */,
    });
    /* Use a genuine SHAPE violation to force the retry: `characters` must be
       an array, so a string fails with an `invalid_type` issue. (An extra
       strict-forbidden key would NOT work here — parseAndValidate now strips
       stray keys and accepts the cleaned object on the first attempt, so it
       would never reach the retry path this test exercises.) */
    const strictlyInvalid = JSON.stringify({ characters: 'nope' });

    /* First call → strictlyInvalid, second call → valid. */
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(strictlyInvalid, 32))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runStage1Chapter('m_ollama_retry', 1, '# prompt', {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.characters).toHaveLength(2);

    /* Schema-validation retry keeps the replay-and-correct pattern: the
       prior assistant turn is included so the model sees its own
       structurally-near-miss output, and the followup user turn enumerates
       the offending fields. Temperature stays at DEFAULT_TEMPERATURE — at
       low temperature the model patches the named fields in place rather
       than rewriting from scratch, which is what we want here. */
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(secondBody.messages.find((m: { role: string }) => m.role === 'assistant')).toBeTruthy();
    expect(secondBody.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(2);
    expect(secondBody.options.temperature).toBe(0.2);

    /* Sanity-check we used the invalid arg in the first call. */
    void invalid;
  });

  /* The bug this guards against: qwen3.5:4b hitting a sampling trap and
     emitting malformed JSON, then the retry — replaying the broken bytes
     at temperature 0.2 — regenerating near-identical bytes that fail at
     the same byte position. Fix: invalid-json retries drop the assistant
     turn and bump temperature, giving the sampler real room to escape. */
  it('on an invalid-json first attempt, retries WITHOUT replaying the assistant turn and at INVALID_JSON_RETRY_TEMPERATURE', async () => {
    const malformed = '{ "characters": [ { "id": "narrator"'; // truncated → JSON.parse fails
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(malformed, 16))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));

    const { OllamaAnalyzer, INVALID_JSON_RETRY_TEMPERATURE } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    const result = await analyzer.runStage1Chapter(
      'm_ollama_invalid_json_retry',
      1,
      '# prompt',
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.characters).toHaveLength(2);

    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);

    /* First attempt is unchanged: system + user, temperature 0.2. */
    expect(firstBody.messages).toHaveLength(2);
    expect(firstBody.options.temperature).toBe(0.2);

    /* Retry: system + user only — no assistant replay of the broken bytes,
       no corrective followup user turn (those help schema-validation
       failures but only entrench invalid-json failures). */
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.messages[0].role).toBe('system');
    expect(secondBody.messages[1].role).toBe('user');
    expect(
      secondBody.messages.find((m: { role: string }) => m.role === 'assistant'),
    ).toBeUndefined();

    /* Bumped temperature so the sampler can drift away from the broken path. */
    expect(secondBody.options.temperature).toBe(INVALID_JSON_RETRY_TEMPERATURE);
    expect(INVALID_JSON_RETRY_TEMPERATURE).toBeGreaterThan(firstBody.options.temperature);
  });

  it('hard-fails after the second attempt also fails validation', async () => {
    /* Genuine SHAPE violation (`characters` must be an array) so BOTH attempts
       hard-fail and reach the post-retry throw. An extra strict-forbidden key
       would be stripped and accepted by parseAndValidate, never failing. */
    const bad = JSON.stringify({ characters: 'nope' });
    /* Fresh Response per call — a streamed body can only be consumed once,
       so a shared `mockResolvedValue(...)` would feed the second attempt
       an already-drained stream and trip the "empty response" branch. */
    fetchMock.mockImplementation(() =>
      Promise.resolve(okResponse(ndjsonStream(chunksOf(bad, 32)))),
    );

    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    let err: unknown;
    try {
      await analyzer.runStage1Chapter('m_ollama_retry_fail', 1, '# prompt', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LocalUnreachableError);
    expect((err as Error).message).toMatch(/validation after retry/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OllamaAnalyzer — forensic raw-response persistence on failure', () => {
  /* When schema-constrained decoding fails (which should be impossible by
     construction — see the format-shape test above), we want to be able to
     open the actual bytes the model emitted and see what tripped the
     parser. Both attempts get their own .raw.txt; on a partial-success run
     the first attempt's text is preserved for comparison. */
  it('writes attempt1.raw.txt when the first attempt fails (even when the retry succeeds)', async () => {
    const malformed = '{ "characters": [ { "id": "narrator", "name": "Nar'; // truncated
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(malformed, 16))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const { readFile } = await import('node:fs/promises');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    await analyzer.runStage1Chapter('m_ollama_raw_attempt1', 1, '# prompt', {});

    const rawPath = resolve(
      HANDOFF_ROOT,
      'outbox',
      'm_ollama_raw_attempt1-stage1-ch1.attempt1.raw.txt',
    );
    const raw = await readFile(rawPath, 'utf8');
    expect(raw).toBe(malformed);
  });

  it('writes BOTH attempt1.raw.txt and attempt2.raw.txt when both attempts fail', async () => {
    const malformedA = '{ "characters": [ { "id": "a"';
    const malformedB = '{ "characters": [ { "id": "b"';
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(malformedA, 16))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(malformedB, 16))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const { readFile } = await import('node:fs/promises');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    await expect(analyzer.runStage1Chapter('m_ollama_raw_both', 1, '# prompt', {})).rejects.toThrow(
      /validation after retry/,
    );

    const raw1 = await readFile(
      resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_raw_both-stage1-ch1.attempt1.raw.txt'),
      'utf8',
    );
    const raw2 = await readFile(
      resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_raw_both-stage1-ch1.attempt2.raw.txt'),
      'utf8',
    );
    expect(raw1).toBe(malformedA);
    expect(raw2).toBe(malformedB);
  });
});

describe('OllamaAnalyzer — output truncation (#528)', () => {
  it('throws AnalyzerTruncatedError when the stream ends with done_reason: length', async () => {
    /* A truncated (mid-JSON) payload whose final done line reports
       done_reason 'length'. The gate fires before parseAndValidate so the
       corrupt buffer never reaches the parser. */
    fetchMock.mockResolvedValue(
      okResponse(ndjsonStreamWithDoneReason(['{"characters":[{"id":"narr'], 'length')),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    /* Same-realm error class — see the gemini truncation test note. */
    const { AnalyzerTruncatedError } = await import('./errors.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await expect(
      analyzer.runStage1Chapter('m_ollama_trunc', 1, '# prompt', {}),
    ).rejects.toBeInstanceOf(AnalyzerTruncatedError);
    /* Non-retryable: one round-trip only. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns normally when done_reason is stop', async () => {
    const pieces = chunksOf(VALID_RESPONSE, 64);
    fetchMock.mockResolvedValue(okResponse(ndjsonStreamWithDoneReason(pieces, 'stop')));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    const result = await analyzer.runStage1Chapter('m_ollama_stopreason', 1, '# prompt', {});
    expect(result.characters).toHaveLength(2);
  });
});

describe('OllamaAnalyzer — onEvalTiming sink (analyzer-eval-telemetry)', () => {
  afterEach(() => {
    delete process.env.CASTWRIGHT_EVAL_SAMPLE;
  });

  it('fires onEvalTiming with raw counts + model off the done line', async () => {
    const timings: RawEvalTiming[] = [];
    fetchMock.mockResolvedValue(
      okResponse(
        ndjsonStreamWithTiming(chunksOf(VALID_RESPONSE, 32), {
          eval_count: 120,
          eval_duration: 4_000_000_000,
          prompt_eval_count: 800,
          prompt_eval_duration: 2_000_000_000,
          load_duration: 0,
        }),
      ),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await analyzer.runStage1Chapter('m_ollama_eval_timing', 1, '# prompt', {
      onEvalTiming: (t) => timings.push(t),
    });

    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({
      model: expect.any(String),
      evalCount: 120,
      evalDuration: 4_000_000_000,
      promptEvalCount: 800,
      loadDuration: 0,
    });
  });

  it('does not fire onEvalTiming when analyzer.evalStats.enabled is false', async () => {
    process.env.CASTWRIGHT_EVAL_SAMPLE = '0';
    const timings: RawEvalTiming[] = [];
    fetchMock.mockResolvedValue(
      okResponse(
        ndjsonStreamWithTiming(chunksOf(VALID_RESPONSE, 32), {
          eval_count: 120,
          eval_duration: 4_000_000_000,
          prompt_eval_count: 800,
          prompt_eval_duration: 2_000_000_000,
          load_duration: 0,
        }),
      ),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await analyzer.runStage1Chapter('m_ollama_eval_timing_disabled', 1, '# prompt', {
      onEvalTiming: (t) => timings.push(t),
    });

    expect(timings).toHaveLength(0);
  });

  it('a throwing onEvalTiming sink never fails an otherwise-successful decode (srv-61)', async () => {
    // The sink is best-effort telemetry on the hot path; a future non-inert sink
    // must not be able to turn a clean decode into a stage failure.
    fetchMock.mockResolvedValue(
      okResponse(
        ndjsonStreamWithTiming(chunksOf(VALID_RESPONSE, 32), {
          eval_count: 120,
          eval_duration: 4_000_000_000,
          prompt_eval_count: 800,
          prompt_eval_duration: 2_000_000_000,
          load_duration: 0,
        }),
      ),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runStage1Chapter('m_ollama_eval_timing_throws', 1, '# prompt', {
      onEvalTiming: () => {
        throw new Error('sink boom');
      },
    });

    expect(result.characters).toBeDefined();
  });
});

/* srv-59 Task 9 — the escalation primitive is deliberately NOT built on
   runStage: no schema-constrained retry loop, and an empty/malformed reply
   must resolve to `null` rather than throw. These tests pin that contract
   at the wire level, mirroring the mocking style of the describe blocks
   above (fetchMock over global.fetch, NDJSON streams via ndjsonStream). */
describe('OllamaAnalyzer — runAttributionEscalation (srv-59 Task 9)', () => {
  const VALID_ESCALATION_RESPONSE = JSON.stringify({
    assignments: [
      { line: 12, characterId: 'wren' },
      { line: 14, characterId: 'marlow' },
    ],
  });

  afterEach(async () => {
    for (const id of ['m_escalation_ok', 'm_escalation_empty', 'm_escalation_malformed']) {
      await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-stageescalation-ch1-w0.md`), { force: true });
      await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stageescalation-ch1-w0.json`), { force: true });
    }
  });

  it('round-trips a valid {assignments} reply', async () => {
    fetchMock.mockResolvedValue(
      okResponse(ndjsonStream(chunksOf(VALID_ESCALATION_RESPONSE, 16))),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runAttributionEscalation(
      'm_escalation_ok',
      1,
      0,
      'resolve these lines',
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.assignments).toEqual([
      { line: 12, characterId: 'wren' },
      { line: 14, characterId: 'marlow' },
    ]);

    /* Self-contained prompt: single user turn, no system instruction / skill
       file — unlike every other runStage* call. */
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.messages).toEqual([{ role: 'user', content: 'resolve these lines' }]);
    /* Still schema-constrained decoding via `format`, just with the tolerant
       escalation schema instead of stage2's. */
    expect(body.format.required).toContain('assignments');
  });

  it('resolves to null (not a throw) on an EMPTY response body', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream([])));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runAttributionEscalation(
      'm_escalation_empty',
      1,
      0,
      'resolve these lines',
      {},
    );

    expect(result).toBeNull();
  });

  it('resolves to null (not a throw) on malformed JSON', async () => {
    const malformed = '{ "assignments": [ { "line": 1'; // truncated
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(malformed, 8))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runAttributionEscalation(
      'm_escalation_malformed',
      1,
      0,
      'resolve these lines',
      {},
    );

    expect(result).toBeNull();
  });

  it('an empty assignments array is a valid (non-null) result — no .min(1)', async () => {
    fetchMock.mockResolvedValue(
      okResponse(ndjsonStream(chunksOf(JSON.stringify({ assignments: [] }), 8))),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runAttributionEscalation(
      'm_escalation_empty_valid',
      1,
      0,
      'resolve these lines',
      {},
    );

    expect(result).toEqual({ assignments: [] });

    await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_escalation_empty_valid-stageescalation-ch1-w0.md'), {
      force: true,
    });
    await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_escalation_empty_valid-stageescalation-ch1-w0.json'), {
      force: true,
    });
  });
});

function mockChatResponse(text: string) {
  // Non-streaming /api/chat returns one JSON object.
  return new Response(JSON.stringify({ message: { content: text }, done: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('generatePersonaViaOllama', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GPU path: sends the caller keep_alive and leaves num_gpu unset', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A warm voice.'));
    const { generatePersonaViaOllama } = await import('./ollama.js');
    const out = await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', { onCpu: false, keepAlive: '5m' });
    expect(out).toBe('A warm voice.');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keep_alive).toBe('5m');
    expect(body.stream).toBe(false);
    expect(body.format).toBeUndefined();
    expect(body.think).toBe(false);
    expect(body.options?.num_gpu).toBeUndefined(); // GPU path leaves num_gpu unset
  });

  it('CPU path: num_gpu:0, keep_alive:0', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A cool voice.'));
    const { generatePersonaViaOllama } = await import('./ollama.js');
    const out = await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', { onCpu: true });
    expect(out).toBe('A cool voice.');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options.num_gpu).toBe(0);
    expect(body.keep_alive).toBe(0);
  });

  it('connection refusal surfaces LocalUnreachableError', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );
    const { generatePersonaViaOllama, LocalUnreachableError } = await import('./ollama.js');
    await expect(generatePersonaViaOllama('P', 'qwen3.5:9b', { onCpu: true })).rejects.toBeInstanceOf(
      LocalUnreachableError,
    );
  });

  it('persona gen goes through the analyzer slot, keyed on its model (GPU path)', async () => {
    const spy = vi.spyOn(conc, 'acquireAnalyzerSlot');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A warm voice.'));
    const { generatePersonaViaOllama } = await import('./ollama.js');
    await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', { onCpu: false, keepAlive: '5m' });
    expect(spy).toHaveBeenCalledWith('qwen3.5:9b', false);
    expect(conc.analyzerConcurrency.inFlight).toBe(0);
    spy.mockRestore();
  });

  it('persona gen on CPU takes the limiter but no GPU slot', async () => {
    const spy = vi.spyOn(conc, 'acquireAnalyzerSlot');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A cool voice.'));
    const { generatePersonaViaOllama } = await import('./ollama.js');
    await generatePersonaViaOllama('PROMPT', 'qwen3.5:4b', { onCpu: true });
    expect(spy).toHaveBeenCalledWith('qwen3.5:4b', true); // onCpu forwarded → lease no-ops
    spy.mockRestore();
  });
});

afterAll(async () => {
  /* Tidy test inbox/outbox files. */
  for (const id of [
    'm_ollama_ok',
    'm_ollama_trunc',
    'm_ollama_stopreason',
    'm_ollama_down',
    'm_ollama_bare_fetchfail',
    'm_ollama_abort',
    'm_ollama_404',
    'm_ollama_404_again',
    'm_ollama_500',
    'm_ollama_empty',
    'm_ollama_retry',
    'm_ollama_retry_fail',
    'm_ollama_invalid_json_retry',
    'm_ollama_keepalive_4b',
    'm_ollama_keepalive_llama',
    'm_ollama_format_shape_s1c',
    'm_ollama_format_shape_diff',
    'm_ollama_raw_attempt1',
    'm_ollama_raw_both',
    'm_ollama_two_schema',
    'm_ollama_slot_ok',
    'm_ollama_slot_err',
  ]) {
    await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-stage1-ch1.md`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.json`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.errors.json`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.attempt1.raw.txt`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.attempt2.raw.txt`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-stage2-ch1.md`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage2-ch1.json`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage2-ch1.errors.json`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage2-ch1.attempt1.raw.txt`), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage2-ch1.attempt2.raw.txt`), { force: true });
  }
});
