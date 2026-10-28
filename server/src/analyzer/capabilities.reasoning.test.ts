import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import {
  ALL_STRUCTURED_OUTPUT_MODES,
  assertAnalyzerTargetUsable,
  assertConfiguredCapabilitiesAllowed,
  capabilityRecordFor,
  capabilityRecordKey,
  isProbeRejected,
  ModelTestInconclusiveError,
  plannedReasoningProbeCount,
  plannedTestRequestCount,
  probeReasoningLevels,
  ReasoningLevelTestInconclusiveError,
  reasoningLevelsToProbe,
  runModelTest,
  verdictTestedAtFor,
  type ModelCapabilityRecord,
  type ModelTestDeps,
} from './capabilities.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerReasoningOverflowError,
  AnalyzerReasoningUnavailableError,
  GeminiContentBlockedError,
} from './errors.js';
import { structuredOutputLabel } from './runner/schema-adapters.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';
import type { ReasoningLevel } from './reasoning.js';

const rec = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true },
  structuredOutput: {}, reasoning: {}, ...over,
});
const http400 = () => new AnalyzerHttpError('ollama', 400, '"q:4b" does not support thinking', 'Ollama returned 400');
const stop = (): TransportResult => ({ text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 });
const lengthStop = (): TransportResult => ({ text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0, usage: { reasoningTokens: 900 } });

function recording(respond: (req: TransportRequest) => TransportResult) {
  const calls: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind: 'ollama',
    model: 'q:4b',
    send: vi.fn(async (req: TransportRequest) => {
      calls.push(req);
      return respond(req);
    }),
  };
  return { calls, transport };
}

function ollamaDeps(transport: ChatTransport, over: Partial<ModelTestDeps> = {}): ModelTestDeps {
  return {
    transport,
    serverUrl: 'http://127.0.0.1:11434',
    configuredMode: 'off',
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
    probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: null }),
    reasoningSelection: () => ({ engine: 'local', model: 'q:4b' }),
    configuredReasoning: () => 'off',
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    markerValue: () => 'mk-fixed',
    ...over,
  };
}

describe('isProbeRejected', () => {
  it('is true only for a 400 from any transport', () => {
    expect(isProbeRejected(http400())).toBe(true);
    expect(isProbeRejected(Object.assign(new Error('INVALID_ARGUMENT'), { status: 400 }))).toBe(true);
    expect(isProbeRejected(new AnalyzerHttpError('openai', 500, '', 'boom'))).toBe(false);
    expect(isProbeRejected(new Error('fetch failed'))).toBe(false);
  });
});

