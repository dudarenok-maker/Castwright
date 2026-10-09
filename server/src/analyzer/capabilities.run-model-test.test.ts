import { describe, it, expect, vi } from 'vitest';
import {
  runModelTest,
  plannedTestRequestCount,
  probeOutputCap,
  largestStageSchema,
  MARKER_KEY,
  ALL_STRUCTURED_OUTPUT_MODES,
  ModelTestControlFailedError,
  ModelTestInconclusiveError,
  type ModelTestDeps,
} from './capabilities.js';
/* The shared size-limit table lives in the 3b leaf; the Test action imports it, never copies it. */
import { LIMIT_400_PATTERNS, namesContextOrTokenLimit } from './limit-400-patterns.js';
import { AnalysisAbortedError, AnalyzerHttpError, AnalyzerTransportError, type TransportKind } from './errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';

const ok = (text: string, over: Partial<TransportResult> = {}): TransportResult => ({
  text,
  reasoningSeen: false,
  finish: 'stop',
  receivedBytes: text.length,
  ...over,
});

function fakeTransport(
  respond: (req: TransportRequest, n: number) => TransportResult,
  opts: { kind?: TransportKind; prepare?: (signal?: AbortSignal) => Promise<void> } = {},
) {
  const calls: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind: opts.kind ?? 'openai',
    model: 'qwen3-30b',
    ...(opts.prepare ? { prepare: opts.prepare } : {}),
    send: vi.fn(async (req: TransportRequest) => {
      calls.push(req);
      return respond(req, calls.length);
    }),
  };
  return { transport, calls };
}

function deps(transport: ChatTransport, over: Partial<ModelTestDeps> = {}): ModelTestDeps {
  return {
    transport,
    serverUrl: 'http://127.0.0.1:8080/v1',
    configuredMode: 'schema',
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
    probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: null }),
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    markerValue: () => 'mk-fixed',
    ...over,
  };
}

const markerOf = (req: TransportRequest): string | undefined =>
  req.structuredOutput.mode === 'schema'
    ? (req.structuredOutput.schema.properties as Record<string, { enum?: string[] }>)[MARKER_KEY]?.enum?.[0]
    : undefined;

/** A model that follows whatever response format it is given. */
const obedient = (req: TransportRequest): TransportResult =>
  ok(req.structuredOutput.mode === 'schema' ? `{"${MARKER_KEY}":"${markerOf(req)}"}` : '{"ok":true}');

const http400 = (body: string) => new AnalyzerHttpError('openai', 400, body, 'HTTP 400');

