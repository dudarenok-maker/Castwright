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
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator',
      evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] },
    { id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
      evidence: [{ quote: 'dd' }, { quote: 'eee' }, { quote: 'ffff' }] },
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
        const line = JSON.stringify({ message: { role: 'assistant', content: chunks[i] }, done: false });
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
    const result = await analyzer.runStage1Chapter('m_ollama_ok', 1, '# stage1 prompt', { onChunk });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('qwen3.5:9b');
    expect(body.stream).toBe(true);
    expect(body.format).toBe('json');
    expect(body.keep_alive).toBe('5m');
    expect(body.options.num_ctx).toBe(8192);
    /* System + user turn shape. */
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');

    /* Buffer reassembled, monotonic, terminal value matches input. */
    expect(onChunk).toHaveBeenCalledTimes(pieces.length);
    const lengths = onChunk.mock.calls.map(args => args[0].receivedBytes);
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    expect(lengths[lengths.length - 1]).toBe(VALID_RESPONSE.length);

    /* Parsed payload comes through. */
    expect(result.characters).toHaveLength(2);
    expect(result.characters.map(c => c.id)).toEqual(['narrator', 'sophie']);
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

    await expect(analyzer.runStage1Chapter('m_ollama_down', 1, '# prompt', {}))
      .rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('throws LocalUnreachableError on bare TypeError: fetch failed with no cause code', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(analyzer.runStage1Chapter('m_ollama_bare_fetchfail', 1, '# prompt', {}))
      .rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('throws LocalUnreachableError on AbortError before first byte', async () => {
    const ab = new Error('aborted');
    ab.name = 'AbortError';
    fetchMock.mockRejectedValue(ab);
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(analyzer.runStage1Chapter('m_ollama_abort', 1, '# prompt', {}))
      .rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('does NOT classify a 404 "model not found" response as unreachable — it hard-fails as a plain Error', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: 'model "qwen3.5:9b" not found, try pulling it first' }),
      { status: 404, statusText: 'Not Found' },
    ));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    /* This is the load-bearing assertion: a *reachable* daemon returning a
       hard error must NOT trigger Gemini fallback. The decorator above
       this layer only acts on LocalUnreachableError. */
    await expect(analyzer.runStage1Chapter('m_ollama_404', 1, '# prompt', {}))
      .rejects.not.toBeInstanceOf(LocalUnreachableError);
    await expect(analyzer.runStage1Chapter('m_ollama_404_again', 1, '# prompt', {}))
      .rejects.toThrow(/404/);
  });

  it('throws plain Error (not LocalUnreachableError) when the daemon returns 500', async () => {
    fetchMock.mockResolvedValue(new Response('upstream blew up', { status: 500, statusText: 'Internal Server Error' }));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await expect(analyzer.runStage1Chapter('m_ollama_500', 1, '# prompt', {}))
      .rejects.not.toBeInstanceOf(LocalUnreachableError);
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
    const invalid = JSON.stringify({ characters: [] /* missing required field on shape — empty arr is fine actually */ });
    /* Use a stronger violation: extra field that .strict() forbids. */
    const strictlyInvalid = JSON.stringify({ characters: [], stowaways: ['nope'] });

    /* First call → strictlyInvalid, second call → valid. */
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(strictlyInvalid, 32))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const result = await analyzer.runStage1Chapter('m_ollama_retry', 1, '# prompt', {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.characters).toHaveLength(2);

    /* The retry message includes the prior assistant turn so the model sees
       its own bad output. Inspect the second request body. */
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(secondBody.messages.find((m: { role: string }) => m.role === 'assistant')).toBeTruthy();
    expect(secondBody.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(2);

    /* Sanity-check we used the invalid arg in the first call. */
    void invalid;
  });

  it('hard-fails after the second attempt also fails validation', async () => {
    const bad = JSON.stringify({ characters: [], extraField: 'nope' });
    /* Fresh Response per call — a streamed body can only be consumed once,
       so a shared `mockResolvedValue(...)` would feed the second attempt
       an already-drained stream and trip the "empty response" branch. */
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(ndjsonStream(chunksOf(bad, 32)))));

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

afterAll(async () => {
  /* Tidy test inbox/outbox files. */
  for (const id of [
    'm_ollama_ok', 'm_ollama_down', 'm_ollama_bare_fetchfail', 'm_ollama_abort',
    'm_ollama_404', 'm_ollama_404_again', 'm_ollama_500', 'm_ollama_empty',
    'm_ollama_retry', 'm_ollama_retry_fail',
  ]) {
    await rm(resolve(HANDOFF_ROOT, 'inbox',  `${id}-stage1-ch1.md`),    { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.json`),   { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.errors.json`), { force: true });
  }
});