describe('probeReasoningLevels — the level step (P7)', () => {
  it('records accepted / rejected and skips the control level', async () => {
    const send = vi.fn(async (level: ReasoningLevel): Promise<TransportResult> => {
      if (level === 'on' || level === 'low') throw http400();
      return stop();
    });
    const out = await probeReasoningLevels(['model-default', 'off', 'on', 'low', 'medium', 'high'], { modelId: 'q:4b', controlLevel: 'off', send });
    expect(out).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'accepted', high: 'accepted' });
    expect(send.mock.calls.map(([level]) => level)).toEqual(['model-default', 'on', 'low', 'medium', 'high']);
  });
  it('a thinking model that hits length on a level probe records the level accepted (acceptance only)', async () => {
    const send = vi.fn(async (level: ReasoningLevel): Promise<TransportResult> =>
      level === 'high' ? lengthStop() : { text: '', reasoningSeen: false, finish: 'blocked', blockReason: 'SAFETY', receivedBytes: 0 },
    );
    await expect(probeReasoningLevels(['high', 'low'], { modelId: 'qwen3.5:4b', controlLevel: 'off', send })).resolves.toEqual({
      high: 'accepted',
      low: 'accepted',
    });
  });
  it('a 400 naming a context or token limit is inconclusive, with copy that names the level', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalyzerHttpError(
        'openai',
        400,
        "This model's maximum context length is 8192 tokens",
        "Endpoint m returned 400: This model's maximum context length is 8192 tokens",
      );
    });
    const err = await probeReasoningLevels(['high'], { modelId: 'openai:lab::m', controlLevel: 'model-default', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
    expect(err).toBeInstanceOf(ModelTestInconclusiveError);
    expect((err as Error).message).toContain('The reasoning level "high" check for openai:lab::m was inconclusive');
    expect((err as Error).message).not.toContain('The off check');
  });
  it('a non-400 failure is inconclusive with the level named, never recorded', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalyzerHttpError('ollama', 500, '', 'boom');
    });
    const err = await probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
    expect((err as Error).message).toContain('The reasoning level "on" check for q:4b was inconclusive (boom)');
  });
  it('rethrows an abort', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalysisAbortedError('gone');
    });
    await expect(probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send })).rejects.toBeInstanceOf(AnalysisAbortedError);
  });
  it('a content block and a reasoning overflow from a probe are handled alike: inconclusive, nothing recorded (P20)', async () => {
    const thrown = [
      new GeminiContentBlockedError('gemini-3.6-flash', 'SAFETY'),
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 900),
    ];
    for (const failure of thrown) {
      const send = vi.fn(async (): Promise<TransportResult> => {
        throw failure;
      });
      const err = await probeReasoningLevels(['low'], { modelId: 'gemini-3.6-flash', controlLevel: 'model-default', send }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
      expect((err as Error).message).toContain('The reasoning level "low" check for gemini-3.6-flash was inconclusive');
    }
  });
});

describe("runModelTest — the level step at W3c's step-2 hook", () => {
  it('the level step is the control request with only reasoning changed; mode steps run at the configured level', async () => {
    const { calls, transport } = recording(() => stop());
    const deps = ollamaDeps(transport, { configuredMode: 'json', configuredReasoning: () => 'on' });
    const record = await runModelTest({ modelId: 'q:4b', scope: 'configured' }, deps);
    expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'q:4b', scope: 'configured' }, deps));
    expect(calls.map((c) => [c.structuredOutput.mode, c.reasoning])).toEqual([
      ['off', 'off'],
      ['off', 'on'],
      ['json', 'on'],
    ]);
    const { reasoning: _controlLevel, ...control } = calls[0];
    const { reasoning: _probeLevel, ...probe } = calls[1];
    expect(probe).toEqual(control);
    expect(record.reasoning).toEqual({ on: 'accepted' });
    expect(record.structuredOutput).toEqual({ json: { on: 'accepted' } });
  });

  it('scope all on a thinking model: every level probe that stops with length is recorded accepted', async () => {
    const { transport } = recording((req) => (req.reasoning === 'off' ? stop() : lengthStop()));
    const record = await runModelTest({ modelId: 'q:4b', scope: 'all' }, ollamaDeps(transport, { offeredModes: ['off'] }));
    expect(record.control).toEqual({ ok: true });
    expect(record.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'accepted', low: 'accepted', medium: 'accepted', high: 'accepted' });
  });

  it('a rejected configured level skips the mode steps: nothing could be attributed', async () => {
    const { calls, transport } = recording((req) => {
      if (req.reasoning === 'on') throw http400();
      return stop();
    });
    const record = await runModelTest({ modelId: 'q:4b', scope: 'configured' }, ollamaDeps(transport, { configuredMode: 'json', configuredReasoning: () => 'on' }));
    expect(record.reasoning).toEqual({ on: 'rejected' });
    expect(record.structuredOutput).toEqual({});
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'off']);
  });
});

