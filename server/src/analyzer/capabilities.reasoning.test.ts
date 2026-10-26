import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import {
  assertConfiguredCapabilitiesAllowed,
  capabilityRecordFor,
  capabilityRecordKey,
  isProbeRejected,
  ModelTestInconclusiveError,
  plannedReasoningProbeCount,
  probeReasoningLevels,
  ReasoningLevelTestInconclusiveError,
  reasoningLevelsToProbe,
  verdictTestedAtFor,
  type ModelCapabilityRecord,
} from './capabilities.js';
import { AnalysisAbortedError, AnalyzerHttpError, AnalyzerReasoningOverflowError, GeminiContentBlockedError } from './errors.js';
import type { TransportResult } from './runner/transport.js';
import type { ReasoningLevel } from './reasoning.js';

const rec = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true },
  structuredOutput: {}, reasoning: {}, ...over,
});
const http400 = () => new AnalyzerHttpError('ollama', 400, '"q:4b" does not support thinking', 'Ollama returned 400');
const stop = (): TransportResult => ({ text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 });
const lengthStop = (): TransportResult => ({ text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0, usage: { reasoningTokens: 900 } });

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

describe('levels to probe and counts', () => {
  it('configured probes one level; all probes every testable level; the plan counts the level step', () => {
    expect(reasoningLevelsToProbe('configured', { engine: 'local', model: 'q:4b' }, 'on')).toEqual(['on']);
    expect(reasoningLevelsToProbe('all', { engine: 'local', model: 'q:4b' }, 'off')).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(plannedReasoningProbeCount(['model-default', 'off', 'on', 'low', 'medium', 'high'], 'off')).toBe(5);
    expect(plannedReasoningProbeCount(['model-default'], 'model-default')).toBe(0);
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