describe('runModelTest — the P7 ladder (#3084)', () => {
  it('sends the control (off) then the configured mode, with the same prompt and the same cap on every step', async () => {
    const { transport, calls } = fakeTransport(obedient);
    const record = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(transport));
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'schema']);
    expect(calls[1].system).toBe(calls[0].system);
    expect(calls[1].messages).toEqual(calls[0].messages);
    expect(calls[1].maxOutputTokens).toBe(calls[0].maxOutputTokens);
    expect(calls[0].maxOutputTokens).toBe(probeOutputCap({ contextTokens: 32768, maxOutputTokens: null }, calls[1].estimatedInputTokens));
    expect(calls[0].maxOutputTokens! + calls[1].estimatedInputTokens).toBeLessThanOrEqual(32768);
    expect(record).toEqual({
      serverUrl: 'http://127.0.0.1:8080/v1',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true },
      structuredOutput: { schema: { 'model-default': 'enforced' } },
      reasoning: {},
    });
  });

  it('A3 — stamps the digest modelDigest resolves; no dep, an undefined answer or a throw stamps nothing', async () => {
    const { transport } = fakeTransport(obedient, { kind: 'ollama' });
    const input = { modelId: 'qwen3.5:4b', scope: 'configured' as const };
    expect((await runModelTest(input, deps(transport, { modelDigest: async () => 'sha256:abc' }))).digest).toBe('sha256:abc');
    expect(await runModelTest(input, deps(transport))).not.toHaveProperty('digest');
    expect(await runModelTest(input, deps(transport, { modelDigest: async () => undefined }))).not.toHaveProperty('digest');
    expect(await runModelTest(input, deps(transport, { modelDigest: async () => { throw new Error('ECONNREFUSED'); } }))).not.toHaveProperty('digest');
  });

  it("the cap is the model's resolved Auto cap when that is smaller than the room left", async () => {
    const { transport, calls } = fakeTransport(obedient);
    await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: 2048 }) }));
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([2048, 2048]);
  });

  it('probeOutputCap clamps a cap to context minus input, and never goes below 1', () => {
    expect(probeOutputCap({ contextTokens: 4096, maxOutputTokens: 16384 }, 1000)).toBe(3096);
    expect(probeOutputCap({ contextTokens: 32768, maxOutputTokens: 2048 }, 1000)).toBe(2048);
    expect(probeOutputCap({ contextTokens: 32768, maxOutputTokens: null }, 1000)).toBe(31768);
    expect(probeOutputCap({ contextTokens: 4096, maxOutputTokens: null }, 5000)).toBe(1);
  });

  it('prepare() runs before the cap is read, so served limits warmed at start size every step (P15)', async () => {
    let limits: { contextTokens: number; maxOutputTokens: number | null } = { contextTokens: 32768, maxOutputTokens: null };
    const { transport, calls } = fakeTransport(obedient, {
      prepare: async () => {
        limits = { contextTokens: 32768, maxOutputTokens: 1024 };
      },
    });
    await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { probeLimits: () => limits }));
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([1024, 1024]);
  });

  it('files the record under the level actually sent: off for Ollama (think:false), model-default for Gemini and endpoints', async () => {
    for (const [kind, level] of [['ollama', 'off'], ['gemini', 'model-default'], ['openai', 'model-default']] as const) {
      const { transport } = fakeTransport(obedient, { kind });
      const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
      expect(record.structuredOutput).toEqual({ schema: { [level]: 'enforced' } });
    }
  });

  it('a control that stops with length still counts as accepted', async () => {
    const { transport } = fakeTransport((req, n) => (n === 1 ? ok('', { finish: 'length', reasoningSeen: true }) : obedient(req)));
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    expect(record).toMatchObject({ control: { ok: true }, structuredOutput: { schema: { 'model-default': 'enforced' } } });
  });

  it('a failing control throws ModelTestControlFailedError, sends no mode step and produces no record', async () => {
    const { transport, calls } = fakeTransport(() => {
      throw new AnalyzerHttpError('openai', 503, 'loading model', 'HTTP 503 loading model');
    });
    await expect(runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'all' }, deps(transport))).rejects.toBeInstanceOf(
      ModelTestControlFailedError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].structuredOutput).toEqual({ mode: 'off' });
  });

  it('control failure text passes through redact and is capped', async () => {
    const { transport } = fakeTransport(() => {
      throw new AnalyzerHttpError('openai', 401, 'bad key sk-secret-123', `HTTP 401 bad key sk-secret-123 ${'x'.repeat(900)}`);
    });
    const err = await runModelTest(
      { modelId: 'm', scope: 'configured' },
      deps(transport, { redact: (t) => t.replaceAll('sk-secret-123', '[redacted]') }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTestControlFailedError);
    const message = (err as Error).message;
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('sk-secret-123');
    expect(message.length).toBeLessThanOrEqual(700);
  });

  it('the control sends no structured output, so a server that rejects json mode still passes it (LM Studio)', async () => {
    const { transport, calls } = fakeTransport((req) => {
      if (req.structuredOutput.mode === 'json') throw http400("'response_format.type' must be 'json_schema' or 'text'");
      return ok('{"ok":true}');
    });
    const record = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(transport, { configuredMode: 'json' }));
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'json']);
    expect(record.structuredOutput).toEqual({ json: { 'model-default': 'rejected' } });
  });

  it('configured mode off sends only the control request and records it accepted', async () => {
    const { transport, calls } = fakeTransport(() => ok('{"ok":true}'));
    const d = deps(transport, { configuredMode: 'off' });
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, d);
    expect(calls).toHaveLength(1);
    expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, d));
    expect(record.structuredOutput).toEqual({ off: { 'model-default': 'accepted' } });
  });

  it('a 200 without the marker → ignored', async () => {
    const { transport } = fakeTransport(() => ok('{"characters":[]}'));
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { 'model-default': 'ignored' } });
  });

  it('a 400 on the schema step after a good control → rejected', async () => {
    const { transport } = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw http400('json_schema unsupported');
    });
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { 'model-default': 'rejected' } });
  });

  it('a Gemini ApiError-shaped status 400 also counts as rejected', async () => {
    const { transport } = fakeTransport(
      (_req, n) => {
        if (n === 1) return ok('{"ok":true}');
        throw Object.assign(new Error('INVALID_ARGUMENT: responseJsonSchema is not supported for this model'), { status: 400 });
      },
      { kind: 'gemini' },
    );
    const record = await runModelTest({ modelId: 'gemini-3.6-flash', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { 'model-default': 'rejected' } });
  });

  it.each(LIMIT_400_PATTERNS)('a 400 naming a size limit is inconclusive, not rejected ($provider)', async (row) => {
    for (const thrown of [http400(row.example), Object.assign(new Error(row.example), { status: 400 })]) {
      const { transport } = fakeTransport((_req, n) => {
        if (n === 1) return ok('{"ok":true}');
        throw thrown;
      });
      await expect(runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport))).rejects.toBeInstanceOf(ModelTestInconclusiveError);
    }
  });

  it('namesContextOrTokenLimit leaves a mode refusal alone', () => {
    for (const refusal of [
      "'response_format.type' must be 'json_schema' or 'text'",
      'json_schema unsupported',
      "Invalid schema for response_format 'castwright_probe': 'minLength' is not permitted.",
      'INVALID_ARGUMENT: responseJsonSchema is not supported for this model',
    ]) {
      expect(namesContextOrTokenLimit(refusal), refusal).toBe(false);
    }
  });

  it('a small-context endpoint whose oversized served cap would 400 does not record rejected', async () => {
    const CONTEXT = 16384;
    /* vLLM rejects input + max_tokens above the served context with this 400 (vllm#42474). */
    const { transport } = fakeTransport((req) => {
      const input = req.estimatedInputTokens;
      const output = req.maxOutputTokens ?? 0;
      if (input + output > CONTEXT) {
        throw http400(
          `This model's maximum context length is ${CONTEXT} tokens. However, you requested ${output} output tokens and your prompt contains at least ${input} input tokens, for a total of at least ${input + output} tokens.`,
        );
      }
      return obedient(req);
    });
    const record = await runModelTest(
      { modelId: 'openai:vllm::m', scope: 'configured' },
      deps(transport, { probeLimits: () => ({ contextTokens: CONTEXT, maxOutputTokens: 65536 }) }),
    );
    expect(record.structuredOutput).toEqual({ schema: { 'model-default': 'enforced' } });
  });

  it('a thinking-style model that reasons before answering records a verdict within the resolved cap', async () => {
    const REASONING_TOKENS = 6000;
    const { transport } = fakeTransport(
      (req) => {
        if ((req.maxOutputTokens ?? Infinity) < REASONING_TOKENS + 64) {
          return { text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0 };
        }
        return { ...obedient(req), reasoningSeen: true };
      },
      { kind: 'gemini' },
    );
    const record = await runModelTest(
      { modelId: 'gemini-3.6-flash', scope: 'configured' },
      deps(transport, { probeLimits: () => ({ contextTokens: 1_048_576, maxOutputTokens: 65_536 }) }),
    );
    expect(record.structuredOutput).toEqual({ schema: { 'model-default': 'enforced' } });
  });

  it('the schema step sends the largest stage schema plus a required marker the prompt never mentions', async () => {
    const { transport, calls } = fakeTransport(obedient);
    await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    const probe = calls[1];
    expect(probe.structuredOutput.mode).toBe('schema');
    const sent = probe.structuredOutput.mode === 'schema' ? probe.structuredOutput.schema : {};
    const largest = largestStageSchema().schema;
    expect(Object.keys(sent.properties as object)).toEqual([...Object.keys(largest.properties as object), MARKER_KEY]);
    expect(sent.required).toContain(MARKER_KEY);
    const promptText = probe.system + probe.messages.map((m) => m.content).join('');
    expect(promptText).not.toContain(MARKER_KEY);
    expect(promptText).not.toContain('mk-fixed');
  });

  it('configured mode json → a json step recorded accepted', async () => {
    const { transport, calls } = fakeTransport(() => ok('{"ok":true}'));
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { configuredMode: 'json' }));
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'json']);
    expect(record.structuredOutput).toEqual({ json: { 'model-default': 'accepted' } });
  });

  it("scope 'all' tests every mode, and the request count equals plannedTestRequestCount for both scopes", async () => {
    for (const scope of ['configured', 'all'] as const) {
      const { transport, calls } = fakeTransport(obedient);
      const d = deps(transport);
      const record = await runModelTest({ modelId: 'm', scope }, d);
      expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'm', scope }, d));
      if (scope === 'all') {
        expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'schema', 'json']);
        expect(record.structuredOutput).toEqual({
          schema: { 'model-default': 'enforced' },
          json: { 'model-default': 'accepted' },
          off: { 'model-default': 'accepted' },
        });
      }
    }
  });

  it('a length or blocked finish on a mode step is inconclusive, not ignored or accepted', async () => {
    for (const configuredMode of ['schema', 'json'] as const) {
      for (const finish of ['length', 'blocked'] as const) {
        const { transport } = fakeTransport((_req, n) =>
          n === 1 ? ok('{"ok":true}') : { text: '{"char', reasoningSeen: true, finish, receivedBytes: 6 },
        );
        await expect(runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { configuredMode }))).rejects.toBeInstanceOf(
          ModelTestInconclusiveError,
        );
      }
    }
  });

  it('a 5xx after a good control is inconclusive and produces no record', async () => {
    const { transport } = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw new AnalyzerHttpError('openai', 503, 'loading model', 'HTTP 503');
    });
    await expect(runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport))).rejects.toBeInstanceOf(ModelTestInconclusiveError);
  });

  it('an AnalyzerTransportError is a request failure, never an unreachable server: inconclusive on a mode step, a failed control on step 1, no retry (P22)', async () => {
    /* 3b's rule 7 shape, with a connect-phase causeCode: nothing here may read that code as "unreachable". */
    const transportError = () =>
      new AnalyzerTransportError(
        'openai',
        'qwen3-30b',
        'Endpoint qwen3-30b request failed before a response (ECONNREFUSED) (APIConnectionError <- TypeError).',
        'ECONNREFUSED',
      );

    const onStep = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw transportError();
    });
    const stepErr = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(onStep.transport)).catch((e: unknown) => e);
    expect(stepErr).toBeInstanceOf(ModelTestInconclusiveError);
    expect((stepErr as Error).message).toContain('Endpoint qwen3-30b request failed before a response (ECONNREFUSED) (APIConnectionError <- TypeError).');
    expect((stepErr as Error).message).not.toMatch(/unreachable|could not be reached/i);
    expect(onStep.calls).toHaveLength(2);

    const onControl = fakeTransport(() => {
      throw transportError();
    });
    const controlErr = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'all' }, deps(onControl.transport)).catch((e: unknown) => e);
    expect(controlErr).toBeInstanceOf(ModelTestControlFailedError);
    expect((controlErr as Error).message).toContain('Endpoint qwen3-30b request failed before a response (ECONNREFUSED) (APIConnectionError <- TypeError).');
    expect((controlErr as Error).message).not.toMatch(/unreachable|could not be reached/i);
    expect(onControl.calls).toHaveLength(1);
  });

  it('every request carries the abort signal the route passes', async () => {
    const controller = new AbortController();
    const { transport, calls } = fakeTransport(obedient);
    await runModelTest({ modelId: 'm', scope: 'all' }, deps(transport, { signal: controller.signal }));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
  });

  it('prepare() receives the route abort signal, so a client that leaves releases a stalled warm-up (P26)', async () => {
    const controller = new AbortController();
    const prepare = vi.fn(async (_signal?: AbortSignal) => {});
    const { transport } = fakeTransport(obedient, { prepare });
    await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { signal: controller.signal }));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(controller.signal);
  });

  it('a client abort stops the ladder: no further step is sent', async () => {
    const controller = new AbortController();
    const { transport, calls } = fakeTransport((req) => {
      controller.abort();
      return obedient(req);
    });
    await expect(runModelTest({ modelId: 'm', scope: 'all' }, deps(transport, { signal: controller.signal }))).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(calls).toHaveLength(1);
  });
});