describe('levels to probe and counts', () => {
  it('configured probes one level; all probes every testable level; the plan counts the level step', () => {
    expect(reasoningLevelsToProbe('configured', { engine: 'local', model: 'q:4b' }, 'on')).toEqual(['on']);
    expect(reasoningLevelsToProbe('all', { engine: 'local', model: 'q:4b' }, 'off')).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(plannedReasoningProbeCount(['model-default', 'off', 'on', 'low', 'medium', 'high'], 'off')).toBe(5);
    expect(plannedReasoningProbeCount(['model-default'], 'model-default')).toBe(0);
    const planDeps = {
      configuredMode: 'schema' as const,
      offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
      reasoningSelection: () => ({ engine: 'local' as const, model: 'q:4b' }),
      configuredReasoning: () => 'off' as const,
    };
    expect(plannedTestRequestCount({ modelId: 'q:4b', scope: 'configured' }, planDeps)).toBe(2);
    expect(plannedTestRequestCount({ modelId: 'q:4b', scope: 'all' }, planDeps)).toBe(8);
  });
});

describe('one Ollama model id for Test records (N7)', () => {
  it('a record saved under either tag form answers for the other; an endpoint id is looked up exactly', () => {
    const s = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'qwen3:latest': rec(), 'openai:lab::m': rec() } } as UserSettings;
    expect(capabilityRecordFor(s, 'qwen3', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'qwen3:latest', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'openai:lab::m:latest', 'http://127.0.0.1:11434')).toBeUndefined();
    expect(capabilityRecordKey('qwen3:latest')).toBe('qwen3');
    expect(capabilityRecordKey('qwen3.5:4b')).toBe('qwen3.5:4b');
    expect(capabilityRecordKey('openai:lab::qwen3:latest')).toBe('openai:lab::qwen3:latest');
  });
});

describe("a refusal cites the verdict's own Test date (A2)", () => {
  it('reads verdictTestedAt for the rejected verdict, and the record date when it has none', () => {
    const dated = rec({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { on: 'rejected' },
      verdictTestedAt: { reasoning: { on: '2026-09-10T08:00:00.000Z' } },
    });
    expect(verdictTestedAtFor(dated, { setting: 'reasoning', reasoning: 'on' })).toBe('2026-09-10T08:00:00.000Z');
    let thrown: unknown;
    try {
      assertConfiguredCapabilitiesAllowed(dated, { structuredOutput: 'off', reasoning: 'on' }, 'q:4b');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { testedAt: string }).testedAt).toBe('2026-09-10T08:00:00.000Z');
    /* A record written before per-verdict dates existed: its own testedAt stands in. */
    expect(verdictTestedAtFor(rec({ testedAt: '2026-09-12T09:00:00.000Z', reasoning: { on: 'rejected' } }), { setting: 'reasoning', reasoning: 'on' })).toBe(
      '2026-09-12T09:00:00.000Z',
    );
  });
});

describe('label reflects the configured level', () => {
  it('schema (not enforced) only for the level the probe ran at', () => {
    const r = rec({ structuredOutput: { schema: { on: 'ignored', off: 'enforced' } } });
    expect(structuredOutputLabel('schema', [], r, 'on')).toBe('schema (not enforced)');
    expect(structuredOutputLabel('schema', [], r, 'off')).toBe('schema');
    expect(structuredOutputLabel('schema', [], r, 'low')).toBe('schema');
  });
});

describe('assertAnalyzerTargetUsable marks when a stale reasoning level is refused (P17, N10)', () => {
  const stale = { ...DEFAULT_USER_SETTINGS, analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } } as UserSettings;
  const target = { modelId: 'gemini-3.8-flash', source: 'settings' as const, engine: 'gemini' as const };
  const thrown = (fn: () => void): unknown => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("a fallback target's first call refuses mid-run; the pre-run check refuses before the start", () => {
    const midRun = thrown(() => assertAnalyzerTargetUsable(target, stale, undefined, 'mid-run'));
    expect(midRun).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(midRun).toMatchObject({ when: 'mid-run' });
    expect(thrown(() => assertAnalyzerTargetUsable(target, stale))).toMatchObject({ when: 'before-start' });
  });
});
