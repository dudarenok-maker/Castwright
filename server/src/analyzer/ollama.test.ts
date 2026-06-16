/* OllamaAnalyzer — covers the wire-format basics that gemini.test.ts can't
   exercise because the transports differ:
     - NDJSON stream parsing and onChunk feedback
     - LocalUnreachableError vs. plain Error classification at the network
       boundary (the load-bearing distinction for the FallbackAnalyzer
       decorator)
     - validation-retry loop reusing the same helpers as GeminiAnalyzer

   The Ollama daemon is mocked at global.fetch — we don't need a real
   server, just a deterministic Response object per scenario. */

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    /* 9B now holds the resident keep_alive: '5m' slot alongside the 4B and
       llama3.1:8b. The chunker caps each section so weights + KV stay within
       the 8 GB budget; the old keep_alive: 0 unloaded+reloaded ~6.35 GB
       between every section, which dominated wall-clock — badly so on
       Cyrillic manuscripts that need the larger model. The generation
       engine's auto-evict frees it before Qwen TTS / XTTS load. See
       RESIDENT_MODELS in ollama.ts; unknown tags still get 0. */
    expect(body.keep_alive).toBe('5m');
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

describe('OllamaAnalyzer — keep_alive policy (per-model VRAM residency)', () => {
  /* Direct pure-function check on keepAliveFor — guards the allowlist
     contract independent of the wire format. */
  it('returns "5m" for the resident-allowlisted models and 0 for the rest', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    /* 4B (~3 GB) and llama3.1:8b (~5 GB) both fit resident with the KV
       cache at ANALYZER_NUM_CTX on an 8 GB box, so they hold across the
       Stage 1 → Stage 2 → next-chapter loop. */
    expect(keepAliveFor('qwen3.5:4b')).toBe('5m');
    expect(keepAliveFor('llama3.1:8b')).toBe('5m');
    /* 9B (~6.6 GB) is now resident too: it fits within budget with the
       chunker-capped KV cache, and dropping ~6.35 GB between every section
       was crippling analysis (especially Cyrillic, which needs the larger
       model). The generation-phase auto-evict frees it before Qwen TTS /
       XTTS load. */
    expect(keepAliveFor('qwen3.5:9b')).toBe('5m');
    /* An unknown model id defaults to 0 — the conservative choice is
       "unload immediately" so we never accidentally pin a model the
       allowlist hasn't been tuned for. */
    expect(keepAliveFor('placeholder:test-7b')).toBe(0);
  });

  it('pins the heavy 9B resident only on a GPU; CPU unloads it to spare RAM', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    expect(keepAliveFor('qwen3.5:9b', 'cuda')).toBe('5m');
    expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
    expect(keepAliveFor('qwen3.5:4b', 'cpu')).toBe('5m'); // small model: stays
    expect(keepAliveFor('qwen3.5:9b', 'unknown')).toBe('5m'); // unprobed: assume GPU (the perf win)
  });

  it('threads keep_alive: "5m" into the /api/chat body when the model is qwen3.5:4b', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });
    await analyzer.runStage1Chapter('m_ollama_keepalive_4b', 1, '# prompt', {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.keep_alive).toBe('5m');
  });

  it('threads keep_alive: "5m" into the /api/chat body for llama3.1:8b (resident across the analysis loop)', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'llama3.1:8b' });
    await analyzer.runStage1Chapter('m_ollama_keepalive_llama', 1, '# prompt', {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.keep_alive).toBe('5m');
  });

  it('threads keep_alive: "5m" into the /api/chat body for qwen3.5:9b (resident — reload tax removed)', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await analyzer.runStage1Chapter('m_ollama_keepalive_9b', 1, '# prompt', {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.keep_alive).toBe('5m');
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
